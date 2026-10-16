import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ stageStream: vi.fn(), stageImage: vi.fn(), stagedFile: vi.fn() }));
vi.mock('../src/storage/zipCache', () => mocks);
import { transferPost } from '../src/services/posts/transfer';
import { TRANSFER_IDLE_MS, VALIDATION_TIMEOUT_MS } from '../src/services/posts/transferWatchdog';
import type { ArchivedPost, PostScope, PostTask, PostTransferProgress } from '../src/services/posts/types';

const source: PostScope = { origin: 'https://pawchive.pw', platform: 'fanbox', creatorId: '19544233', postId: null };
const post: ArchivedPost = { id: '11597323', title: 'Large attachment', content: '', published: null, media: [], hasFull: true, embed: null };
const task: PostTask = { id: 'large-file', postId: post.id, kind: 'file', quality: 'full res', url: 'https://file.pawchive.pw/data/aa/bb/' + 'a'.repeat(64) + '.psd',
  path: 'full res/11597323_Large attachment/file.psd', status: 'transferring', bytes: null, attempts: 1, nextAt: 0, error: null };
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers();
  // Make the former native overall deadline advance with the simulated clock too.
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('Timeout', 'TimeoutError')), ms);
    return controller.signal;
  });
  mocks.stageStream.mockImplementation(async (_job, _id, input: ReadableStream<Uint8Array>, signal: AbortSignal) => {
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    await input.pipeTo(new WritableStream<Uint8Array>({ write(chunk) { chunks.push(new Uint8Array(chunk)); } }), { signal });
    return new File(chunks, 'attachment');
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

it('finishes an actively streaming file after more than five minutes without restarting it', async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const input = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } });
  const fetch = vi.fn().mockResolvedValue(new Response(input, { headers: { 'Content-Length': '6' } })); vi.stubGlobal('fetch', fetch);
  const progress: PostTransferProgress[] = [];
  const work = transferPost('job', task, post, source, undefined, value => progress.push(value));
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 6; i++) { await vi.advanceTimersByTimeAsync(60_000); stream.enqueue(new Uint8Array([i])); await vi.advanceTimersByTimeAsync(0); }
  stream.close();
  await expect(work).resolves.toMatchObject({ bytes: 6 }); expect(fetch).toHaveBeenCalledTimes(1);
  expect(progress.filter(item => item.phase === 'downloading').map(item => item.receivedBytes)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  expect(progress.at(-1)).toMatchObject({ phase: 'validating', receivedBytes: 6, totalBytes: 6 });
  expect(vi.getTimerCount()).toBe(0);
});

it('cancels a truly stalled stream after its idle deadline and releases its timer', async () => {
  const cancel = vi.fn(); const input = new ReadableStream<Uint8Array>({ cancel });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(input)));
  const work = transferPost('job', task, post, source).catch(error => error);
  await vi.advanceTimersByTimeAsync(TRANSFER_IDLE_MS);
  expect((await work).message).toContain('No attachment data received for 90 seconds');
  expect(cancel).toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});

it('aborts connection setup promptly when paused', async () => {
  const controller = new AbortController();
  vi.stubGlobal('fetch', vi.fn().mockImplementation((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }))));
  const work = transferPost('job', task, post, source, controller.signal).catch(error => error);
  controller.abort(new Error('Paused'));
  expect((await work).message).toBe('Paused'); expect(vi.getTimerCount()).toBe(0);
});

it('bounds image validation and closes a bitmap that arrives after cancellation', async () => {
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(png, { headers: { 'Content-Type': 'image/png' } })));
  let resolve!: (value: { width: number; height: number; close: () => void }) => void;
  const decode = vi.fn().mockImplementation(() => new Promise(done => { resolve = done; })); vi.stubGlobal('createImageBitmap', decode);
  const work = transferPost('job', { ...task, kind: 'image' }, post, source).catch(error => error);
  await vi.advanceTimersByTimeAsync(0); expect(decode).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(VALIDATION_TIMEOUT_MS);
  expect((await work).message).toContain('validation timed out');
  const close = vi.fn(); resolve({ width: 10, height: 10, close }); await vi.advanceTimersByTimeAsync(0);
  expect(close).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
});

it('does not mistake encoded content length for the decoded transfer size', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('decoded bytes', { headers: { 'Content-Length': '3', 'Content-Encoding': 'gzip' } })));
  const progress = vi.fn();
  await expect(transferPost('job', task, post, source, undefined, progress)).resolves.toMatchObject({ bytes: 13 });
  expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ receivedBytes: 13, totalBytes: null }));
});

it.each(['heic', 'heif', 'tif', 'tiff', 'bmp', 'svg', 'jxl'])('preserves advertised %s originals served as generic binary without requiring browser image decoding', async ext => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } })));
  const decode = vi.fn(); vi.stubGlobal('createImageBitmap', decode);
  await expect(transferPost('job', { ...task, kind: 'image', path: task.path.replace('.psd', '.' + ext) }, post, source)).resolves.toMatchObject({ bytes: bytes.length });
  expect(decode).not.toHaveBeenCalled();
});

it.each([['json', 'application/json', '{"attachment":true}'], ['xhtml', 'application/xhtml+xml', '<html>attachment</html>']])('accepts an advertised %s attachment even when its stored URL has no matching extension', async (ext, mime, body) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { headers: { 'Content-Type': mime } })));
  await expect(transferPost('job', { ...task, path: task.path.replace('.psd', '.' + ext) }, post, source)).resolves.toMatchObject({ bytes: new Blob([body]).size });
});

it('still rejects server error pages in place of uncommon image originals', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>error</html>', { headers: { 'Content-Type': 'application/octet-stream' } })));
  await expect(transferPost('job', { ...task, kind: 'image', path: task.path.replace('.psd', '.heic') }, post, source)).rejects.toThrow('error page');
});
