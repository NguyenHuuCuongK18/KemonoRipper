import '../ui/style.css';
import { getDirectory, saveDirectory, type ArchiveDirectory, type DirectoryPickerWindow } from '../storage/destination';
import type { Reply } from '../core/types';
import type { PostCommand } from '../services/posts/types';
import { creatorDirectory } from '../services/posts/destination';
import { creatorFolder } from '../services/posts/media';
import { assertSyncDirectory, canUseSyncDirectory, readSyncFile } from '../services/posts/syncDestination';

const jobId = new URLSearchParams(location.hash.slice(1)).get('jobId');
const status = document.getElementById('status')!;
const button = document.getElementById('choose') as HTMLButtonElement;
const allow = document.getElementById('allow') as HTMLButtonElement;
const back = document.getElementById('return') as HTMLButtonElement;
const openSync = document.getElementById('open-sync') as HTMLButtonElement;
const grantSync = document.getElementById('grant-sync') as HTMLButtonElement;
const syncStep = document.getElementById('sync-step')!;
button.disabled = true;
async function send<T>(message: PostCommand): Promise<T> {
  const reply: Reply<T> = await chrome.runtime.sendMessage(message);
  if (!reply?.ok) throw new Error(reply?.error || 'The archive service did not respond.'); return reply.data;
}
type Detail = ReturnType<typeof import('../services/posts/controller').postDetail>;
let detail: Detail | undefined, saved: { id: string; handle: ArchiveDirectory } | undefined;
let pendingSync: { file: FileSystemFileHandle } | undefined;
void (async () => {
  if (!jobId) throw new Error('Open the folder chooser from the archive overlay.');
  detail = await send<Detail>({ type: 'POST_DETAIL', jobId });
  document.getElementById('creator')!.textContent = `${detail.job.creatorName} · ${detail.job.source.platform}`;
  document.getElementById('folder-name')!.textContent = creatorFolder(detail.job);
  if (new URLSearchParams(location.hash.slice(1)).get('mode') === 'sync') document.getElementById('heading')!.textContent = 'Connect an existing archive';
  if (detail.job.destination?.kind === 'folder' && detail.job.destination.directoryId) {
    const handle = await getDirectory(detail.job.destination.directoryId);
    if (handle) { saved = { id: detail.job.destination.directoryId, handle }; allow.hidden = false; }
  }
  button.disabled = openSync.disabled = false;
})().catch(error => { status.textContent = error.message; });

function busy(value: boolean): void { button.disabled = allow.disabled = openSync.disabled = grantSync.disabled = value; }
function failed(error: unknown): void {
  if (error instanceof Error && error.name === 'AbortError') { status.textContent = 'Selection cancelled. Your download is unchanged.'; return; }
  status.textContent = error instanceof Error ? error.message : 'Could not connect the folder. Try again.';
}
async function connect(handle: ArchiveDirectory, directoryId: string, sync = false): Promise<void> {
  // Commit the granted handle before asking the writing context to acknowledge access.
  await saveDirectory(directoryId, handle);
  await send({ type: sync ? 'POST_SYNC_CONNECT' : 'POST_FOLDER', jobId: jobId!, directoryId, name: handle.name });
  saved = { id: directoryId, handle }; allow.hidden = false;
  detail = await send<Detail>({ type: 'POST_DETAIL', jobId: jobId! });
  const resume = detail.job.status === 'paused';
  if (resume) {
    await send({ type: 'POST_ACTION', jobId: jobId!, action: 'resume' });
    detail = await send<Detail>({ type: 'POST_DETAIL', jobId: jobId! });
    if (detail.job.status === 'paused') throw new Error(detail.job.error || 'The download is still paused. Try restoring access again.');
  }
  status.textContent = resume ? 'Folder access confirmed. Download resumed. Keep this tab open until saving finishes.' : sync ? 'Sync connected. Your post scope is unchanged. Return to the creator to save your selected posts. Keep this tab open until saving finishes.' : 'Folder connected. Return to the creator to save. Keep this tab open until saving finishes.';
  syncStep.hidden = true; pendingSync = undefined;
  back.hidden = false;
  // Closing the last top-level extension tab can revoke a session-only filesystem grant.
}
button.onclick = () => {
  if (!jobId || !detail || button.disabled) return;
  const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
  if (!picker) { status.textContent = 'This browser does not support folder access. Use a Chromium browser with the File System Access API enabled.'; return; }
  // Invoke the native API directly during the click's top-level user gesture.
  busy(true); status.textContent = 'Waiting for folder selection…';
  void (async () => {
    const handle = await creatorDirectory(await picker.call(window, { id: 'post-archive-folder', mode: 'readwrite' }), detail!.job);
    const same = saved && await handle.isSameEntry(saved.handle);
    await connect(handle, same ? saved!.id : crypto.randomUUID());
  })().catch(failed).finally(() => busy(false));
};
openSync.onclick = () => {
  if (!jobId || !detail || openSync.disabled) return;
  const picker = (window as DirectoryPickerWindow).showOpenFilePicker;
  if (!picker) { status.textContent = 'This browser does not support choosing an archive file. Choose the creator folder instead.'; return; }
  pendingSync = undefined; syncStep.hidden = true; allow.hidden = !saved;
  busy(true); status.textContent = 'Waiting for sync.json…';
  void (async () => {
    const [file] = await picker.call(window, { id: 'post-archive-sync', multiple: false, excludeAcceptAllOption: true, types: [{ description: 'Archive sync history', accept: { 'application/json': ['.json'] } }] });
    if (!file) throw new Error('Choose the archive’s sync.json file.');
    const index = await readSyncFile(file, detail!.job.source);
    pendingSync = { file };
    if (saved && await canUseSyncDirectory(saved.handle, file)) {
      await connect(saved.handle, saved.id, true); return;
    }
    document.getElementById('sync-description')!.textContent = `${file.name} · ${index.posts.length} saved posts · ${index.creatorName}`;
    syncStep.hidden = false; allow.hidden = true;
    status.textContent = 'History found. Click Allow archive folder to connect this archive.';
  })().catch(failed).finally(() => busy(false));
};
grantSync.onclick = () => {
  if (!pendingSync || grantSync.disabled) return;
  const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
  if (!picker) { status.textContent = 'This browser does not support folder access.'; return; }
  const { file } = pendingSync;
  busy(true); status.textContent = 'Waiting for archive folder access…';
  void (async () => {
    const handle = await picker.call(window, { id: 'post-archive-sync', mode: 'readwrite', startIn: file });
    await assertSyncDirectory(handle, file);
    const same = saved && await handle.isSameEntry(saved.handle);
    await connect(handle, same ? saved!.id : crypto.randomUUID(), true);
  })().catch(failed).finally(() => busy(false));
};
allow.onclick = () => {
  if (!saved || allow.disabled) return;
  const { id, handle } = saved;
  busy(true); status.textContent = 'Waiting for folder access…';
  void (async () => {
    const permission = await handle.requestPermission({ mode: 'readwrite' });
    if (permission !== 'granted') throw new Error('Folder access was declined. Allow access or choose the creator folder again.');
    await connect(handle, id);
  })().catch(failed).finally(() => busy(false));
};
back.onclick = () => {
  void (async () => {
    const current = await chrome.tabs.getCurrent();
    const tab = current?.openerTabId !== undefined ? await chrome.tabs.get(current.openerTabId).catch(() => undefined) : undefined;
    if (!tab?.id) { status.textContent = 'Return to the creator tab manually. Keep this folder access tab open until saving finishes.'; return; }
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
  })().catch(failed);
};
