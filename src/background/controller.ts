import { KemonoClient, RequestError } from '../api/kemonoClient';
import type { Command, Discovery, Job, MediaRecord, PageChannels, Server } from '../core/types';
import { ARCHIVE_ORIGINS, parseArchiveUrl, parseChannelUrl, requireId, safeMediaUrl } from '../core/urlParser';
import { mergeChannels } from '../core/channelDiscovery';
import { normalizeMessages } from '../core/mediaNormalizer';
import { mergeMedia } from '../core/deduplicator';
import { advancePage } from '../core/pagination';
import { channelFolder, serverFolder } from '../core/filenameBuilder';
import { commitPage, getJob, getJobs, getMedia, getSavingJobs, getManifestJobs, getArchiveJobsForDownload, getMediaForDownload, saveJob, saveMedia, saveMediaRecords } from '../storage/database';
import { csv, manifest, summarize } from '../storage/manifestExporter';
import { reconcileImage, retryDelay, startImage, MAX_ATTEMPTS } from './downloadQueue';
import { offscreen, release, saveText } from './offscreenBridge';
import { directoryKey, FolderPermissionError, requireDirectory } from '../storage/destination';
import { fileMatches } from '../storage/folderWriter';
import { ZipStorageError } from '../storage/zipCache';
import { newArchive, prepareZip, reconcileZip, saveZip } from './zipArchive';
import { removeJobCache } from '../services/cacheMaintenance';
import { transferLimit } from '../core/transferConcurrency';
const client = new KemonoClient();
function touch(job: Job): Job { job.updatedAt = new Date().toISOString(); return job; }
async function requireJob(id: string): Promise<Job> { const job = await getJob(id); if (!job) throw new Error('Archive job was not found'); return job; }
async function discover(url: string): Promise<Discovery> {
  const scope = parseArchiveUrl(url); if (!scope) throw new Error('Open or paste a Kemono or Pawchive Discord server or channel URL');
  const origin = new URL(url).origin;
  const tabs = await chrome.tabs.query({ url: `${origin}/discord/server/*` });
  const pageTasks = tabs.filter(tab => tab.id !== undefined && parseArchiveUrl(tab.url || '')?.serverId === scope.serverId && new URL(tab.url!).origin === origin).map(async tab => {
    try {
      const response: PageChannels | null = await chrome.tabs.sendMessage(tab.id!, { type: 'DISCOVER_CHANNELS' });
      return response?.serverId === scope.serverId && Array.isArray(response.channels) ? response : null;
    } catch { return null; } // Existing tabs may need a reload after extension installation.
  });
  const [apiResult, ...pageResults] = await Promise.allSettled([client.server(scope.serverId, origin), ...pageTasks]);
  const api = apiResult.status === 'fulfilled' ? apiResult.value as Server : null;
  const pages = pageResults.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value as PageChannels] : []);
  const server = mergeChannels(scope.serverId, api, pages);
  scope.serverName = server?.name || null; scope.channelName = server?.channels.find(c => c.id === scope.channelId)?.name || null;
  let warning: string | null = null;
  if (!api) {
    const failure = apiResult.status === 'rejected' && apiResult.reason instanceof Error ? apiResult.reason.message : 'Server metadata is unavailable.';
    warning = `${failure} ${server?.channels.length ? 'Using channel links from the open page; hidden or unloaded channels may be missing.' : scope.channelId ? 'Current-channel scanning is still available.' : 'Open the server page, reload it, and discover its channel links again.'}`;
  }
  return { scope, server, warning, apiChannelCount: api?.channels.length || 0, domChannelCount: server?.channels.filter(c => c.sources?.includes('dom')).length || 0 };
}
export async function command(message: Command, sender: chrome.runtime.MessageSender): Promise<unknown> {
  if (message.type === 'DISCOVER') return discover(message.url);
  if (message.type === 'LIST') {
    const jobs = (await getJobs()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return Promise.all(jobs.map(async job => ({ job, totals: summarize(job, await getMedia(job.id)) })));
  }
  if (message.type === 'DETAIL') {
    const job = await requireJob(message.jobId), media = await getMedia(job.id);
    const originalOrigins = media.some(record => [record.originalUrl, record.thumbnailUrl].some(url => url && new URL(url).hostname.endsWith('.kemono.cr'))) ? ['https://*.kemono.cr/*'] : [];
    const viewJob = message.includeMedia === false ? { ...job, channels: job.channels.map(channel => ({ ...channel, messageIds: [], pageFingerprints: [], messageCount: channel.messageIds.length })) } : job;
    return { job: viewJob, ...(message.includeMedia === false ? {} : { media }), originalOrigins, hasDiscordCdn: media.some(record => record.discordCdnUrl), totals: summarize(job, media) };
  }
  if (message.type === 'DASHBOARD') { await chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/index.html') }); return null; }
  if (message.type === 'START') {
    if (!['thumbnail', 'best', 'original'].includes(message.mode)) throw new Error('Invalid quality mode');
    const { scope, server, warning, apiChannelCount, domChannelCount } = await discover(message.url);
    const origin = new URL(message.url).origin;
    const wholeServer = !!message.allChannels || (!scope.channelId && !message.channelIds.length);
    const ids = [...new Set(wholeServer ? server?.channels.map(c => c.id) || [] : message.channelIds.length ? message.channelIds.map(requireId) : scope.channelId ? [scope.channelId] : [])];
    if (!ids.length) throw new Error(warning || 'No channels were discovered in this server. Open the server page and try Discover channels again.');
    if (ids.some(id => id !== scope.channelId && !server?.channels.some(c => c.id === id))) throw new Error('Selected channel was not discovered in this server');
    for (const existing of await getJobs(['scanning', 'downloading'])) { existing.resumeStatus = existing.status as Job['resumeStatus']; existing.status = 'paused'; await saveJob(touch(existing)); }
    const job: Job = {
      service: 'discord',
      id: crypto.randomUUID(), serverId: scope.serverId, serverName: scope.serverName, mode: message.mode, tryOriginal: !!message.tryOriginal,
      channels: ids.map(channelId => {
        const channel = server?.channels.find(c => c.id === channelId);
        return { channelId, channelName: channel?.name || null, postCount: channel?.postCount ?? null, offset: 0, pages: 0, messageIds: [], pageFingerprints: [], coverage: 'pending', terminal: null, failures: [], attempts: 0, nextAttemptAt: 0, error: null, domMessages: 0 };
      }),
      status: 'scanning', resumeStatus: 'scanning', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      warnings: warning ? [warning] : [], autoManifest: false, manifestState: 'pending', manifestDownloads: [], apiNextAt: 0, mediaNextAt: 0,
      scope: wholeServer ? 'server' : ids.length === 1 ? 'channel' : 'selected', sourceUrl: `${origin}/discord/server/${scope.serverId}${scope.channelId ? '/' + scope.channelId : ''}`,
      discoveredChannelCount: server?.channels.length || ids.length,
      channelDiscovery: apiChannelCount ? domChannelCount ? 'api+dom' : 'api' : domChannelCount ? 'dom' : 'current-channel',
      destination: { kind: 'zip' },
    };
    await saveJob(job);
    // Ask already loaded content scripts to contribute; failure simply leaves API coverage.
    const tabs = await chrome.tabs.query({ url: `${origin}/discord/server/*` });
    for (const tab of tabs) if (tab.id && parseArchiveUrl(tab.url || '')?.serverId === job.serverId && new URL(tab.url!).origin === origin) void chrome.tabs.sendMessage(tab.id, { type: 'SCAN_DOM' }).catch(() => {});
    return { jobId: job.id };
  }
  if (message.type === 'DOM') {
    const scope = parseChannelUrl(message.url);
    const actual = parseChannelUrl(sender.tab?.url || '');
    if (!scope || !actual || actual.channelId !== scope.channelId || actual.serverId !== scope.serverId || new URL(message.url).origin !== new URL(sender.tab!.url!).origin) return null;
    const origin = new URL(message.url).origin;
    for (const job of await getJobs()) {
      if (job.serverId !== scope.serverId || new URL(job.sourceUrl || ARCHIVE_ORIGINS[0]).origin !== origin || !['scanning', 'indexed', 'paused'].includes(job.status)) continue;
      const checkpoint = job.channels.find(c => c.channelId === scope.channelId); if (!checkpoint) continue;
      const incoming = message.records.slice(0, 10000).filter(r => r.serverId === scope.serverId && r.channelId === scope.channelId).map(r => ({
        ...r, jobId: job.id, service: job.service, serverName: job.serverName, channelName: checkpoint.channelName,
        originalUrl: safeMediaUrl(r.originalUrl), discordCdnUrl: safeMediaUrl(r.discordCdnUrl), thumbnailUrl: safeMediaUrl(r.thumbnailUrl),
      }));
      checkpoint.domMessages = Math.max(checkpoint.domMessages, message.messageCount);
      await commitPage(touch(job), mergeMedia(await getMedia(job.id), incoming));
    }
    return null;
  }
  const job = await requireJob(message.jobId);
  if (job.archive?.state === 'saving' && (message.type === 'DESTINATION' || (message.type === 'ACTION' && ['download', 'retry'].includes(message.action)))) throw new Error('Finish or cancel the current ZIP save before starting another');
  if (message.type === 'DESTINATION') {
    if (job.status === 'downloading') throw new Error('Pause the job before choosing its save destination');
    const records = await getMedia(job.id);
    if (message.kind === 'folder') {
      const key = message.directoryId || job.id; const handle = await requireDirectory(key);
      for (const record of records) {
        const missing = ['downloaded', 'staged'].includes(record.status) && (!record.savedPath || !record.sha256 || record.bytes === null || !await fileMatches(key, record.savedPath, record.sha256, record.bytes));
        if (missing || record.status === 'transferring') {
          if (record.status === 'transferring' && record.downloadId !== null) await chrome.downloads.cancel(record.downloadId).catch(() => {});
          await release(record.blobUrl); record.blobUrl = null; record.downloadId = null;
          record.status = job.autoManifest ? 'queued' : 'discovered'; record.attempts = 0; record.nextAttemptAt = 0; record.errorMessage = null;
        } else if (record.status === 'staged') record.status = 'downloaded';
      }
      for (const download of job.manifestDownloads) {
        if (download.state === 'in_progress') await chrome.downloads.cancel(download.id).catch(() => {});
        await release(download.blobUrl);
      }
      job.destination = { kind: 'folder', name: handle.name, ...(message.directoryId ? { directoryId: key } : {}) }; job.manifestState = 'pending'; job.manifestPaths = []; job.manifestDownloads = [];
      job.archive = undefined;
    }
    else if (message.kind === 'zip') {
      const candidates = records.filter(r => ['downloaded', 'staged', 'transferring'].includes(r.status));
      const cached = new Set((await offscreen<{ ids: string[] }>('zip-matches', { jobId: job.id, records: candidates })).ids);
      for (const record of candidates) {
        if (record.status === 'transferring' && record.downloadId !== null) await chrome.downloads.cancel(record.downloadId).catch(() => {});
        await release(record.blobUrl); record.blobUrl = null; record.downloadId = null;
        record.status = cached.has(record.id) ? 'staged' : job.autoManifest ? 'queued' : 'discovered'; record.attempts = 0; record.nextAttemptAt = 0; record.errorMessage = null;
      }
      for (const download of job.manifestDownloads) {
        if (download.state === 'in_progress') await chrome.downloads.cancel(download.id).catch(() => {});
        await release(download.blobUrl);
      }
      job.destination = { kind: 'zip' }; job.archive = newArchive(job); job.manifestState = 'pending'; job.manifestDownloads = []; job.manifestPaths = [];
    }
    else if (message.kind === 'browser') {
      if (records.some(r => ['downloaded', 'staged'].includes(r.status)) && job.destination?.kind !== 'browser' && job.destination) throw new Error('Create a new job to switch collected files to individual Browser downloads.');
      job.destination = { kind: 'browser' };
      job.archive = undefined;
    }
    else throw new Error('Unsupported save destination');
    job.destinationError = null; await commitPage(touch(job), records); return null;
  }
  if (message.type === 'EXPORT') {
    const records = await getMedia(job.id); const base = serverFolder(job);
    const suffix = job.id.slice(0, 8);
    const path = `${base}/${message.format === 'csv' ? 'links' : message.format === 'failures' ? 'failures' : 'manifest'}-${suffix}.${message.format === 'csv' ? 'csv' : 'json'}`;
    const text = message.format === 'csv' ? csv(records) : manifest(job, message.format === 'failures' ? records.filter(r => r.status === 'failed' || r.status === 'skipped') : records);
    const mime = message.format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json';
    if (job.destination?.kind === 'folder') await offscreen('save-text', { jobId: directoryKey(job), path, text, mime });
    else await saveText(text, path, mime);
    return null;
  }
  if (message.action === 'pause') {
    if (['scanning', 'downloading'].includes(job.status)) { job.resumeStatus = job.status as Job['resumeStatus']; job.status = 'paused'; }
    for (const record of await getMedia(job.id)) if (record.status === 'transferring' && record.downloadId !== null) await chrome.downloads.pause(record.downloadId).catch(() => {});
    if (job.destination?.kind === 'zip' && job.archive?.state === 'building') { await offscreen('zip-stop', { jobId: job.id }); job.archive.state = 'pending'; }
  } else if (message.action === 'cancel') {
    job.status = 'cancelled';
    if (job.destination?.kind === 'zip') {
      await offscreen('zip-stop', { jobId: job.id });
      if (job.archive?.state === 'saving' && job.archive.downloadId !== null) await chrome.downloads.cancel(job.archive.downloadId).catch(() => {});
      if (job.archive?.state === 'building') job.archive.state = 'pending';
    }
    for (const record of await getMedia(job.id)) {
      if (record.status === 'transferring' && record.downloadId !== null) await chrome.downloads.cancel(record.downloadId).catch(() => {});
      if (['queued', 'transferring'].includes(record.status)) { record.status = 'skipped'; record.errorMessage = 'Cancelled by user'; await release(record.blobUrl); record.blobUrl = null; await saveMedia(record); }
    }
  } else if (message.action === 'resume') {
    if (job.status !== 'paused') throw new Error('Only paused jobs can be resumed');
    if (job.destination?.kind === 'folder' && job.resumeStatus === 'downloading') await requireDirectory(directoryKey(job));
    job.destinationError = null;
    job.status = job.resumeStatus;
    for (const record of await getMedia(job.id)) if (record.status === 'transferring' && record.downloadId !== null) await chrome.downloads.resume(record.downloadId).catch(() => {});
  } else if (message.action === 'retry') {
    for (const checkpoint of job.channels) if (checkpoint.coverage === 'incomplete') { checkpoint.coverage = 'pending'; checkpoint.attempts = 0; checkpoint.error = null; checkpoint.nextAttemptAt = 0; }
    for (const record of await getMedia(job.id)) if (record.status === 'failed' || record.status === 'skipped') { record.status = job.autoManifest ? 'queued' : 'discovered'; record.attempts = 0; record.nextAttemptAt = 0; record.errorMessage = null; record.candidateFailures = []; await saveMedia(record); }
    job.status = job.channels.some(c => c.coverage !== 'complete') ? 'scanning' : job.autoManifest ? 'downloading' : 'indexed'; job.manifestState = 'pending';
    if (job.destination?.kind === 'zip') {
      if (job.archive?.cacheCleared) {
        const records = await getMedia(job.id, ['downloaded', 'staged']);
        for (const record of records) { record.status = 'queued'; record.attempts = 0; record.nextAttemptAt = 0; }
        await saveMediaRecords(records);
      }
      job.archive = newArchive(job);
    }
  } else if (message.action === 'save-zip') {
    if (job.destination?.kind !== 'zip') throw new Error('Select ZIP output first'); await saveZip(job); return null;
  } else if (message.action === 'clear-cache') {
    await removeJobCache(job.id); return null;
  } else if (message.action === 'download') {
    if (job.status === 'scanning' || job.channels.some(c => ['pending', 'scanning'].includes(c.coverage))) throw new Error('Pause or finish the scan before downloading the indexed results');
    if (!job.destination) throw new Error('Choose a save folder or explicitly select Browser downloads before starting the batch');
    if (job.destination.kind === 'folder') await requireDirectory(directoryKey(job));
    const records = await getMedia(job.id);
    let cached: Set<string> | undefined;
    if (job.destination.kind === 'zip') {
      cached = new Set((await offscreen<{ ids: string[] }>('zip-matches', { jobId: job.id, records: records.filter(r => ['downloaded', 'staged'].includes(r.status)) })).ids);
      job.archive = newArchive(job);
    }
    const queued: MediaRecord[] = [];
    for (const record of records) if (record.status === 'discovered' || (cached && ['staged', 'downloaded'].includes(record.status) && !cached.has(record.id))) { record.status = 'queued'; record.attempts = 0; record.nextAttemptAt = 0; queued.push(record); }
    await saveMediaRecords(queued);
    job.status = 'downloading'; job.autoManifest = true; job.manifestState = 'pending'; job.destinationError = null;
  }
  await saveJob(touch(job)); return null;
}
async function scanPage(job: Job): Promise<void> {
  if (!job.channels.some(c => ['pending', 'scanning'].includes(c.coverage))) { job.status = job.autoManifest ? 'downloading' : 'indexed'; await saveJob(touch(job)); return; }
  if (Date.now() < job.apiNextAt) return;
  const checkpoint = job.channels.find(c => ['pending', 'scanning'].includes(c.coverage) && c.nextAttemptAt <= Date.now());
  if (!checkpoint) {
    if (!job.channels.some(c => ['pending', 'scanning'].includes(c.coverage))) { job.status = job.autoManifest ? 'downloading' : 'indexed'; await saveJob(touch(job)); }
    return;
  }
  try {
    const origin = new URL(job.sourceUrl || ARCHIVE_ORIGINS[0]).origin;
    const messages = await client.channel(checkpoint.channelId, checkpoint.offset, origin);
    const next = advancePage(checkpoint, messages);
    const incoming = normalizeMessages(messages, { serverId: job.serverId, serverName: job.serverName, channelId: checkpoint.channelId, channelName: checkpoint.channelName, service: job.service }, job.id, origin);
    if (job.autoManifest) for (const record of incoming) record.status = 'queued';
    job.channels[job.channels.indexOf(checkpoint)] = next;
    if (next.coverage === 'complete' && next.postCount !== null && next.postCount !== next.messageIds.length) job.warnings.push(`Channel ${next.channelId}: metadata post_count=${next.postCount}; API unique messages=${next.messageIds.length}.`);
    job.apiNextAt = Date.now() + 1100;
    await commitPage(touch(job), mergeMedia(await getMedia(job.id), incoming));
  } catch (error) {
    checkpoint.attempts++; checkpoint.error = error instanceof Error ? error.message : 'Page scan failed';
    checkpoint.failures.push({ offset: checkpoint.offset, reason: checkpoint.error, at: new Date().toISOString() });
    const retryable = error instanceof RequestError && error.retryable;
    if (error instanceof RequestError && error.status === 429) job.apiNextAt = Date.now() + retryDelay(checkpoint.attempts, error.retryAfterMs);
    if (retryable && checkpoint.attempts < MAX_ATTEMPTS) {
      const delay = retryDelay(checkpoint.attempts, error.retryAfterMs); checkpoint.nextAttemptAt = Date.now() + delay; job.apiNextAt = checkpoint.nextAttemptAt;
    } else checkpoint.coverage = 'incomplete';
    await saveJob(touch(job));
  }
}
async function saveManifests(job: Job, records: MediaRecord[]): Promise<void> {
  job.manifestState = 'saving'; job.manifestDownloads = []; await saveJob(touch(job));
  try {
    if (job.destination?.kind === 'folder') {
      job.manifestPaths = [];
      for (const channel of job.channels) {
        const path = `${channelFolder({ ...job, channelId: channel.channelId, channelName: channel.channelName })}/channel-manifest.json`;
        await offscreen('save-text', { jobId: directoryKey(job), path, text: manifest(job, records, channel.channelId), overwrite: true });
        job.manifestPaths.push(path); await saveJob(job);
      }
      const path = `${serverFolder(job)}/manifest.json`;
      await offscreen('save-text', { jobId: directoryKey(job), path, text: manifest(job, records), overwrite: true });
      job.manifestPaths.push(path); job.manifestState = 'saved'; await saveJob(touch(job)); return;
    }
    for (const channel of job.channels) {
      const path = `${channelFolder({ ...job, channelId: channel.channelId, channelName: channel.channelName })}/channel-manifest.json`;
      const download = await saveText(manifest(job, records, channel.channelId), path, 'application/json', true);
      job.manifestDownloads.push({ ...download, path, state: 'in_progress' }); await saveJob(job);
    }
    const path = `${serverFolder(job)}/manifest.json`;
    const download = await saveText(manifest(job, records), path, 'application/json', true);
    job.manifestDownloads.push({ ...download, path, state: 'in_progress' }); await saveJob(job);
  } catch (error) {
    if (error instanceof FolderPermissionError) { job.manifestState = 'pending'; await pauseForFolder(job, error); }
    else { job.manifestState = 'failed'; job.warnings.push('One or more manifest saves failed. Use Export JSON to save the current state.'); await saveJob(touch(job)); }
  }
}
async function pauseForFolder(job: Job, error: Error): Promise<void> {
  job.resumeStatus = 'downloading'; job.status = 'paused'; job.destinationError = error.message; await saveJob(touch(job));
}
export async function tick(): Promise<number | void> {
  const jobs = await getJobs(['scanning', 'downloading']);
  const apiNotBefore = Math.max(0, ...jobs.map(job => job.apiNextAt));
  const mediaNotBefore = Math.max(0, ...jobs.map(job => job.mediaNextAt));
  for (const job of jobs) {
    if (job.status === 'scanning') { if (Date.now() >= apiNotBefore || job.channels.every(c => !['pending', 'scanning'].includes(c.coverage))) await scanPage(job); return; }
    if (job.status !== 'downloading') continue;
    if (job.destination?.kind === 'folder') {
      try { await requireDirectory(directoryKey(job)); } catch (error) { await pauseForFolder(job, error instanceof Error ? error : new FolderPermissionError()); return; }
    }
    const records = await getMedia(job.id);
    for (const record of records) if (record.status === 'transferring' && (record.downloadId !== null || ['folder', 'zip'].includes(job.destination?.kind || ''))) await reconcileImage(record, true, job);
    const active = records.filter(r => r.status === 'transferring').length;
    const next = records.filter(r => r.status === 'queued' && r.nextAttemptAt <= Date.now()).slice(0, Math.max(0, transferLimit(job, 'discord') - active));
    if (next.length && Date.now() >= mediaNotBefore) {
      const results = await Promise.allSettled(next.map(record => startImage(record, job)));
      const failure = results.find(r => r.status === 'rejected');
      if (failure?.status === 'rejected') {
        if (failure.reason instanceof FolderPermissionError || failure.reason instanceof ZipStorageError) { await pauseForFolder(job, failure.reason); return; }
        throw failure.reason;
      }
      const delays = results.flatMap(r => r.status === 'fulfilled' ? [r.value] : []);
      job.mediaNextAt = Date.now() + Math.max(job.destination?.kind === 'zip' ? 250 : 1100, ...delays); await saveJob(job);
    }
    if (!records.some(r => r.status === 'queued' || r.status === 'transferring')) {
      if (job.destination?.kind === 'zip') { await prepareZip(job, records); return; }
      job.status = 'finished'; await saveJob(touch(job));
      if (job.autoManifest && job.manifestState === 'pending') await saveManifests(job, records);
    }
    if (job.destination?.kind === 'zip') {
      const queued = records.filter(r => r.status === 'queued');
      if (queued.length) {
        const due = Math.max(mediaNotBefore, job.mediaNextAt, Math.min(...queued.map(r => r.nextAttemptAt)));
        return Math.max(100, Math.min(1200, due - Date.now()));
      }
    }
    return;
  }
}
export async function recover(): Promise<void> {
  const groups = await Promise.all([getJobs(['downloading', 'paused']), getSavingJobs(), getManifestJobs()]);
  const jobs = new Map(groups.flat().map(job => [job.id, job]));
  for (const job of jobs.values()) {
    if (job.destination?.kind === 'zip') await reconcileZip(job, true);
    try {
      for (const record of await getMedia(job.id, ['transferring'])) await reconcileImage(record, true, job);
    } catch (error) {
      if (!(error instanceof FolderPermissionError || error instanceof ZipStorageError)) throw error;
      if (job.status === 'downloading') await pauseForFolder(job, error);
    }
    if (job.manifestState === 'saving') {
      if (job.destination?.kind === 'zip') continue;
      if (job.destination?.kind === 'folder') { job.manifestState = 'pending'; if (job.status === 'finished') job.status = 'downloading'; await saveJob(job); continue; }
      for (const download of job.manifestDownloads) {
        const [item] = await chrome.downloads.search({ id: download.id });
        download.state = item?.state === 'complete' ? 'complete' : item?.state === 'in_progress' ? 'in_progress' : 'interrupted';
      }
      // A worker may have stopped before recording all the intended manifest downloads.
      if (job.manifestDownloads.length !== job.channels.length + 1) { job.manifestState = 'pending'; if (job.status === 'finished') job.status = 'downloading'; }
      else if (job.manifestDownloads.every(d => d.state === 'complete')) job.manifestState = 'saved';
      else if (job.manifestDownloads.some(d => d.state === 'interrupted')) job.manifestState = 'failed';
      await saveJob(job);
    }
  }
}
export async function downloadChanged(delta: chrome.downloads.DownloadDelta): Promise<void> {
  if (!delta.state || !['complete', 'interrupted'].includes(delta.state.current || '')) return;
  for (const job of await getArchiveJobsForDownload(delta.id)) if (job.destination?.kind === 'zip') await reconcileZip(job);
  for (const record of await getMediaForDownload(delta.id)) if (record.status === 'transferring') await reconcileImage(record);
  for (const job of await getManifestJobs()) {
    const download = job.manifestDownloads.find(d => d.id === delta.id);
    if (download) {
      download.state = delta.state.current === 'complete' ? 'complete' : 'interrupted'; await release(download.blobUrl);
      if (job.manifestDownloads.length === job.channels.length + 1 && job.manifestDownloads.every(d => d.state === 'complete')) job.manifestState = 'saved';
      if (download.state === 'interrupted') job.manifestState = 'failed';
      await saveJob(touch(job));
    }
  }
  // Clean up ad hoc JSON/CSV export blobs too.
  const [item] = await chrome.downloads.search({ id: delta.id });
  if (item?.url.startsWith(`blob:chrome-extension://${chrome.runtime.id}/`)) await release(item.url);
}
