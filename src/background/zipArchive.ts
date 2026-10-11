import type { Job, MediaRecord } from '../core/types';
import { safeSegment } from '../core/filenameBuilder';
import { getMedia, saveJob, saveJobAndMedia } from '../storage/database';
import { offscreen, release } from './offscreenBridge';
import { cleanupSuccessfulZip } from '../services/cacheMaintenance';

export function newArchive(job: Job): NonNullable<Job['archive']> {
  return { state: 'pending', filename: `kemono-discord_${job.serverId}_${safeSegment(job.serverName, 'server')}_${job.id.slice(0, 8)}.zip`, blobUrl: null, downloadId: null, bytes: 0, entries: 0, progress: 0, total: 0, error: null };
}
export async function saveZip(job: Job): Promise<void> {
  const archive = job.archive;
  if (archive?.cacheCleared) throw new Error('Temporary ZIP data was cleared. Download again to prepare a new ZIP.');
  if (!archive || !['ready', 'saved', 'saving'].includes(archive.state)) throw new Error('The ZIP is still being prepared');
  if (archive.state === 'saving') return;
  await release(archive.blobUrl);
  const opened = await offscreen<{ blobUrl: string; bytes: number }>('zip-open', { jobId: job.id });
  archive.blobUrl = opened.blobUrl; archive.bytes = opened.bytes; archive.downloadId = null; archive.state = 'saving'; archive.error = null;
  job.manifestState = 'saving'; await saveJob(job); // Persist intent before the single browser download.
  try {
    archive.downloadId = await chrome.downloads.download({ url: opened.blobUrl, filename: archive.filename, conflictAction: 'uniquify', saveAs: true });
  } catch {
    archive.state = 'ready'; archive.error = 'ZIP saving was cancelled or blocked. Click Save ZIP to try again; images remain cached.';
    job.manifestState = 'pending'; await release(archive.blobUrl); archive.blobUrl = null;
  }
  await saveJob(job);
}
export async function prepareZip(job: Job, records: MediaRecord[]): Promise<void> {
  job.archive ||= newArchive(job);
  const archive = job.archive;
  if (archive.state === 'pending') {
    archive.state = 'building'; archive.error = null; job.manifestState = 'pending'; await saveJob(job);
    await offscreen('zip-build-start', { job, records }); return;
  }
  if (archive.state !== 'building') return;
  const status = await offscreen<{ state: 'building' | 'ready' | 'failed'; progress: number; total: number; bytes: number; entries: number; error: string | null } | null>('zip-build-status', { jobId: job.id });
  if (!status) { archive.state = 'pending'; await saveJob(job); return; }
  Object.assign(archive, status);
  if (status.state === 'ready') {
    job.status = 'finished'; await saveJob(job); await saveZip(job);
  } else if (status.state === 'failed') { job.status = 'finished'; job.manifestState = 'failed'; await saveJob(job); }
  else await saveJob(job);
}
export async function reconcileZip(job: Job, recovering = false): Promise<void> {
  const archive = job.archive; if (!archive || archive.state !== 'saving') return;
  let item: chrome.downloads.DownloadItem | undefined;
  if (archive.downloadId !== null) [item] = await chrome.downloads.search({ id: archive.downloadId });
  else if (archive.blobUrl) {
    const items = await chrome.downloads.search({ query: [archive.filename], limit: 20, orderBy: ['-startTime'] });
    item = items.find(item => item.url === archive.blobUrl); if (item) archive.downloadId = item.id;
  }
  if (item?.state === 'complete' && item.exists !== false) {
    archive.state = 'saved'; archive.error = null; job.manifestState = 'saved';
    await release(archive.blobUrl); archive.blobUrl = null;
    const records = await getMedia(job.id, ['staged']);
    for (const record of records) record.status = 'downloaded';
    await saveJobAndMedia(job, records);
    await cleanupSuccessfulZip(job);
  } else if (item?.state === 'interrupted' || item?.exists === false || (!item && recovering)) {
    archive.state = 'ready'; archive.error = 'ZIP download was interrupted. Click Save ZIP to retry without fetching images again.';
    job.manifestState = 'pending'; await release(archive.blobUrl); archive.blobUrl = null; archive.downloadId = null; await saveJob(job);
  }
}
