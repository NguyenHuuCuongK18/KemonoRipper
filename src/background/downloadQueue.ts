import type { Job, MediaRecord } from '../core/types';
import { candidates } from '../core/mediaResolver';
import { ARCHIVE_ORIGINS, THUMBNAIL_HOSTS } from '../core/urlParser';
import { buildFilename } from '../core/filenameBuilder';
import { saveMedia } from '../storage/database';
import { offscreen, release } from './offscreenBridge';
import { directoryKey, FolderPermissionError } from '../storage/destination';
import { fileMatches } from '../storage/folderWriter';
import { ZipStorageError } from '../storage/zipCache';
import { transferFailed, transferSucceeded } from '../core/transferConcurrency';
export const MAX_ATTEMPTS = 3;
export function retryDelay(attempt: number, retryAfterMs = 0): number { return Math.max(2000 * 2 ** Math.max(0, attempt - 1), retryAfterMs); }
interface ImageResult { blobUrl: string; ext: string; mime: string; bytes: number; sha256: string; width: number; height: number; failure?: string; status?: number; retryAfterMs?: number }
export async function startImage(record: MediaRecord, job: Job): Promise<number> {
  const options = candidates(record, job);
  if (!options.length) {
    record.status = 'skipped'; record.errorMessage = job.mode === 'original' ? 'No original URL was exposed by the archive. No URL was invented.' : 'No observed or supported thumbnail URL is available.';
    await saveMedia(record); return 0;
  }
  record.status = 'transferring'; record.attempts++; await saveMedia(record);
  let nextDelay = 0; let retryable = false; let rateLimited = false;
  for (const candidate of options) {
    if (record.candidateFailures.some(f => f.url === candidate.url && /Image HTTP (400|401|403|404|410|422)\b/.test(f.reason))) continue;
    try {
      const hostname = new URL(candidate.url).hostname;
      if (!ARCHIVE_ORIGINS.includes(new URL(candidate.url).origin) && !THUMBNAIL_HOSTS.includes(hostname) && !(await chrome.permissions.contains({ origins: [`https://${hostname}/*`] }))) {
        record.candidateFailures.push({ url: candidate.url, reason: 'Optional permission for this original host was not granted' }); continue;
      }
      const image = await offscreen<ImageResult>('image', { url: candidate.url });
      if (image.failure) {
        record.candidateFailures.push({ url: candidate.url, reason: image.failure });
        if (image.status === 429) {
          nextDelay = retryDelay(record.attempts, image.retryAfterMs); retryable = true;
          rateLimited = true; transferFailed(job, 'discord', 429, nextDelay);
          break; // Do not move to another host or candidate to evade a rate limit.
        }
        if (!image.status || image.status >= 500) retryable = true;
        continue;
      }
      record.resolvedUrl = candidate.url; record.quality = candidate.quality;
      record.bytes = image.bytes; record.sha256 = image.sha256; record.mime = image.mime;
      record.width = image.width; record.height = image.height; record.blobUrl = image.blobUrl;
      record.savedPath = buildFilename(record, image.ext);
      // Persist intent before the browser API. Recovery also searches this filename if no ID was committed.
      await saveMedia(record);
      if (job.destination?.kind === 'zip') {
        await offscreen('stage-image', { jobId: job.id, recordId: record.id, url: image.blobUrl });
        record.status = 'staged'; record.downloadId = null;
        await release(record.blobUrl); record.blobUrl = null; record.errorMessage = null; await saveMedia(record); transferSucceeded(job, 'discord'); return 0;
      }
      if (job.destination?.kind === 'folder') {
        const saved = await offscreen<{ path: string }>('save-image', { jobId: directoryKey(job), path: record.savedPath, url: image.blobUrl });
        record.savedPath = saved.path; record.status = 'downloaded'; record.downloadId = null;
        await release(record.blobUrl); record.blobUrl = null;
        record.errorMessage = null; await saveMedia(record); transferSucceeded(job, 'discord'); return 0;
      }
      record.downloadId = await chrome.downloads.download({ url: image.blobUrl, filename: record.savedPath, conflictAction: 'uniquify', saveAs: false });
      record.errorMessage = null; await saveMedia(record); transferSucceeded(job, 'discord'); return 0;
    } catch (error) {
      if (error instanceof FolderPermissionError || error instanceof ZipStorageError) {
        record.status = 'queued'; record.attempts--; record.errorMessage = error.message;
        await release(record.blobUrl); record.blobUrl = null; await saveMedia(record); throw error;
      }
      retryable = true;
      record.candidateFailures.push({ url: candidate.url, reason: 'Image fetch, decoding, or browser download failed' });
      await release(record.blobUrl); record.blobUrl = null; record.downloadId = null;
    }
  }
  record.errorMessage = record.candidateFailures.at(-1)?.reason || 'All allowed image candidates failed';
  if (retryable && !rateLimited) transferFailed(job, 'discord');
  if (retryable && record.attempts < MAX_ATTEMPTS) { record.status = 'queued'; record.nextAttemptAt = Date.now() + (nextDelay || retryDelay(record.attempts)); }
  else record.status = 'failed';
  await saveMedia(record); return nextDelay;
}
export async function reconcileImage(record: MediaRecord, recovering = false, job?: Job): Promise<void> {
  if (job?.destination?.kind === 'zip') {
    const { ids } = await offscreen<{ ids: string[] }>('zip-matches', { jobId: job.id, records: [record] });
    record.status = ids.includes(record.id) ? 'staged' : record.attempts < MAX_ATTEMPTS ? 'queued' : 'failed';
    record.errorMessage = record.status === 'staged' ? null : 'ZIP image collection was interrupted';
    await release(record.blobUrl); record.blobUrl = null; record.downloadId = null; await saveMedia(record); return;
  }
  if (job?.destination?.kind === 'folder') {
    if (record.savedPath && record.sha256 && record.bytes !== null && await fileMatches(directoryKey(job), record.savedPath, record.sha256, record.bytes)) {
      record.status = 'downloaded'; record.errorMessage = null;
    } else {
      record.status = record.attempts < MAX_ATTEMPTS ? 'queued' : 'failed';
      record.errorMessage = 'Folder write was interrupted before completion'; record.nextAttemptAt = Date.now() + retryDelay(record.attempts);
    }
    await release(record.blobUrl); record.blobUrl = null; record.downloadId = null; await saveMedia(record); return;
  }
  let item: chrome.downloads.DownloadItem | undefined;
  if (record.downloadId !== null) [item] = await chrome.downloads.search({ id: record.downloadId });
  else if (record.savedPath && record.blobUrl) {
    const items = await chrome.downloads.search({ query: [record.savedPath.split('/').at(-1)!], limit: 20, orderBy: ['-startTime'] });
    item = items.find(i => i.url === record.blobUrl);
    if (item) record.downloadId = item.id;
  }
  if (item?.state === 'complete') {
    if (item.exists === false) { record.status = 'failed'; record.errorMessage = 'The completed file was removed outside the extension'; }
    else { record.status = 'downloaded'; record.errorMessage = null; }
    // The browser may uniquify names. Store the actual relative path it used, without exporting the user's home directory.
    if (item.filename) { const normalized = item.filename.replaceAll('\\', '/'); const index = normalized.lastIndexOf('/ArchiveRoot/'); if (index >= 0) record.savedPath = normalized.slice(index + 1); }
    await release(record.blobUrl); record.blobUrl = null;
  } else if (item?.state === 'interrupted' || (!item && recovering)) {
    record.errorMessage = item?.error || 'Worker/browser interrupted an uncommitted transfer';
    record.status = record.attempts < MAX_ATTEMPTS ? 'queued' : 'failed'; record.nextAttemptAt = Date.now() + retryDelay(record.attempts);
    await release(record.blobUrl); record.blobUrl = null; record.downloadId = null;
  }
  await saveMedia(record);
}
