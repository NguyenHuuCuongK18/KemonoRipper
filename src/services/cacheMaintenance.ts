import { commitPage, getCacheSettings, getJob, getJobSummaries, getMedia, getPostJob, saveCacheSettings, saveJob, savePostJob, type JobSummary } from '../storage/database';
import { offscreen, release } from '../background/offscreenBridge';
import type { Job } from '../core/types';
import type { PostJob } from './posts/types';
import type { ZipCacheInfo } from '../storage/zipCache';

const minute = 60 * 1000;
export type CacheSettingsCommand = { type: 'LOCAL_STATUS' } | { type: 'LOCAL_SETTINGS'; retentionMinutes?: number; clearAfterDownload?: boolean };
export type CacheCommand = { type: 'CACHE_LIST' } | { type: 'CACHE_REMOVE'; jobId: string };
export interface CacheItem extends ZipCacheInfo { title: string; service: 'discord' | 'posts' | 'orphan'; status: string; protected: boolean }
export interface CacheList { caches: CacheItem[]; bytes: number }
function protectedCache(job: Pick<JobSummary, 'status' | 'archiveState'>): boolean {
  return ['scanning', 'downloading', 'paused'].includes(job.status) || ['building', 'saving'].includes(job.archiveState || '');
}
export async function cacheSettings(message: CacheSettingsCommand) {
  const settings = await getCacheSettings();
  if (message.type === 'LOCAL_SETTINGS') {
    if (message.retentionMinutes !== undefined && (!Number.isInteger(message.retentionMinutes) || message.retentionMinutes < 0 || message.retentionMinutes > 10)) throw new Error('Choose 1–10 minutes, or turn automatic cleanup off.');
    if (message.clearAfterDownload !== undefined && typeof message.clearAfterDownload !== 'boolean') throw new Error('Choose whether to clear temporary data after a successful download.');
    if (message.retentionMinutes !== undefined) settings.retentionMinutes = message.retentionMinutes;
    if (message.clearAfterDownload !== undefined) settings.clearAfterDownload = message.clearAfterDownload;
    await saveCacheSettings(settings);
  }
  return settings;
}

export async function cacheList(): Promise<CacheList> {
  const [summaries, files] = await Promise.all([getJobSummaries(), offscreen<ZipCacheInfo[]>('cache-list')]);
  const jobs = new Map(summaries.map(job => [job.id, job]));
  const caches = files.map(file => {
    const job = jobs.get(file.id);
    return { ...file, title: job?.title || `Unused cache ${file.id.slice(0, 8)}`, service: job?.service || 'orphan', status: job?.status || 'unused', protected: !!job && protectedCache(job) } as CacheItem;
  });
  return { caches, bytes: caches.reduce((total, cache) => total + cache.bytes, 0) };
}

async function recordCacheRemoval(job: Job | PostJob, reason: string): Promise<void> {
  await release(job.archive?.blobUrl || null);
  if (job.archive?.state === 'saved') {
    // Keep completion counts and history after the private copy is gone.
    job.archive.cacheCleared = true; job.archive.cacheCleanupError = null; job.archive.blobUrl = null;
    if (job.service === 'posts') await savePostJob(job); else await saveJob(job);
    return;
  }
  if (job.service === 'posts') {
    if (job.destination?.kind !== 'folder') {
      job.archive = undefined; job.tasks = []; job.status = job.scan.complete ? 'ready' : 'cancelled'; job.error = reason;
      await savePostJob(job);
    }
  } else if (job.destination?.kind === 'zip') {
    const records = await getMedia(job.id);
    for (const record of records) if (['downloaded', 'staged'].includes(record.status)) { record.status = 'discovered'; record.attempts = 0; record.nextAttemptAt = 0; }
    job.archive = undefined; job.status = 'indexed'; job.autoManifest = false; job.manifestState = 'pending'; job.destinationError = reason;
    await commitPage(job, records);
  }
}

export async function removeJobCache(jobId: string): Promise<void> {
  if (typeof jobId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(jobId)) throw new Error('Invalid cache to remove.');
  const [discord, post] = await Promise.all([getJob(jobId), getPostJob(jobId)]);
  const jobs = [discord, post].filter((job): job is Job | PostJob => !!job);
  if (jobs.some(job => protectedCache({ status: job.status, archiveState: job.archive?.state }))) throw new Error('This cache is in use or kept for a paused download. Finish or cancel the job before clearing it.');
  await offscreen('cache-remove', { jobId });
  for (const job of jobs) await recordCacheRemoval(job, 'Temporary ZIP data cleared. Download again to prepare a new ZIP.');
}

export async function cleanupSuccessfulZip(job: Job | PostJob): Promise<void> {
  if (job.archive?.state !== 'saved' || job.archive.cacheCleared || !(await getCacheSettings()).clearAfterDownload) return;
  try {
    await offscreen('cache-remove', { jobId: job.id });
    await recordCacheRemoval(job, '');
  } catch {
    // A cleanup failure must never turn a confirmed download into a failed download.
    job.archive!.cacheCleanupError = 'ZIP saved. Temporary data could not be cleared; cleanup will retry.';
    if (job.service === 'posts') await savePostJob(job); else await saveJob(job);
  }
}

export async function maintainZipCaches(now = Date.now()): Promise<void> {
  const settings = await getCacheSettings();
  if ((!settings.retentionMinutes && !settings.clearAfterDownload) || now - settings.lastCheckAt < minute) return;
  const jobs = await getJobSummaries();
  let cleared = 0;
  if (settings.clearAfterDownload) for (const summary of jobs) {
    if (summary.archiveState !== 'saved' || summary.cacheCleared || protectedCache(summary)) continue;
    const job = summary.service === 'posts' ? await getPostJob(summary.id) : await getJob(summary.id);
    if (job) { await cleanupSuccessfulZip(job); if (job.archive?.cacheCleared) cleared++; }
  }
  if (settings.retentionMinutes) {
    const { removed } = await offscreen<{ removed: string[] }>('zip-prune', { cleanup: {
      before: now - settings.retentionMinutes * minute,
      protectedJobIds: jobs.filter(protectedCache).map(job => job.id),
      jobUpdatedAt: Object.fromEntries(jobs.map(job => [job.id, Date.parse(job.updatedAt) || Date.parse(job.createdAt) || now])),
    } });
    const removedIds = new Set(removed);
    const reason = `Temporary ZIP data expired after ${settings.retentionMinutes} minutes without use. Download again to prepare a new ZIP.`;
    for (const summary of jobs) if (removedIds.has(summary.id)) {
      const job = summary.service === 'posts' ? await getPostJob(summary.id) : await getJob(summary.id);
      if (job) await recordCacheRemoval(job, reason);
    }
    cleared += removed.length;
  }
  settings.lastCheckAt = now; settings.removedCaches = cleared; await saveCacheSettings(settings);
}
