export const TRANSFER_IDLE_MS = 90_000;
export const VALIDATION_TIMEOUT_MS = 120_000;

// Healthy large files can run indefinitely; only a lack of progress expires.
export function transferWatchdog(abort?: AbortSignal) {
  const timeout = new AbortController(), signal = AbortSignal.any([timeout.signal, ...(abort ? [abort] : [])]);
  let timer: ReturnType<typeof setTimeout>;
  const clear = () => clearTimeout(timer);
  const reset = (validating = false) => {
    clear();
    if (!signal.aborted) timer = setTimeout(() => timeout.abort(new Error(validating ?
      'Attachment validation timed out.' : 'No attachment data received for 90 seconds; retrying.')), validating ? VALIDATION_TIMEOUT_MS : TRANSFER_IDLE_MS);
  };
  signal.addEventListener('abort', clear, { once: true }); reset();
  return { signal, reset, dispose: () => { clear(); signal.removeEventListener('abort', clear); } };
}

export function abortable<T>(work: Promise<T>, signal: AbortSignal, disposeLate?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    if (signal.aborted) aborted(); else signal.addEventListener('abort', aborted, { once: true });
    work.then(value => {
      signal.removeEventListener('abort', aborted);
      if (signal.aborted) disposeLate?.(value); else resolve(value);
    }, error => { signal.removeEventListener('abort', aborted); reject(error); });
  });
}
