import { detectImage } from '../core/mediaResolver';
import { safeMediaUrl } from '../core/urlParser';
import { retryAfter } from '../api/kemonoClient';
import { writeFile } from '../storage/folderWriter';
import { FolderPermissionError } from '../storage/destination';
import type { Job, MediaRecord } from '../core/types';
import { archiveFile, buildZip, clearZipCache, clearAllZipCaches, removeStagedFile, stageImage, stagedMatches, pruneZipCaches, listZipCaches, ZipStorageError, type ZipCacheCleanup } from '../storage/zipCache';
import { buildPostZip } from '../services/posts/zip';
import { postTaskCached, transferPost } from '../services/posts/transfer';
import { checkFolder, folderSync, writePostFile, writePostIndex } from '../services/posts/folder';
import type { ArchivedPost, PostJob, PostScope, PostTask } from '../services/posts/types';
const urls = new Map<string, Blob>();
interface Build { state: 'building' | 'ready' | 'failed'; progress: number; total: number; bytes: number; entries: number; error: string | null; abort: AbortController; work?: Promise<void> }
const builds = new Map<string, Build>();
const transfers = new Map<string, { jobId: string; abort: AbortController; state: 'transferring' | 'done'; result?: Awaited<ReturnType<typeof transferPost>>; work?: Promise<void> }>();
async function process(message: { action: string; cleanup?: ZipCacheCleanup; url?: string; blobUrls?: string[]; text?: string; mime?: string; jobId?: string; recordId?: string; directoryId?: string; path?: string; overwrite?: boolean; job?: Job; records?: MediaRecord[]; postJob?: PostJob; task?: PostTask; post?: ArchivedPost; source?: PostScope }): Promise<unknown> {
  if (message.action === 'cache-list') return listZipCaches();
  if (message.action === 'cache-remove') {
    if ([...transfers.values()].some(transfer => transfer.jobId === message.jobId) || builds.get(message.jobId!)?.state === 'building') throw new Error('This cache is in use. Finish or cancel the job before clearing it.');
    await clearZipCache(message.jobId!); builds.delete(message.jobId!); return null;
  }
  if (message.action === 'zip-prune') {
    const protectedIds = new Set(message.cleanup!.protectedJobIds);
    for (const transfer of transfers.values()) protectedIds.add(transfer.jobId);
    for (const [id, build] of builds) if (build.state === 'building') protectedIds.add(id);
    const result = await pruneZipCaches({ ...message.cleanup!, protectedJobIds: [...protectedIds] });
    for (const id of result.removed) builds.delete(id);
    return result;
  }
  if (message.action === 'local-purge') {
    if (message.jobId !== undefined && !/^[a-zA-Z0-9_-]{1,80}$/.test(message.jobId)) throw new Error('Invalid job cache to remove.');
    const pending: Promise<void>[] = [];
    for (const [key, transfer] of transfers) if (message.jobId === undefined || transfer.jobId === message.jobId) {
      transfer.abort.abort(); if (transfer.work) pending.push(transfer.work); transfers.delete(key);
    }
    for (const [key, build] of builds) if (message.jobId === undefined || key === message.jobId) {
      build.abort.abort(); if (build.work) pending.push(build.work); builds.delete(key);
    }
    await Promise.all(pending);
    for (const url of message.jobId === undefined ? [...urls.keys()] : message.blobUrls || []) {
      if (urls.delete(url)) URL.revokeObjectURL(url);
    }
    if (message.jobId === undefined) await clearAllZipCaches(); else await clearZipCache(message.jobId);
    return null;
  }
  if (message.action === 'post-folder-read') return (await folderSync(message.directoryId!, message.postJob!)) || null;
  if (message.action === 'post-folder-check') return checkFolder(message.postJob!);
  if (message.action === 'post-folder-write') return writePostFile(message.postJob!, message.recordId!);
  if (message.action === 'post-folder-index') { await writePostIndex(message.postJob!); return null; }
  if (message.action === 'post-cache-remove') { await removeStagedFile(message.jobId!, message.recordId!); return null; }
  if (message.action === 'post-transfer-start') {
    const key = `${message.jobId}:${message.task!.id}`;
    if (transfers.has(key)) return null;
    const transfer: { jobId: string; abort: AbortController; state: 'transferring' | 'done'; result?: Awaited<ReturnType<typeof transferPost>>; work?: Promise<void> } = { jobId: message.jobId!, abort: new AbortController(), state: 'transferring' };
    transfers.set(key, transfer);
    transfer.work = transferPost(message.jobId!, message.task!, message.post!, message.source!, transfer.abort.signal)
      .then(result => { transfer.result = result; transfer.state = 'done'; })
      .catch(error => { transfer.result = { failure: error instanceof Error ? error.message : 'Attachment transfer failed.', status: 0 }; transfer.state = 'done'; });
    return null;
  }
  if (message.action === 'post-transfer-status') { const transfer = transfers.get(`${message.jobId}:${message.recordId}`); return transfer ? { state: transfer.state, ...transfer.result } : null; }
  if (message.action === 'post-transfer-forget') { transfers.delete(`${message.jobId}:${message.recordId}`); return null; }
  if (message.action === 'post-transfer-stop') {
    for (const [key, transfer] of transfers) if (transfer.jobId === message.jobId) { transfer.abort.abort(); await transfer.work; transfers.delete(key); }
    return null;
  }
  if (message.action === 'post-cached') return postTaskCached(message.jobId!, message.task!);
  if (message.action === 'release') { if (message.url && urls.delete(message.url)) URL.revokeObjectURL(message.url); return null; }
  if (message.action === 'stage-image') {
    const blob = urls.get(message.url || ''); if (!blob) throw new Error('Validated image is no longer available');
    await stageImage(message.jobId!, message.recordId!, blob); return null;
  }
  if (message.action === 'zip-matches') {
    const ids: string[] = [];
    for (const record of message.records || []) if (await stagedMatches(message.jobId!, record)) ids.push(record.id);
    return { ids };
  }
  if (message.action === 'zip-build-start' || message.action === 'post-zip-build-start') {
    const id = message.postJob?.id || message.job!.id;
    if (builds.get(id)?.state === 'building') return null;
    const build: Build = { state: 'building', progress: 0, total: 0, bytes: 0, entries: 0, error: null, abort: new AbortController() };
    builds.set(id, build);
    const progress = (progress: number, total: number) => { build.progress = progress; build.total = total; };
    build.work = (message.postJob ? buildPostZip(message.postJob, build.abort.signal, progress) : buildZip(message.job!, message.records!, build.abort.signal, progress))
      .then(result => { Object.assign(build, result, { state: 'ready' }); })
      .catch(() => { build.state = 'failed'; build.error = build.abort.signal.aborted ? 'ZIP preparation was paused or cancelled. Collected images are retained.' : 'ZIP packaging failed. Check available disk space and prepare the ZIP again; collected images are retained.'; });
    return null;
  }
  if (message.action === 'zip-build-status') {
    const build = builds.get(message.jobId!);
    return build ? { state: build.state, progress: build.progress, total: build.total, bytes: build.bytes, entries: build.entries, error: build.error } : null;
  }
  if (message.action === 'zip-stop' || message.action === 'zip-clear') {
    const build = builds.get(message.jobId!); build?.abort.abort(); await build?.work; builds.delete(message.jobId!);
    if (message.action === 'zip-clear') await clearZipCache(message.jobId!); return null;
  }
  if (message.action === 'zip-open') {
    const file = await archiveFile(message.jobId!); const blobUrl = URL.createObjectURL(file); urls.set(blobUrl, file);
    return { blobUrl, bytes: file.size };
  }
  if (message.action === 'save-image') {
    const blob = urls.get(message.url || ''); if (!blob) throw new Error('Validated image is no longer available');
    return { path: await writeFile(message.jobId!, message.path!, blob) };
  }
  if (message.action === 'save-text') return { path: await writeFile(message.jobId!, message.path!, new Blob([message.text || ''], { type: message.mime || 'application/json' }), message.overwrite) };
  if (message.action === 'export') {
    const blob = new Blob([message.text || ''], { type: message.mime || 'application/json' });
    const url = URL.createObjectURL(blob); urls.set(url, blob); return { blobUrl: url };
  }
  const url = safeMediaUrl(message.url);
  if (!url) throw new Error('Media URL is outside the host/path allowlist');
  const response = await fetch(url, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(20000) });
  if (!response.ok) return { failure: `Image HTTP ${response.status}`, status: response.status, retryAfterMs: retryAfter(response.headers.get('retry-after')) };
  const maxBytes = 40 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('Image exceeds the 40 MiB transfer limit');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty image body');
  const chunks: Uint8Array[] = []; let length = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    length += value.length;
    if (length > maxBytes) { await reader.cancel(); throw new Error('Image exceeds the 40 MiB transfer limit'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const format = detectImage(bytes);
  if (!format) throw new Error('Response is not a supported image (HTML and placeholder bodies are rejected)');
  const blob = new Blob([bytes], { type: format.mime });
  const bitmap = await createImageBitmap(blob);
  const width = bitmap.width, height = bitmap.height; bitmap.close();
  if (!width || !height) throw new Error('Image decoding returned invalid dimensions');
  const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
  const blobUrl = URL.createObjectURL(blob); urls.set(blobUrl, blob);
  return { blobUrl, bytes: length, sha256, width, height, ...format };
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message.target !== 'offscreen') return;
  process(message).then(data => respond({ ok: true, data }), error => respond({ ok: false, error: message.action === 'local-purge' ? 'Local cached files could not be cleared. Jobs were stopped; try clearing the data again.' : error instanceof FolderPermissionError || error instanceof ZipStorageError ? error.message : (message.action.startsWith('post-') || message.action.startsWith('cache-')) && error instanceof Error ? error.message : message.action.startsWith('zip-') ? 'ZIP cache is unavailable. Prepare the ZIP again to recover it.' : ['save-image', 'save-text'].includes(message.action) ? 'Could not write the archive file. Check folder access and free disk space.' : 'Image transfer or decoding failed. Check availability and permissions.' }));
  return true;
});
