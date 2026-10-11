export type TransferKind = 'posts' | 'discord';
export interface DeviceHints {
  hardwareConcurrency?: number;
  deviceMemory?: number;
  connection?: { saveData?: boolean; effectiveType?: string };
}
export interface TransferPolicy {
  limit: number;
  successes: number;
  failures: number;
  increaseAfter: number;
}
interface TransferOwner { transferPolicy?: TransferPolicy }

function deviceHints(): DeviceHints {
  return typeof navigator === 'undefined' ? {} : navigator as DeviceHints;
}
function positive(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

// Browser reports are approximate hints, not a promise of free CPU or RAM.
export function transferCeiling(kind: TransferKind, hints: DeviceHints = deviceHints()): number {
  const cpu = positive(hints.hardwareConcurrency) ? Math.max(1, Math.floor(hints.hardwareConcurrency / 2)) : 2;
  const memory = positive(hints.deviceMemory) ? Math.max(1, Math.floor(hints.deviceMemory)) : 2;
  const connection = hints.connection;
  const network = connection?.saveData || ['slow-2g', '2g'].includes(connection?.effectiveType || '') ? 1 : connection?.effectiveType === '3g' ? 2 : 8;
  // Discord images can hold several copies of up to 40 MiB plus decoded pixels.
  return Math.min(kind === 'posts' ? 8 : 4, cpu, memory, network);
}

export function transferLimit(owner: TransferOwner, kind: TransferKind, hints?: DeviceHints): number {
  const ceiling = transferCeiling(kind, hints);
  const policy = owner.transferPolicy ||= { limit: Math.min(2, ceiling), successes: 0, failures: 0, increaseAfter: 0 };
  if (policy.limit > ceiling) { policy.limit = ceiling; policy.successes = 0; }
  return policy.limit;
}

export function transferSucceeded(owner: TransferOwner, kind: TransferKind): void {
  const ceiling = transferCeiling(kind);
  transferLimit(owner, kind);
  const policy = owner.transferPolicy!;
  // Completions during a cooldown must not immediately undo the reduction.
  if (Date.now() < policy.increaseAfter) return;
  if (++policy.successes >= policy.limit * 2) {
    policy.limit = Math.min(ceiling, policy.limit + 1);
    policy.successes = 0; policy.failures = 0;
  }
}

export function transferFailed(owner: TransferOwner, kind: TransferKind, status = 0, retryAfterMs = 0): void {
  if (status !== 0 && status !== 429 && status < 500) return;
  transferLimit(owner, kind);
  const policy = owner.transferPolicy!;
  policy.successes = 0;
  if (status !== 429 && ++policy.failures < 2) return;
  policy.limit = Math.max(1, Math.floor(policy.limit / 2));
  policy.failures = 0;
  policy.increaseAfter = Math.max(policy.increaseAfter, Date.now() + Math.max(30_000, retryAfterMs));
}
