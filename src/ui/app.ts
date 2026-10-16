import './style.css';
import type { Job, Reply, Summary } from '../core/types';
import { parseArchiveUrl } from '../core/urlParser';
import { parsePostUrl, postSourceUrl, serviceForUrl, supportedSite } from '../services/registry';
import type { PageContext, ServiceCommand } from '../services/router';
import type { PostSelection } from '../services/posts/types';
import { creatorFolder } from '../services/posts/media';
import type { CacheMaintenanceSettings } from '../storage/database';
import type { CacheItem, CacheList } from '../services/cacheMaintenance';
import { transferCeiling, type TransferPolicy } from '../core/transferConcurrency';

type PostView = ReturnType<typeof import('../services/posts/controller').postDetail>;
type DiscordView = { job: Omit<Job, 'channels'> & { channels: (Job['channels'][number] & { messageCount?: number })[] }; originalOrigins: string[]; hasDiscordCdn: boolean; totals: Summary };
type Recent = { id: string; service: 'posts' | 'discord'; sourceUrl: string; title: string; status: string };
document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <header><div><strong>Archive Ripper</strong><span class="local">Saved on your device</span></div><button id="close" class="icon" aria-label="Close">×</button></header>
  <main>
    <nav aria-label="Saving service"><span id="posts-service">Posts</span><span id="discord-service">Discord</span></nav>
    <section class="target"><h1 id="title">Reading this page…</h1><p id="subtitle" class="muted"></p><label for="scope" class="sr-only">What to save</label><select id="scope" hidden></select></section>
    <p id="notice" class="notice" role="status" hidden></p>
    <button id="scan-new" class="primary full" hidden>Scan this page</button>
    <section id="work" hidden>
      <div class="progress-heading"><span id="progress-label">Discovering posts</span><strong id="percent">0%</strong></div>
      <progress id="progress" max="100" value="0" aria-labelledby="progress-label" aria-describedby="count"></progress><p id="count" class="muted" role="status"></p><p id="transfer-progress" class="small muted" role="status" hidden></p><p id="summary" class="summary"></p><p id="archive-note" class="small muted" hidden></p>
      <fieldset id="options"><legend class="sr-only">Download options</legend><div id="quality-controls"><label for="quality">Save quality</label><select id="quality"><option value="thumbnail">Thumbnails</option><option value="full res">Full resolution</option><option id="best-quality" value="best" hidden>Best available</option></select></div>
        <div id="types" class="content-types"><label id="images-option"><input id="images" type="checkbox" checked>Images</label><label id="files-option" hidden><input id="files" type="checkbox" checked>Other files</label><label><input id="text" type="checkbox" checked>Post text</label></div>
        <label id="fallback-option" class="fallback-option" hidden><input id="fallback" type="checkbox" checked>Save thumbnail if unavailable</label><p id="quality-note" class="small muted"></p>
        <details id="file-types" hidden><summary>File types</summary><div class="actions"><button id="all-file-types" type="button">All types</button><button id="clear-file-types" type="button">Clear types</button></div><div id="file-type-options" class="content-types"></div></details>
        <label id="extract-option" class="fallback-option" hidden><input id="extract-archives" type="checkbox">Extract downloaded archives (ZIP, 7z, RAR, TAR)</label><p id="extract-note" class="small muted" hidden>Successful extraction keeps only the unpacked contents. If extraction fails, the compressed file is kept.</p>
        <div id="post-storage" hidden><div id="destination-label" class="small">Save to</div><div id="destination" class="destination-switch" role="radiogroup" aria-labelledby="destination-label" aria-describedby="folder-note"><label><input id="destination-folder" type="radio" name="destination" value="folder" checked><span>Creator folder</span></label><label><input id="destination-zip" type="radio" name="destination" value="zip"><span>ZIP file</span></label></div><div class="actions"><button id="choose-sync" type="button">Choose sync.json</button><button id="choose-folder" type="button">Change folder</button></div><p id="folder-note" class="small muted">Choose where to save this creator.</p></div>
      </fieldset>
      <button id="download" class="primary full" disabled>Download ZIP</button>
      <div class="actions"><button id="pause" hidden>Pause</button><button id="resume" hidden>Resume</button><button id="retry" hidden>Retry failures</button><button id="skip" hidden>Skip this error</button><button id="save-zip" hidden>Save ZIP again</button><button id="cancel" hidden>Cancel</button></div>
      <details id="post-list" hidden><summary id="post-list-label">Posts</summary><p id="post-selection-count" class="small muted"></p><fieldset id="post-picker"><legend class="sr-only">Posts to save</legend><div id="post-selection-actions" class="actions"><label><input id="all-posts" type="checkbox" checked>All posts</label><button id="clear-post-selection" type="button">Clear selection</button></div><ul id="posts"></ul></fieldset><button id="more" hidden>Show more</button></details>
      <details id="more-options"><summary>More options</summary><p id="transfer-policy" class="small muted"></p><div class="actions"><button id="rescan">Scan again</button><button id="import-sync" type="button">Import history only</button><button id="manifest">Export manifest</button></div><input id="sync-file" type="file" accept=".json,application/json" hidden></details>
    </section><details id="recent" hidden><summary>Recent jobs</summary><ul id="jobs"></ul></details>
    <details id="local-data"><summary>Storage &amp; history</summary><p id="local-data-count" class="small muted"></p><p class="small muted">Clear extension data to free space. Downloaded files, archive folders, and their sync.json files stay on disk.</p>
      <div class="cache-settings"><label><input id="clear-after-download" type="checkbox">Clear temporary data after a successful ZIP download</label><p class="small muted">Keeps the downloaded ZIP and job history. Another export will need to download the files again.</p><label><input id="auto-cleanup" type="checkbox" checked>Automatically clean unused ZIP data</label><label class="retention-label" for="cache-retention">Remove after <input id="cache-retention" type="number" min="1" max="10" step="1" value="5"> minutes without use</label><p class="small muted">Checks every minute. Active saves and paused downloads are kept.</p><p id="cleanup-status" class="small muted" role="status"></p></div>
      <div class="cache-heading"><strong>Temporary caches</strong><button id="refresh-caches" type="button">Refresh</button></div><p id="cache-summary" class="small muted" role="status">Open this section to check temporary storage.</p><ul id="caches" class="cache-list"></ul><button id="more-caches" type="button" hidden>Show more caches</button>
      <div class="actions"><button id="clear-cache" hidden>Clear this ZIP cache</button><button id="clear-job" hidden>Remove this job</button><button id="clear-all">Clear all extension data</button></div>
      <section id="clear-confirm" class="clear-confirm" aria-label="Confirm data cleanup" hidden><p id="clear-description"></p><div class="actions"><button id="confirm-clear" class="danger">Clear data</button><button id="cancel-clear">Cancel</button></div></section>
    </details>
  </main>`;
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const select = (id: string) => el<HTMLSelectElement>(id);
const check = (id: string) => el<HTMLInputElement>(id);
function destination(): 'folder' | 'zip' { return check('destination-zip').checked ? 'zip' : 'folder'; }
function setDestination(value: 'folder' | 'zip'): void { check(`destination-${value}`).checked = true; }
let context: PageContext | null = null, sourceUrl = '';
let service: 'posts' | 'discord' | null = null, selected: string | null = null;
let post: PostView | null = null, discord: DiscordView | null = null;
let busy = false, refreshing = false, limit = 100, optionsJob: string | null = null;
let cleanup: { scope: 'all' } | { scope: 'job'; jobId: string } | { scope: 'cache'; jobId: string } | null = null;
let cacheData: CacheList = { caches: [], bytes: 0 }, cacheLimit = 50;
let cacheRequest: Promise<void> | null = null, postRowsKey = '';
let postErrorNotice = '';
let excludedFileTypes = new Set<string>(), fileTypesKey = '';
async function send<T>(message: ServiceCommand): Promise<T> {
  const reply: Reply<T> = await chrome.runtime.sendMessage(message);
  if (!reply?.ok) throw new Error(reply?.error || 'The archive service did not respond.'); return reply.data;
}
function notice(message: string): void { el('notice').textContent = message; el('notice').hidden = !message; }
async function run(work: () => Promise<void>): Promise<void> {
  if (busy) return; busy = true; document.body.classList.add('busy'); notice('');
  try { await work(); await refresh(); } catch (error) { notice(error instanceof Error ? error.message : 'This operation failed.'); }
  finally { busy = false; document.body.classList.remove('busy'); queueRefresh(); }
}
function close(): void { if (window.parent !== window) window.parent.postMessage({ type: 'ARCHIVE_OVERLAY_CLOSE' }, '*'); else window.close(); }
el('close').onclick = close; document.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
function progress(label: string, value: number | null, count: string): void {
  el('progress-label').textContent = label; const bar = el<HTMLProgressElement>('progress');
  if (value === null) { bar.removeAttribute('value'); el('percent').textContent = '…'; }
  else { bar.value = Math.max(0, Math.min(100, value)); el('percent').textContent = `${Math.floor(bar.value)}%`; }
  el('count').textContent = count;
}
function selection(): PostSelection { return { quality: 'full res', fallbackToThumbnail: check('fallback').checked && check('images').checked, images: check('images').checked, files: check('files').checked, text: check('text').checked, excludedFileTypes: [...excludedFileTypes].sort(), extractArchives: check('extract-archives').checked }; }
function renderFileTypes(view: PostView): void {
  const key = JSON.stringify([view.fileTypes, [...excludedFileTypes].sort()]); if (key === fileTypesKey) return; fileTypesKey = key;
  el('file-type-options').replaceChildren(...view.fileTypes.map(({ type, count }) => {
    const label = document.createElement('label'), input = document.createElement('input');
    input.type = 'checkbox'; input.dataset.fileType = type; input.checked = !excludedFileTypes.has(type);
    label.append(input, `${type === 'unknown' ? 'Unknown' : '.' + type} (${count})`); return label;
  }));
}
el('file-type-options').onchange = event => {
  const input = event.target as HTMLInputElement, type = input.dataset.fileType; if (!type) return;
  if (input.checked) excludedFileTypes.delete(type); else excludedFileTypes.add(type);
};
el('all-file-types').onclick = () => { excludedFileTypes.clear(); if (post) renderFileTypes(post); };
el('clear-file-types').onclick = () => { for (const item of post?.fileTypes || []) excludedFileTypes.add(item.type); if (post) renderFileTypes(post); };
function options(): void {
  const thumbnail = select('quality').value === 'thumbnail';
  el('types').hidden = service !== 'posts'; el('files-option').hidden = service !== 'posts' || !post?.totals.files;
  el('file-types').hidden = service !== 'posts'; el('extract-option').hidden = service !== 'posts'; el('extract-note').hidden = service !== 'posts';
  el('images-option').hidden = service === 'posts' && !post?.totals.images;
  el('quality-controls').hidden = service === 'posts'; el('best-quality').hidden = service !== 'discord';
  el('fallback-option').hidden = service !== 'posts' || !post?.totals.images;
  check('fallback').disabled = !check('images').checked;
  el('import-sync').hidden = service !== 'posts';
  el('post-storage').hidden = service !== 'posts';
  el('choose-sync').hidden = destination() !== 'folder';
  check('destination-zip').disabled = !!post?.totals.syncPosts;
  if (check('destination-zip').disabled) setDestination('folder');
  el('choose-folder').hidden = destination() !== 'folder' || post?.job.destination?.kind !== 'folder' || !post.job.destination.directoryId;
  el('choose-folder').textContent = post?.job.error?.startsWith('Folder access is required.') ? 'Restore folder access' : 'Change folder';
  el('folder-note').textContent = destination() === 'zip' ? 'Includes sync.json for future folder updates.' : post?.job.destination?.kind === 'folder' && post.job.destination.name ? `${post.job.destination.name}${post.totals.syncPosts ? ' · Sync updates this folder.' : ''}` : post ? `Creates ${creatorFolder(post.job)}/, or updates an existing archive.` : 'Choose where to save this creator.';
  el('quality-note').textContent = service === 'posts' ? check('images').checked && check('fallback').checked ? 'Full resolution by default. Missing originals use thumbnails, saved separately.' : 'Full resolution. Unavailable originals are reported.' : thumbnail ? 'Save surviving image previews.' : 'Only available originals can be saved.';
  const subset = post && !post.allPostsSelected;
  el('download').textContent = service === 'posts' && destination() === 'folder' ? post?.job.destination?.kind === 'folder' && post.job.destination.directoryId ? post.job.source.postId ? 'Save this post' : subset ? 'Save selected posts' : post.totals.syncPosts ? 'Sync folder' : 'Save to folder' : 'Choose save location' : service === 'posts' && post?.job.source.postId ? 'Save this post as ZIP' : service === 'posts' && subset ? 'Download selected posts as ZIP' : 'Download ZIP';
}
select('quality').onchange = options;
check('images').onchange = options;
check('fallback').onchange = options;
for (const kind of ['folder', 'zip']) check(`destination-${kind}`).onchange = options;
function renderCacheSettings(settings: CacheMaintenanceSettings): void {
  check('clear-after-download').checked = !!settings.clearAfterDownload;
  check('auto-cleanup').checked = settings.retentionMinutes > 0;
  check('cache-retention').disabled = !settings.retentionMinutes;
  if (settings.retentionMinutes) check('cache-retention').value = String(settings.retentionMinutes);
  el('cleanup-status').textContent = !settings.retentionMinutes && !settings.clearAfterDownload ? 'Automatic cleanup is off.' : settings.lastCheckAt
    ? `Last check: ${new Date(settings.lastCheckAt).toLocaleTimeString()} · ${settings.removedCaches} temporary caches removed.` : 'Automatic cleanup is on. The first check runs shortly.';
}
async function updateCacheSettings(): Promise<void> {
  const minutes = Number(check('cache-retention').value);
  if (check('auto-cleanup').checked && (!Number.isInteger(minutes) || minutes < 1 || minutes > 10)) { check('cache-retention').reportValidity(); return; }
  renderCacheSettings(await send<CacheMaintenanceSettings>({ type: 'LOCAL_SETTINGS', retentionMinutes: check('auto-cleanup').checked ? minutes : 0, clearAfterDownload: check('clear-after-download').checked }));
}
function saveCachePreferences(): void { void updateCacheSettings().catch(error => notice(error instanceof Error ? error.message : 'Could not save cleanup settings.')); }
check('auto-cleanup').onchange = saveCachePreferences;
check('cache-retention').onchange = saveCachePreferences;
check('clear-after-download').onchange = saveCachePreferences;
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB']; let value = bytes / 1024, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}
function confirmCacheRemoval(jobId: string, title: string): void {
  cleanup = { scope: 'cache', jobId };
  el('clear-description').textContent = `Remove temporary data for “${title}”? Downloaded files and job history stay on disk. Another ZIP export will need to download the files again.`;
  el('confirm-clear').textContent = 'Remove cache'; el('clear-confirm').hidden = false;
  el('clear-confirm').scrollIntoView({ block: 'nearest' }); el('confirm-clear').focus();
}
function renderCaches(): void {
  el('cache-summary').textContent = cacheData.caches.length ? `${cacheData.caches.length} temporary ${cacheData.caches.length === 1 ? 'cache' : 'caches'} · ${formatBytes(cacheData.bytes)}` : 'No temporary files stored.';
  el('caches').replaceChildren(...cacheData.caches.slice(0, cacheLimit).map((cache: CacheItem) => {
    const row = document.createElement('li'), info = document.createElement('div'), title = document.createElement('strong'), meta = document.createElement('small'), button = document.createElement('button');
    row.dataset.cacheId = cache.id; title.textContent = cache.title;
    meta.textContent = `${cache.service === 'orphan' ? 'Unused' : cache.service === 'posts' ? 'Posts' : 'Discord'} · ${formatBytes(cache.bytes)} · ${cache.files} files${cache.lastUsedAt ? ` · Last used ${new Date(cache.lastUsedAt).toLocaleTimeString()}` : ''}${cache.protected ? ' · In use or paused' : ''}${cache.error ? ' · Size may be incomplete' : ''}`;
    button.type = 'button'; button.textContent = 'Remove'; button.disabled = cache.protected;
    button.setAttribute('aria-label', `Remove cache for ${cache.title}`);
    if (cache.protected) button.title = 'Finish or cancel this job to remove its temporary data.';
    button.onclick = () => confirmCacheRemoval(cache.id, cache.title);
    info.append(title, meta); row.append(info, button); return row;
  }));
  el('more-caches').hidden = cacheData.caches.length <= cacheLimit;
}
async function refreshCaches(force = false): Promise<void> {
  if (cacheRequest) { await cacheRequest.catch(() => {}); if (!force) return; }
  el<HTMLButtonElement>('refresh-caches').disabled = true;
  if (!cacheData.caches.length) el('cache-summary').textContent = 'Checking temporary storage…';
  cacheRequest = (async () => { cacheData = await send<CacheList>({ type: 'CACHE_LIST' }); renderCaches(); })();
  try { await cacheRequest; }
  catch (error) { el('cache-summary').textContent = error instanceof Error ? error.message : 'Could not inspect temporary storage.'; }
  finally { cacheRequest = null; el<HTMLButtonElement>('refresh-caches').disabled = false; }
}
el('refresh-caches').onclick = () => void refreshCaches(true);
el('more-caches').onclick = () => { cacheLimit += 50; renderCaches(); };
el('local-data').ontoggle = () => {
  if (el<HTMLDetailsElement>('local-data').open) {
    void send<CacheMaintenanceSettings>({ type: 'LOCAL_STATUS' }).then(renderCacheSettings).catch(() => {});
    void refreshCaches();
  }
};
async function chooseFolder(mode: 'folder' | 'sync' = 'folder'): Promise<void> {
  if (!selected) return;
  const tab = await chrome.tabs.getCurrent();
  await chrome.tabs.create({ url: chrome.runtime.getURL(`folder/index.html#jobId=${encodeURIComponent(selected)}&mode=${mode}`), ...(tab?.id !== undefined ? { openerTabId: tab.id } : {}) });
}
el('choose-folder').onclick = () => void run(chooseFolder);
el('choose-sync').onclick = () => void run(() => chooseFolder('sync'));
el('import-sync').onclick = () => check('sync-file').click();
check('sync-file').onchange = () => void run(async () => {
  const file = check('sync-file').files?.[0]; check('sync-file').value = '';
  if (!file || !selected) return;
  if (file.size > 32 * 1024 * 1024) throw new Error('The sync JSON exceeds the 32 MiB limit.');
  await send({ type: 'POST_SYNC_IMPORT', jobId: selected, json: JSON.parse(await file.text()) });
  optionsJob = null; setDestination('folder');
  await recentJobs();
});
function choosePostSelection(postId: string | undefined, selectedPost: boolean): void {
  if (!selected || !post || busy) return;
  el<HTMLFieldSetElement>('post-picker').disabled = true;
  void run(async () => { await send({ type: 'POST_SELECT', jobId: selected!, ...(postId === undefined ? {} : { postId }), selected: selectedPost }); })
    .finally(() => { postRowsKey = ''; if (post) renderPost(post); });
}
check('all-posts').onchange = () => choosePostSelection(undefined, check('all-posts').checked);
el('clear-post-selection').onclick = () => choosePostSelection(undefined, false);
el('posts').onchange = event => {
  const input = event.target;
  if (input instanceof HTMLInputElement && input.dataset.postId) choosePostSelection(input.dataset.postId, input.checked);
};
async function start(): Promise<void> {
  if (!service) return; post = null; discord = null; optionsJob = null;
  cleanup = null; el('clear-confirm').hidden = true;
  selected = (await send<{ jobId: string }>(service === 'posts' ? { type: 'POST_START', url: sourceUrl, expectedPosts: parsePostUrl(sourceUrl)?.postId ? 1 : context?.expectedPosts } : { type: 'START', url: sourceUrl, channelIds: [], allChannels: !parseArchiveUrl(sourceUrl)?.channelId, mode: 'thumbnail', tryOriginal: false })).jobId;
  el('scan-new').hidden = true;
  await recentJobs();
}
el('scan-new').onclick = () => void run(start);
function resetView(): void {
  selected = null; post = null; discord = null; optionsJob = null; limit = 100;
  el('work').hidden = true; el('scan-new').hidden = !service;
  el('clear-job').hidden = true; el('clear-cache').hidden = true;
  if (context && service) {
    const scope = parsePostUrl(context.url), archive = parseArchiveUrl(context.url);
    sourceUrl = scope ? postSourceUrl(scope) : `${new URL(context.url).origin}/discord/server/${archive!.serverId}${archive!.channelId ? '/' + archive!.channelId : ''}`;
    select('scope').value = scope ? scope.postId ? 'post' : 'profile' : archive?.channelId ? 'channel' : 'server';
    el('title').textContent = 'Ready to scan'; el('subtitle').textContent = 'Scan this page to discover its archived content.';
  }
}
function confirmCleanup(scope: 'job' | 'all'): void {
  if (scope === 'job' && !selected) return;
  cleanup = scope === 'all' ? { scope } : { scope, jobId: selected! };
  el('clear-description').textContent = scope === 'all'
    ? 'Stop all jobs and remove all extension history, cached files, imported sync history, and saved folder connections? Your downloaded archives and sync.json files stay on disk.'
    : 'Stop this job and remove its history and cached files? Its folder connection is forgotten if no other job uses it. Your downloaded archives and sync.json files stay on disk.';
  el('confirm-clear').textContent = scope === 'all' ? 'Clear all extension data' : 'Remove this job';
  el('clear-confirm').hidden = false; el('confirm-clear').focus();
}
el('clear-job').onclick = () => confirmCleanup('job');
el('clear-all').onclick = () => confirmCleanup('all');
el('cancel-clear').onclick = () => { cleanup = null; el('clear-confirm').hidden = true; };
el('confirm-clear').onclick = () => void run(async () => {
  const target = cleanup; if (!target) return;
  if (target.scope === 'cache') await send({ type: 'CACHE_REMOVE', jobId: target.jobId });
  else await send({ type: 'LOCAL_CLEAR', ...target });
  cleanup = null; el('clear-confirm').hidden = true;
  if (target.scope === 'all' || (target.scope === 'job' && target.jobId === selected)) resetView();
  await recentJobs();
  if (target.scope === 'all') renderCacheSettings(await send<CacheMaintenanceSettings>({ type: 'LOCAL_STATUS' }));
  await refreshCaches(true);
  notice(target.scope === 'all' ? 'Extension data cleared. Your downloaded files are unchanged.' : target.scope === 'cache' ? 'Temporary cache removed. Downloaded files and job history are kept.' : 'Job and cached files removed. Your downloaded files are unchanged.');
});
select('scope').onchange = () => void run(async () => {
  if (!context) return; const scope = parsePostUrl(context.url);
  if (scope) sourceUrl = postSourceUrl({ ...scope, postId: select('scope').value === 'post' ? scope.postId : null });
  else { const parsed = parseArchiveUrl(context.url)!; sourceUrl = `${new URL(context.url).origin}/discord/server/${parsed.serverId}${select('scope').value === 'channel' ? '/' + parsed.channelId : ''}`; }
  await start();
});
el('rescan').onclick = () => void run(async () => { if (service === 'posts' && selected) await send({ type: 'POST_ACTION', jobId: selected, action: 'rescan' }); else await start(); });
el('download').onclick = () => {
  if (service === 'posts' && destination() === 'folder' && (post?.job.destination?.kind !== 'folder' || !post.job.destination.directoryId)) { void run(chooseFolder); return; }
  // Original-host access must begin within the button's user gesture.
  const origins: string[] = [];
  if (service === 'posts' || select('quality').value !== 'thumbnail') {
    if (service === 'posts') origins.push(...(post?.originalOrigins || []));
    else origins.push(...(discord?.originalOrigins || []));
    if (service === 'discord' && discord?.hasDiscordCdn) origins.push('https://cdn.discordapp.com/*', 'https://media.discordapp.net/*');
  }
  const permission = origins.length ? chrome.permissions.request({ origins }) : Promise.resolve(true);
  void run(async () => {
    if (!selected) return; if (!await permission) throw new Error(service === 'posts' ? 'Allow access to the image server to save originals.' : 'Original-host access was declined. Choose Thumbnails to continue.');
    if (service === 'posts') await send({ type: 'POST_DOWNLOAD', jobId: selected, selection: selection(), destination: destination() });
    else { if (discord?.job.destination?.kind !== 'zip') await send({ type: 'DESTINATION', jobId: selected, kind: 'zip' }); await send({ type: 'DISCORD_DOWNLOAD', jobId: selected, quality: select('quality').value as 'thumbnail' | 'full res' | 'best' }); }
  });
};
for (const action of ['pause', 'resume', 'retry', 'skip', 'save-zip', 'cancel'] as const) el(action).onclick = () => void run(async () => {
  if (action === 'resume' && service === 'posts' && post?.job.error?.startsWith('Folder access is required.')) { await chooseFolder(); return; }
  if (action === 'skip') { if (selected && service === 'posts') await send({ type: 'POST_ACTION', jobId: selected, action }); return; }
  if (selected) await send(service === 'posts' ? { type: 'POST_ACTION', jobId: selected, action } : { type: 'ACTION', jobId: selected, action });
});
el('clear-cache').onclick = () => { if (selected) confirmCacheRemoval(selected, el('title').textContent || 'this job'); };
el('manifest').onclick = () => void run(async () => { if (!selected) return; if (service === 'discord') await send({ type: 'EXPORT', jobId: selected, format: 'json' }); else notice('The post manifest and failure report are included in the ZIP.'); });
el('more').onclick = () => void run(async () => { limit += 100; });
function common(status: string, archive: Job['archive'], failed: number, canDownload: boolean, policy?: TransferPolicy): void {
  const active = ['scanning', 'downloading'].includes(status), saving = archive?.state === 'saving';
  const limit = Math.min(policy?.limit || 2, transferCeiling(service === 'posts' ? 'posts' : 'discord'));
  el('transfer-policy').textContent = `Download speed adjusts automatically. Current limit: ${limit} ${limit === 1 ? 'file' : 'files'} at once.`;
  el<HTMLFieldSetElement>('options').disabled = active || saving; el<HTMLButtonElement>('download').disabled = !canDownload || active || saving;
  el('pause').hidden = !active; el('resume').hidden = status !== 'paused'; el('cancel').hidden = !active && status !== 'paused' && !saving;
  el('skip').hidden = service !== 'posts' || !post?.canSkipError;
  el('retry').hidden = !failed && !(service === 'posts' ? post?.job.scan.error || post?.totals.discoveryFailures : discord?.job.channels.some(channel => channel.coverage === 'incomplete'));
  el<HTMLButtonElement>('retry').disabled = active || saving;
  el('save-zip').hidden = !archive || archive.cacheCleared === true || !['ready', 'saved'].includes(archive.state); el('clear-cache').hidden = !archive || archive.cacheCleared === true;
  el('archive-note').hidden = !archive?.cacheCleared;
  el('archive-note').textContent = archive?.cacheCleared ? 'ZIP saved. Temporary copy cleared; downloading again creates a new ZIP.' : '';
  el('clear-job').hidden = !selected;
  el('manifest').hidden = service === 'posts';
  el<HTMLButtonElement>('clear-cache').disabled = active || saving || status === 'paused'; el<HTMLButtonElement>('rescan').disabled = active || saving;
  el<HTMLButtonElement>('import-sync').disabled = active || saving;
  if (archive?.state === 'saving') el('count').textContent = 'Choose where to save the ZIP.';
  if (archive?.error || archive?.cacheCleanupError) notice(archive.error || archive.cacheCleanupError!); options();
}
function downloadProgress(archive: Job['archive'], saved: number, processed: number, total: number, failed: number): void {
  let value = total ? processed / total * 85 : 85, label = 'Downloading';
  if (archive?.state === 'building') { label = 'Preparing ZIP'; value = 85 + (archive.total ? archive.progress / archive.total * 14 : 0); }
  if (archive && ['ready', 'saving'].includes(archive.state)) { label = 'ZIP ready'; value = 99; }
  if (archive?.state === 'saved') { label = 'Saved'; value = 100; }
  progress(label, value, `${archive?.state === 'saved' ? 'Saved' : 'Collected'}: ${saved}/${total} files${failed ? ` · ${failed} unavailable` : ''}`);
}
function renderPost(view: PostView): void {
  const { job, totals } = view;
  const transferText = job.status === 'downloading' ? view.activeTransfers.slice(0, 3).map(({ name, progress }) => {
    if (!progress || progress.phase === 'connecting') return `Connecting: ${name}`;
    if (progress.phase === 'validating') return `Checking: ${name} · ${formatBytes(progress.receivedBytes)}`;
    return `${name}: ${formatBytes(progress.receivedBytes)}${progress.totalBytes ? ` / ${formatBytes(progress.totalBytes)}` : ''}${Date.now() - progress.updatedAt > 30_000 ? ' · Waiting for data' : ''}`;
  }).join(' · ') || (view.retryAt > Date.now() ? `Waiting to retry in ${Math.ceil((view.retryAt - Date.now()) / 1000)} seconds.` : '') : '';
  el('transfer-progress').textContent = transferText; el('transfer-progress').hidden = !transferText;
  if (sourceUrl !== job.sourceUrl) { sourceUrl = job.sourceUrl; select('scope').value = job.source.postId ? 'post' : 'profile'; }
  el('title').textContent = job.source.postId ? view.posts[0]?.title || 'This post' : job.creatorName;
  el('subtitle').textContent = `${job.source.platform === 'fanbox' ? 'Pixiv Fanbox' : 'Patreon'} · ${job.source.postId ? job.creatorName : 'Entire profile'}`;
  const optionsKey = job.id + (job.destination?.kind === 'folder' ? job.destination.directoryId : 'zip') + JSON.stringify(job.selection);
  if (optionsJob !== optionsKey) { optionsJob = optionsKey; check('fallback').checked = job.selection.fallbackToThumbnail ?? true; check('images').checked = job.selection.images; check('files').checked = job.selection.files; check('text').checked = job.selection.text; check('extract-archives').checked = job.selection.extractArchives ?? false; excludedFileTypes = new Set(job.selection.excludedFileTypes || []); setDestination(job.destination?.kind || 'zip'); }
  renderFileTypes(view);
  if (!job.scan.complete) progress(job.status === 'paused' ? 'Discovery paused' : job.status === 'cancelled' ? 'Discovery cancelled' : 'Discovering posts', totals.total ? Math.min(99, totals.discovered / totals.total * 100) : null, `Discovered: ${totals.discovered}/${totals.total ?? '…'} posts`);
  else if (job.archive) downloadProgress(job.archive, totals.saved, totals.processed, totals.selected, totals.failed);
  else if (totals.selected) progress(job.status === 'finished' ? 'Saved' : job.status === 'paused' ? 'Download paused' : job.status === 'cancelled' ? 'Download cancelled' : 'Saving to folder', totals.processed / totals.selected * 100, `Saved: ${totals.saved}/${totals.selected} files${totals.synced ? ` · ${totals.synced} already saved` : ''}${totals.failed ? ` · ${totals.failed} unavailable` : ''}`);
  else progress(totals.discoveryFailures ? 'Ready to save available posts' : 'Ready to save', 100, `Discovered: ${totals.posts}/${totals.total ?? totals.posts} posts`);
  el('summary').textContent = [totals.images ? `${totals.images} images` : '', totals.files ? `${totals.files} other files` : ''].filter(Boolean).join(' · ');
  if (totals.thumbnails) el('summary').textContent += ` · ${totals.thumbnails} saved as thumbnails`;
  if (totals.extracting) el('summary').textContent += ' · Extracting archives';
  if (totals.extracted) el('summary').textContent += ` · ${totals.extracted} unpacked files`;
  if (totals.extractionFailures) el('summary').textContent += ` · ${totals.extractionFailures} extraction errors (originals kept; see failures.json)`;
  if (totals.discoveryFailures) el('summary').textContent += `${el('summary').textContent ? ' · ' : ''}${totals.discoveryFailures} discovery errors. Available content can be saved; details are in failures.json.`;
  if (totals.syncPosts && !totals.selected) el('summary').textContent += `${el('summary').textContent ? ' · ' : ''}${totals.newPosts} new posts`;
  el('post-list').hidden = !view.posts.length; el('post-list-label').textContent = `Posts (${view.posts.length < totals.posts ? view.posts.length + '/' : ''}${totals.posts})`;
  el('post-selection-actions').hidden = !!job.source.postId;
  el('post-selection-count').textContent = job.source.postId ? 'Only this post will be saved. Archive history keeps your earlier posts.' : `${totals.selectedPosts}/${totals.posts} posts selected. Only selected posts will be saved.`;
  check('all-posts').checked = view.allPostsSelected;
  check('all-posts').indeterminate = !view.allPostsSelected && totals.selectedPosts > 0;
  el<HTMLFieldSetElement>('post-picker').disabled = busy || !job.scan.complete || ['scanning', 'downloading'].includes(job.status) || job.archive?.state === 'saving' || job.status === 'paused' && totals.selected > 0;
  const rowsKey = job.id + JSON.stringify(view.posts);
  if (rowsKey !== postRowsKey) {
    postRowsKey = rowsKey;
    el('posts').replaceChildren(...view.posts.map(item => {
      const row = document.createElement('li'), title = document.createElement('span'), count = document.createElement('small');
      title.textContent = item.title; title.title = item.title; count.textContent = `${item.files} files`;
      if (job.source.postId) row.append(title);
      else {
        const label = document.createElement('label'), input = document.createElement('input');
        input.type = 'checkbox'; input.dataset.postId = item.id; input.checked = item.selected;
        label.append(input, title); row.append(label);
      }
      row.append(count); return row;
    }));
  }
  el('more').hidden = totals.posts <= view.posts.length || view.posts.length >= 1000;
  if (job.error) notice(job.error);
  else if (postErrorNotice && el('notice').textContent === postErrorNotice) notice('');
  postErrorNotice = job.error || '';
  common(job.status, job.archive, totals.retryable, job.scan.complete && (totals.selectedPosts > 0 || totals.discoveryFailures > 0 && view.allPostsSelected), job.transferPolicy);
}
function renderDiscord(view: DiscordView): void {
  el('transfer-progress').hidden = true;
  const { job, totals } = view;
  el('title').textContent = job.serverName || 'Discord archive'; el('subtitle').textContent = job.channels.length === 1 ? job.channels[0].channelName || 'Current channel' : 'Entire server';
  if (optionsJob !== job.id) { optionsJob = job.id; select('quality').value = job.mode === 'original' ? 'full res' : job.mode; }
  const settled = job.channels.filter(channel => ['complete', 'incomplete'].includes(channel.coverage)).length;
  const scanned = job.channels.reduce((n, channel) => n + (['complete', 'incomplete'].includes(channel.coverage) ? 1 : channel.postCount && channel.postCount > 0 ? Math.min(.95, (channel.messageCount ?? channel.messageIds.length) / channel.postCount) : 0), 0);
  if (job.autoManifest || job.archive) downloadProgress(job.archive, totals.downloaded + totals.staged, totals.downloaded + totals.staged + totals.failed + totals.skipped, totals.discovered, totals.failed + totals.skipped);
  else progress(settled === job.channels.length ? 'Ready to save' : job.status === 'paused' ? 'Discovery paused' : 'Discovering images', Math.floor(scanned / Math.max(1, job.channels.length) * 100), `Discovered: ${totals.discovered} images`);
  el('summary').textContent = totals.failed ? `${totals.failed} files need a retry.` : ''; el('post-list').hidden = true;
  if (job.channels.some(channel => channel.coverage === 'incomplete')) notice('Some content could not be scanned. Retry failures or save the available results.');
  if (job.destinationError) notice(job.destinationError); common(job.status, job.archive, totals.failed + totals.skipped, ['indexed', 'finished'].includes(job.status), job.transferPolicy);
}
async function refresh(): Promise<void> {
  if (!selected || refreshing) return; refreshing = true;
  const id = selected;
  try {
    if (service === 'posts') { const view = await send<PostView>({ type: 'POST_DETAIL', jobId: id, limit }); if (selected !== id) return; post = view; renderPost(post); }
    else { const view = await send<DiscordView>({ type: 'DETAIL', jobId: id, includeMedia: false }); if (selected !== id) return; discord = view; renderDiscord(discord); }
    el('work').hidden = false; el('scan-new').hidden = true;
  } catch (error) {
    if (selected !== id) return;
    const jobs = await recentJobs();
    if (!jobs.some(job => job.id === id)) { resetView(); notice('This job was removed. Scan this page to start again.'); }
    else throw error;
  }
  finally { refreshing = false; }
}
async function recentJobs(): Promise<Recent[]> {
  const allJobs = await send<Recent[]>({ type: 'SERVICE_JOBS' });
  el('local-data-count').textContent = `${allJobs.length} saved ${allJobs.length === 1 ? 'job' : 'jobs'} across Posts and Discord.`;
  const jobs = allJobs.filter(job => job.service === service && job.sourceUrl && new URL(job.sourceUrl).origin === new URL(sourceUrl).origin);
  el('recent').hidden = !jobs.length;
  el('jobs').replaceChildren(...jobs.slice(0, 8).map(job => { const row = document.createElement('li'), button = document.createElement('button'); button.textContent = `${job.title} · ${job.status}`; button.onclick = () => void run(async () => { cleanup = null; el('clear-confirm').hidden = true; selected = job.id; sourceUrl = job.sourceUrl; limit = 100; optionsJob = null; const scope = parsePostUrl(sourceUrl); select('scope').value = scope ? scope.postId ? 'post' : 'profile' : parseArchiveUrl(sourceUrl)?.channelId ? 'channel' : 'server'; }); row.append(button); return row; }));
  return jobs;
}
void run(async () => {
  renderCacheSettings(await send<CacheMaintenanceSettings>({ type: 'LOCAL_STATUS' }));
  context = await send<PageContext | null>({ type: 'PAGE_CONTEXT' });
  if (!context) { const url = new URLSearchParams(location.hash.slice(1)).get('url'); if (url && supportedSite(url)) context = { url, expectedPosts: null }; }
  service = serviceForUrl(context?.url || '');
  if (!context || !service) { el('title').textContent = 'Open a profile, post, or Discord archive'; el('subtitle').textContent = 'Works on kemono.cr and pawchive.pw.'; return; }
  el(`${service}-service`).classList.add('active');
  const postScope = parsePostUrl(context.url), discordScope = parseArchiveUrl(context.url);
  sourceUrl = postScope ? postSourceUrl(postScope) : `${new URL(context.url).origin}/discord/server/${discordScope!.serverId}${discordScope!.channelId ? '/' + discordScope!.channelId : ''}`;
  if (postScope?.postId || discordScope?.channelId) { const choices = postScope ? [['post', 'This post only'], ['profile', 'Entire creator profile']] : [['channel', 'This channel only'], ['server', 'Entire Discord server']]; select('scope').replaceChildren(...choices.map(([value, label]) => new Option(label, value))); el('scope').hidden = false; }
  const jobs = await recentJobs(); selected = jobs.find(job => job.sourceUrl === sourceUrl)?.id || null; if (!selected) await start();
});
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
function queueRefresh(immediate = false): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  if (document.hidden) { refreshTimer = undefined; return; }
  const job = service === 'posts' ? post?.job : discord?.job;
  const active = job && (['scanning', 'downloading'].includes(job.status) || ['building', 'saving'].includes(job.archive?.state || ''));
  refreshTimer = setTimeout(async () => {
    try { if (!busy) await refresh(); }
    catch (error) { notice(error instanceof Error ? error.message : 'Could not refresh progress.'); }
    finally { queueRefresh(); }
  }, immediate ? 0 : active ? 1000 : 5000);
}
document.addEventListener('visibilitychange', () => queueRefresh(true));
queueRefresh(true);
