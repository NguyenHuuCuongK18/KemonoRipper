import { getJobs, getPostJob, getPostJobs, getSavingPostJobs, getPostJobsForDownload, saveJob, savePostJob } from '../../storage/database';
import { offscreen, release } from '../../background/offscreenBridge';
import { safeSegment } from '../../core/filenameBuilder';
import { parsePostUrl, postSourceUrl } from '../registry';
import { PostClient } from './client';
import { createTasks, postZipJob, thumbnailFallback } from './media';
import { canSkipPostError, discoverPosts, retryPostFailures, skipPostError } from './discovery';
import { assertSyncSource, emptySync, mergeSync, parseSync, recordSaved, validSelection } from './sync';
import type { ExtractedFile, PostCommand, PostExtraction, PostJob, PostSyncIndex, PostTransferProgress } from './types';
import { cleanupSuccessfulZip, removeJobCache } from '../cacheMaintenance';
import { transferFailed, transferLimit, transferSucceeded } from '../../core/transferConcurrency';
import { changePostSelection, selectedPosts } from './selection';
import { detectedFileTypes } from './fileTypes';
import { defaultSelection } from './settings';

const client = new PostClient();
const delay = (attempt: number, retryAfter = 0) => Math.max(retryAfter, 2000 * 2 ** Math.max(0, attempt - 1));
async function requireJob(id: string): Promise<PostJob> { const job = await getPostJob(id); if (!job) throw new Error('Post archive was not found.'); return job; }
function resetScan(job: PostJob): void {
  job.posts = []; job.detailQueue = []; job.tasks = []; job.status = 'scanning'; job.resumeStatus = 'scanning';
  job.scan = { offset: 0, pages: 0, total: job.source.postId ? 1 : null, complete: false, error: null, attempts: 0, nextAt: 0, fingerprints: [] };
  job.nextAt = 0; job.error = null; job.archive = undefined; job.autoDownload = undefined;
}
async function startAutomaticDownload(job: PostJob): Promise<void> {
  const selection = job.autoDownload;
  if (!selection || !job.scan.complete) return;
  job.autoDownload = undefined; job.status = 'ready'; await savePostJob(job);
  try { await postCommand({ type: 'POST_DOWNLOAD', jobId: job.id, selection, destination: job.destination?.kind || 'folder' }); }
  catch (error) {
    job.autoDownload = selection; job.status = 'paused'; job.resumeStatus = 'downloading';
    job.error = error instanceof Error ? error.message : 'Could not start sync.'; await savePostJob(job);
  }
}
export async function pausePosts(): Promise<void> {
  for (const job of await getPostJobs(['scanning', 'downloading'])) {
    job.resumeStatus = job.status as PostJob['resumeStatus']; job.status = 'paused';
    await offscreen('post-transfer-stop', { jobId: job.id });
    for (const task of job.tasks) if (task.status === 'transferring') { task.status = 'queued'; task.attempts = Math.max(0, task.attempts - 1); }
    for (const task of job.tasks) if (task.extraction?.state === 'extracting') task.extraction = { state: 'pending', files: [] };
    if (job.archive?.state === 'building') { await offscreen('zip-stop', { jobId: job.id }); job.archive.state = 'pending'; }
    await savePostJob(job);
  }
}
export function postDetail(job: PostJob, limit = 100) {
  const { posts, tasks, sync, detailQueue, selectedPostIds, ...summary } = job;
  const { fingerprints: _fingerprints, failures: _failures, retryQueue: _retryQueue, ...scan } = summary.scan;
  const syncedPosts = new Set(sync?.posts.map(post => post.id));
  const selectedIds = selectedPostIds === undefined ? undefined : new Set(selectedPostIds);
  const origins = new Set<string>();
  const totals = { synced: 0, thumbnails: 0, syncPosts: sync?.posts.length || 0, newPosts: 0,
    posts: posts.length, selectedPosts: 0, discovered: posts.length - detailQueue.length, total: job.scan.total,
    images: 0, files: 0, fullPosts: 0, selected: tasks.length, saved: 0, failed: 0, retryable: 0, processed: 0, discoveryFailures: job.scan.failures?.length || 0, extractionFailures: 0, extracting: 0, extracted: 0 };
  for (const post of posts) {
    if (!selectedIds || selectedIds.has(post.id)) totals.selectedPosts++;
    if (!syncedPosts.has(post.id)) totals.newPosts++;
    if (post.hasFull !== false) totals.fullPosts++;
    for (const media of post.media) {
      if (media.kind === 'image') totals.images++; else if (media.kind === 'file') totals.files++;
      if (media.originalUrl) { const url = new URL(media.originalUrl); if (url.hostname.endsWith('.kemono.cr')) origins.add(`${url.origin}/*`); }
    }
  }
  for (const task of tasks) {
    if (task.extraction?.state === 'failed') { totals.extractionFailures++; totals.retryable++; }
    if (task.extraction?.state === 'extracting') totals.extracting++;
    totals.extracted += task.extraction?.files.length || 0;
    const collected = task.status === 'staged' || task.status === 'downloaded';
    const saved = task.status === 'downloaded' || (job.destination?.kind !== 'folder' && task.status === 'staged');
    if (task.synced) totals.synced++;
    if (task.fallback && collected) totals.thumbnails++;
    if (saved) totals.saved++;
    if (task.status === 'failed' || task.status === 'unavailable') totals.failed++;
    if (task.status === 'failed') totals.retryable++;
    if (saved || task.status === 'failed' || task.status === 'unavailable') totals.processed++;
  }
  const activeTransfers = tasks.filter(task => task.status === 'transferring').slice(0, 8).map(task => ({ name: task.path.split('/').at(-1)!, progress: task.progress }));
  const queued = tasks.filter(task => task.status === 'queued');
  const retryAt = queued.length ? Math.max(job.nextAt, Math.min(...queued.map(task => task.nextAt))) : 0;
  return { job: { ...summary, scan }, originalOrigins: [...origins], totals, fileTypes: detectedFileTypes(job), activeTransfers, retryAt, canSkipError: canSkipPostError(job), allPostsSelected: selectedPostIds === undefined,
    posts: posts.slice(0, Math.min(1000, Math.max(1, limit))).map(post => ({ id: post.id, title: post.title, files: post.media.length, hasFull: post.hasFull, selected: !selectedIds || selectedIds.has(post.id) })) };
}
async function saveZip(job: PostJob): Promise<void> {
  const archive = job.archive;
  if (archive?.cacheCleared) throw new Error('Temporary ZIP data was cleared. Download again to prepare a new ZIP.');
  if (!archive || !['ready', 'saved'].includes(archive.state)) throw new Error('The ZIP is still being prepared.');
  const normalized = postZipJob(job);
  if (normalized.tasks.some((task, index) => task.path !== job.tasks[index].path)) {
    await pausePosts();
    for (const other of await getJobs(['scanning', 'downloading'])) { other.resumeStatus = other.status as 'scanning' | 'downloading'; other.status = 'paused'; await saveJob(other); }
    await release(archive.blobUrl);
    job.tasks = normalized.tasks; job.status = 'downloading'; job.resumeStatus = 'downloading'; job.error = null;
    Object.assign(archive, { state: 'pending', blobUrl: null, downloadId: null, bytes: 0, entries: 0, progress: 0, total: 0, error: null });
    await savePostJob(job); return;
  }
  await release(archive.blobUrl);
  const opened = await offscreen<{ blobUrl: string; bytes: number }>('zip-open', { jobId: job.id });
  Object.assign(archive, opened, { state: 'saving', downloadId: null, error: null }); await savePostJob(job);
  try { archive.downloadId = await chrome.downloads.download({ url: opened.blobUrl, filename: archive.filename, conflictAction: 'uniquify', saveAs: true }); }
  catch { archive.state = 'ready'; archive.error = 'Save was cancelled. Choose Save ZIP to try again.'; await release(archive.blobUrl); archive.blobUrl = null; }
  await savePostJob(job);
}
export async function postCommand(message: PostCommand): Promise<unknown> {
  if (message.type === 'POST_START') {
    const source = parsePostUrl(message.url); if (!source) throw new Error('Open a Patreon or Fanbox profile or post on Kemono or Pawchive.');
    await pausePosts();
    for (const job of await getJobs(['scanning', 'downloading'])) { job.resumeStatus = job.status as 'scanning' | 'downloading'; job.status = 'paused'; await saveJob(job); }
    const job: PostJob = {
      id: crypto.randomUUID(), service: 'posts', source, sourceUrl: postSourceUrl(source), creatorName: source.creatorId,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'scanning', resumeStatus: 'scanning',
      selection: defaultSelection(),
      scan: { offset: 0, pages: 0, total: source.postId ? 1 : Number.isSafeInteger(message.expectedPosts) && message.expectedPosts! > 0 ? message.expectedPosts! : null, complete: false, error: null, attempts: 0, nextAt: 0, fingerprints: [] },
      posts: [], detailQueue: [], tasks: [], archive: undefined, destination: { kind: 'folder', directoryId: '', name: '' }, nextAt: 0, error: null,
    };
    const metadata = await Promise.allSettled([client.profile(source), job.scan.total === null ? client.total(source) : Promise.resolve(job.scan.total)]);
    if (metadata[0].status === 'fulfilled') job.creatorName = metadata[0].value as string;
    if (metadata[1].status === 'fulfilled') job.scan.total = metadata[1].value as number | null;
    await savePostJob(job); return { jobId: job.id };
  }
  const job = await requireJob(message.jobId);
  if (message.type === 'POST_DETAIL') return postDetail(job, message.limit);
  if (job.archive?.state === 'saving' && !(message.type === 'POST_ACTION' && message.action === 'cancel')) throw new Error('Finish or cancel the current ZIP save first.');
  if (message.type === 'POST_SELECT') {
    if (['scanning', 'downloading'].includes(job.status) || job.status === 'paused' && (job.tasks.length || job.autoDownload)) throw new Error('Finish or cancel this job before changing its selected posts.');
    changePostSelection(job, message.postId, message.selected);
  } else if (message.type === 'POST_FOLDER' || message.type === 'POST_SYNC_CONNECT') {
    const syncConnect = message.type === 'POST_SYNC_CONNECT';
    const reconnect = job.destination?.kind === 'folder' && job.destination.directoryId === message.directoryId;
    if (job.status === 'downloading' && (!reconnect || syncConnect)) throw new Error('Pause this download before changing its archive.');
    if (typeof message.directoryId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(message.directoryId)) throw new Error('Invalid folder selection.');
    const index = await offscreen<PostSyncIndex | null>('post-folder-read', { directoryId: message.directoryId, postJob: job });
    if (syncConnect && !index) throw new Error('The archive history is no longer available. Choose its sync.json again.');
    const retainDownload = reconnect && (!syncConnect || job.status === 'paused' && (job.tasks.length > 0 || !!job.autoDownload));
    job.destination = { kind: 'folder', directoryId: message.directoryId, name: String(message.name).slice(0, 300) };
    // Reauthorizing the existing handle must retain staged files and a pending automatic sync.
    if (!retainDownload) {
      await release(job.archive?.blobUrl || null); job.archive = undefined;
      job.tasks = []; job.autoDownload = undefined; if (job.scan.complete) job.status = 'ready';
    }
    if (index) { job.sync = mergeSync(job.sync, index); if (!retainDownload) job.selection = index.selection; }
    if (syncConnect && !retainDownload) {
      await pausePosts();
      resetScan(job);
    }
  } else if (message.type === 'POST_SYNC_IMPORT') {
    if (job.status === 'downloading') throw new Error('Pause this download before importing a sync JSON.');
    const index = parseSync(message.json, job.source);
    await pausePosts();
    job.sync = mergeSync(job.sync, index); job.selection = index.selection;
    await release(job.archive?.blobUrl || null); resetScan(job);
    if (job.destination?.kind !== 'folder') job.destination = { kind: 'folder', directoryId: '', name: '' };
  } else if (message.type === 'POST_DOWNLOAD') {
    if (!job.scan.complete || ['scanning', 'downloading'].includes(job.status)) throw new Error('Finish scanning before starting another download.');
    const selection = validSelection(message.selection);
    const destination = message.destination || job.destination?.kind || 'zip';
    if (!['folder', 'zip'].includes(destination)) throw new Error('Invalid download destination.');
    if (destination === 'zip' && job.sync) throw new Error('Sync extends an existing folder. Choose Save to folder.');
    if (destination === 'folder' && (job.destination?.kind !== 'folder' || !job.destination.directoryId)) throw new Error('Choose the creator folder before saving. For an older ZIP, choose its extracted creator folder containing thumbnail or full res.');
    const reportOnly = !!job.scan.failures?.length && job.selectedPostIds === undefined;
    if (!selectedPosts(job).length && !reportOnly) throw new Error('Select at least one post before saving.');
    if (destination === 'folder' && job.status === 'finished' && !job.source.postId && job.selectedPostIds === undefined) {
      resetScan(job); job.autoDownload = selection;
      await savePostJob(job); return null;
    }
    if (destination === 'zip') job.destination = { kind: 'zip' };
    job.autoDownload = undefined;
    const previous = new Map(job.tasks.map(task => [task.id, task]));
    job.tasks = createTasks(job, selection);
    if (!job.tasks.length && !reportOnly) throw new Error('Choose at least one available content type.');
    for (const task of job.tasks) {
      const old = previous.get(task.id);
      if (old && ['staged', 'downloaded'].includes(old.status) && await offscreen('post-cached', { jobId: job.id, task: old })) {
        Object.assign(task, { status: 'staged', bytes: old.bytes });
        if (destination === 'zip' && task.extraction && old.extraction?.state === 'done') task.extraction = old.extraction;
        if (task.kind === 'image') task.path = task.path.replace(/\.[^/.]+$/, old.path.slice(old.path.lastIndexOf('.')));
      }
    }
    if (destination === 'folder') {
      const checked = await offscreen<{ sync?: PostSyncIndex; files: { id: string; path: string; bytes: number; extraction?: PostExtraction }[] }>('post-folder-check', { postJob: job });
      job.sync = checked.sync || emptySync(job);
      const saved = new Map(checked.files.map(file => [file.id, file]));
      for (const task of job.tasks) { const file = saved.get(task.id); if (file) Object.assign(task, file, { status: 'downloaded', synced: true, error: null }); if (task.fallback) task.fallbackChecked = true; }
      job.sync.selection = selection;
    }
    job.selection = selection; job.status = 'downloading'; job.resumeStatus = 'downloading'; job.error = null;
    if (job.archive) await release(job.archive.blobUrl);
    job.archive = destination === 'zip' ? { state: 'pending', filename: `${job.source.platform}_${job.source.creatorId}_${safeSegment(job.creatorName)}${job.source.postId ? '_post-' + job.source.postId : ''}_${job.id.slice(0, 8)}.zip`, blobUrl: null, downloadId: null, bytes: 0, entries: 0, progress: 0, total: 0, error: null } : undefined;
  } else if (message.action === 'pause') { await pausePosts(); return null; }
  else if (message.action === 'rescan') {
    if (['scanning', 'downloading'].includes(job.status)) throw new Error('Pause or finish this job before scanning again.');
    await release(job.archive?.blobUrl || null); resetScan(job);
  }
  else if (message.action === 'skip') {
    skipPostError(job);
    if (job.scan.complete && job.autoDownload) { await savePostJob(job); await startAutomaticDownload(job); return null; }
  }
  else if (message.action === 'resume' || message.action === 'retry') {
    if (message.action === 'resume' && job.status !== 'paused') throw new Error('Only paused jobs can be resumed.');
    // Confirm access in the context that actually writes files before clearing the pause/error.
    if (job.destination?.kind === 'folder' && job.destination.directoryId && (job.tasks.length || job.autoDownload)) {
      await offscreen('post-folder-read', { directoryId: job.destination.directoryId, postJob: job });
    }
    job.error = null; job.scan.error = null; job.scan.errorStatus = null; job.scan.attempts = 0; job.scan.nextAt = 0;
    if (message.action === 'resume') job.scan.consecutiveFailures = 0;
    if (message.action === 'retry' && job.scan.complete && job.scan.failures?.length) {
      retryPostFailures(job);
      if (job.tasks.length) job.autoDownload = job.selection;
    }
    if (job.scan.complete && job.autoDownload) { await startAutomaticDownload(job); return null; }
    for (const task of job.tasks) if (task.status === 'failed') { task.status = 'queued'; task.attempts = 0; task.nextAt = 0; task.error = null; }
    for (const task of job.tasks) if (task.extraction?.state === 'failed') task.extraction = { state: 'pending', files: [] };
    if (job.archive?.cacheCleared) for (const task of job.tasks) if (['downloaded', 'staged'].includes(task.status)) {
      task.status = 'queued'; task.attempts = 0; task.nextAt = 0; task.bytes = null;
      if (task.extraction) task.extraction = { state: 'pending', files: [] };
    }
    job.status = !job.scan.complete ? 'scanning' : job.tasks.length ? 'downloading' : 'ready';
    if (job.archive && job.archive.state !== 'pending') { await release(job.archive.blobUrl); job.archive.blobUrl = null; job.archive.downloadId = null; job.archive.error = null; job.archive.cacheCleared = false; job.archive.cacheCleanupError = null; await offscreen('zip-stop', { jobId: job.id }); job.archive.state = 'pending'; }
  } else if (message.action === 'cancel') {
    await offscreen('post-transfer-stop', { jobId: job.id }); await offscreen('zip-stop', { jobId: job.id });
    for (const task of job.tasks) if (task.status === 'transferring') task.status = 'queued';
    for (const task of job.tasks) if (task.extraction?.state === 'extracting') task.extraction = { state: 'pending', files: [] };
    if (job.archive?.state === 'saving' && job.archive.downloadId !== null) await chrome.downloads.cancel(job.archive.downloadId).catch(() => {});
    if (job.archive?.state === 'building') job.archive.state = 'pending';
    job.status = 'cancelled';
  } else if (message.action === 'save-zip') { await saveZip(job); return null; }
  else if (message.action === 'clear-cache') {
    await removeJobCache(job.id); return null;
  }
  await savePostJob(job); return null;
}
async function scan(job: PostJob): Promise<void> {
  await discoverPosts(job, client);
  await savePostJob(job);
  if (job.scan.complete && job.autoDownload) await startAutomaticDownload(job);
}
interface Transfer { state: 'transferring' | 'done'; bytes?: number; ext?: string; failure?: string; status?: number; retryAfterMs?: number; progress?: PostTransferProgress }
async function reconcileTasks(job: PostJob): Promise<void> {
  let changed = false;
  const active = job.tasks.filter(task => task.status === 'transferring'), completed: string[] = [];
  const results = await Promise.all(active.map(task => offscreen<Transfer | null>('post-transfer-status', { jobId: job.id, recordId: task.id })));
  for (const [index, task] of active.entries()) {
    const recordId = task.id;
    const result = results[index];
    if (result?.progress && (task.progress?.updatedAt !== result.progress.updatedAt || task.progress?.receivedBytes !== result.progress.receivedBytes || task.progress?.phase !== result.progress.phase)) {
      task.progress = result.progress; changed = true;
    }
    if (result?.state === 'transferring') continue;
    if (result?.bytes !== undefined) {
      task.bytes = result.bytes; task.status = 'staged'; task.error = null;
      if (task.kind === 'image' && result.ext) task.path = task.path.replace(/\.[^/.]+$/, '.' + result.ext);
      if (task.kind !== 'text') transferSucceeded(job, 'posts');
    } else {
      task.error = result?.failure || 'Transfer interrupted; retrying.';
      const retryable = !result?.status || result.status === 429 || result.status >= 500;
      task.status = retryable && task.attempts < 3 ? 'queued' : 'failed';
      task.nextAt = Date.now() + delay(task.attempts, result?.retryAfterMs);
      if (result?.status === 429) job.nextAt = Math.max(job.nextAt, task.nextAt);
      if (task.kind !== 'text') transferFailed(job, 'posts', result?.status, result?.retryAfterMs);
      // Only a missing original triggers fallback. Rate limits and other errors keep their retry policy.
      if (result?.status === 404 || result?.status === 410) {
        const fallback = thumbnailFallback(task, task.error);
        if (fallback) Object.assign(task, fallback);
      }
    }
    completed.push(recordId); changed = true;
  }
  // Commit the batch before releasing transfer results so worker restarts retain successes.
  if (changed) await savePostJob(job);
  await Promise.all(completed.map(recordId => offscreen('post-transfer-forget', { jobId: job.id, recordId })));
}
async function reconcileExtractions(job: PostJob): Promise<void> {
  for (const task of job.tasks) if (task.extraction?.state === 'extracting') {
    const result = await offscreen<PostExtraction | null>('post-extract-status', { jobId: job.id, recordId: task.id });
    if (result?.state === 'extracting') continue;
    if (!result) { task.extraction = { state: 'pending', files: [] }; await savePostJob(job); continue; }
    if (job.destination?.kind === 'folder') {
      result.files = await offscreen<ExtractedFile[]>('post-extract-commit', { postJob: job, recordId: task.id });
      job.sync ||= emptySync(job); task.extraction = result;
      recordSaved(job.sync, task, job.posts.find(post => post.id === task.postId)?.title || task.postId);
      await savePostJob(job); await offscreen('post-folder-index', { postJob: job });
    } else { task.extraction = result; await savePostJob(job); }
    await offscreen('post-extract-forget', { jobId: job.id, recordId: task.id, postJob: job });
  }
  if (job.destination?.kind === 'folder') for (const task of job.tasks) if (task.extraction?.state === 'done' && !task.extraction.originalRemoved) {
    await offscreen('post-extract-remove-original', { postJob: job, recordId: task.id });
    task.extraction.originalRemoved = true; await savePostJob(job);
  }
  if (job.tasks.some(task => task.extraction?.state === 'extracting')) return;
  const next = job.tasks.find(task => task.extraction?.state === 'pending' && ['staged', 'downloaded'].includes(task.status));
  if (next) {
    next.extraction = { state: 'extracting', files: [] }; await savePostJob(job);
    await offscreen('post-extract-start', { postJob: job, recordId: next.id });
  }
}
export async function tickPosts(): Promise<boolean> {
  const jobs = await getPostJobs(['scanning', 'downloading']);
  const notBefore = Math.max(0, ...jobs.map(job => Math.max(job.nextAt, job.scan.nextAt)));
  for (const job of jobs) {
    if (job.status === 'scanning') { if (Date.now() >= notBefore) await scan(job); return true; }
    if (job.status !== 'downloading') continue;
    await reconcileTasks(job);
    if (job.destination?.kind === 'folder') {
      try {
        const fallbacks = job.tasks.filter(task => task.fallback && !task.fallbackChecked && task.status === 'queued');
        if (fallbacks.length) {
          const checked = await offscreen<{ sync?: PostSyncIndex; files: { id: string; path: string; bytes: number }[] }>('post-folder-check', { postJob: job });
          job.sync = checked.sync || job.sync;
          if (job.sync) job.sync.selection = job.selection;
          const saved = new Map(checked.files.map(file => [file.id, file]));
          for (const task of fallbacks) {
            const file = saved.get(task.id);
            if (file) Object.assign(task, file, { status: 'downloaded', synced: true, error: null });
            task.fallbackChecked = true;
          }
          await savePostJob(job);
        }
        for (const task of job.tasks) if (task.status === 'staged') {
          const saved = await offscreen<{ path: string; bytes: number }>('post-folder-write', { postJob: job, recordId: task.id });
          Object.assign(task, saved, { status: 'downloaded' });
          job.sync ||= emptySync(job); assertSyncSource(job.sync, job.source);
          recordSaved(job.sync, task, job.posts.find(post => post.id === task.postId)?.title || task.postId);
          await savePostJob(job);
          await offscreen('post-folder-index', { postJob: job });
          await offscreen('post-cache-remove', { jobId: job.id, recordId: task.id }).catch(() => {});
        }
      } catch (error) {
        await offscreen('post-transfer-stop', { jobId: job.id });
        for (const task of job.tasks) if (task.status === 'transferring') { task.status = 'queued'; task.attempts = Math.max(0, task.attempts - 1); }
        job.status = 'paused'; job.resumeStatus = 'downloading'; job.error = error instanceof Error ? error.message : 'Could not write to the creator folder. Check folder access and free disk space, then Resume.';
        await savePostJob(job); return true;
      }
    }
    try { await reconcileExtractions(job); }
    catch (error) {
      await offscreen('post-transfer-stop', { jobId: job.id });
      for (const task of job.tasks) {
        if (task.status === 'transferring') { task.status = 'queued'; task.attempts = Math.max(0, task.attempts - 1); }
        if (task.extraction?.state === 'extracting') task.extraction = { state: 'pending', files: [] };
      }
      job.status = 'paused'; job.resumeStatus = 'downloading'; job.error = error instanceof Error ? error.message : 'Could not save extracted files. Check folder access and free disk space, then Resume.';
      await savePostJob(job); return true;
    }
    const active = job.tasks.filter(task => task.status === 'transferring').length;
    const limit = transferLimit(job, 'posts');
    // Reconciliation may have just received a 429; honor its new deadline now.
    // Let short text/image work fill and grow the pool before large source archives occupy every slot.
    const priority = { text: 0, image: 1, file: 2 };
    const next = Date.now() >= Math.max(notBefore, job.nextAt) ? job.tasks.filter(task => task.status === 'queued' && task.nextAt <= Date.now())
      .sort((a, b) => priority[a.kind] - priority[b.kind]).slice(0, Math.max(0, limit - active)) : [];
    if (next.length) {
      for (const task of next) { task.status = 'transferring'; task.attempts++; task.progress = { receivedBytes: 0, totalBytes: null, phase: 'connecting', updatedAt: Date.now() }; }
      job.nextAt = Date.now() + 400; await savePostJob(job);
      await Promise.all(next.map(task => offscreen('post-transfer-start', { jobId: job.id, task, post: job.posts.find(post => post.id === task.postId), source: job.source })));
    }
    if (job.tasks.some(task => ['queued', 'transferring'].includes(task.status))) return true;
    if (job.tasks.some(task => ['staged', 'downloaded'].includes(task.status) && task.extraction && ['pending', 'extracting'].includes(task.extraction.state))) return true;
    if (job.destination?.kind === 'folder') {
      try { await offscreen('post-folder-index', { postJob: job }); job.status = 'finished'; await offscreen('zip-clear', { jobId: job.id }).catch(() => {}); }
      catch (error) { job.status = 'paused'; job.error = error instanceof Error ? error.message : 'Could not update sync.json. Check folder access, then Resume.'; }
      await savePostJob(job); return true;
    }
    const archive = job.archive!;
    if (archive.state === 'pending') { job.tasks = postZipJob(job).tasks; await offscreen('post-zip-build-start', { postJob: job }); archive.state = 'building'; }
    else if (archive.state === 'building') {
      const result = await offscreen<Pick<NonNullable<PostJob['archive']>, 'state' | 'bytes' | 'entries' | 'progress' | 'total' | 'error'> | null>('zip-build-status', { jobId: job.id });
      if (!result) archive.state = 'pending';
      else { Object.assign(archive, result); if (result.state === 'ready') { job.status = 'finished'; await savePostJob(job); await saveZip(job); return true; } if (result.state === 'failed') { job.status = 'finished'; job.error = result.error; } }
    }
    await savePostJob(job); return true;
  }
  return false;
}
export async function reconcilePostDownloads(recovering = false, downloadId?: number): Promise<void> {
  const saving = downloadId === undefined ? await getSavingPostJobs() : await getPostJobsForDownload(downloadId);
  const jobs = new Map(saving.map(job => [job.id, job]));
  if (recovering) for (const job of await getPostJobs(['downloading'])) jobs.set(job.id, job);
  for (const job of jobs.values()) {
    const archive = job.archive;
    if (archive?.state === 'saving') {
      let item: chrome.downloads.DownloadItem | undefined;
      if (archive.downloadId !== null) [item] = await chrome.downloads.search({ id: archive.downloadId });
      else if (archive.blobUrl) item = (await chrome.downloads.search({ query: [archive.filename], limit: 20 })).find(item => item.url === archive.blobUrl);
      if (item?.state === 'complete' && item.exists !== false) { archive.state = 'saved'; archive.error = null; for (const task of job.tasks) if (task.status === 'staged') task.status = 'downloaded'; }
      else if (item?.state === 'interrupted' || item?.exists === false || (!item && recovering)) { archive.state = 'ready'; archive.error = 'ZIP saving was interrupted. Choose Save ZIP to retry.'; }
      else continue;
      await release(archive.blobUrl); archive.blobUrl = null; await savePostJob(job);
      if (archive.state === 'saved') await cleanupSuccessfulZip(job);
    }
    if (recovering && job.status === 'downloading') await reconcileTasks(job);
  }
}
