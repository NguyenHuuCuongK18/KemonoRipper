import type { Reply } from '../core/types';
import { FolderPermissionError } from '../storage/destination';
import { ZipStorageError } from '../storage/zipCache';
let opening: Promise<void> | undefined;
export async function offscreen<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  if (!(await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] })).length) {
    opening ||= chrome.offscreen.createDocument({ url: 'offscreen/index.html', reasons: [chrome.offscreen.Reason.BLOBS], justification: 'Validate archived image bytes, decode dimensions, and create local blob URLs for browser downloads and exports.' }).finally(() => { opening = undefined; });
    await opening;
  }
  const reply: Reply<T> = await chrome.runtime.sendMessage({ target: 'offscreen', action, ...payload });
  if (!reply?.ok) {
    if (reply?.error === new FolderPermissionError().message) throw new FolderPermissionError();
    if (reply?.error === new ZipStorageError().message) throw new ZipStorageError();
    throw new Error(reply?.error || 'Image validator did not respond');
  }
  return reply.data;
}
export async function release(blobUrl: string | null): Promise<void> { if (blobUrl) await offscreen('release', { url: blobUrl }).catch(() => {}); }
export async function saveText(text: string, filename: string, mime = 'application/json', overwrite = false): Promise<{ id: number; blobUrl: string }> {
  const { blobUrl } = await offscreen<{ blobUrl: string }>('export', { text, mime });
  try { return { id: await chrome.downloads.download({ url: blobUrl, filename, conflictAction: overwrite ? 'overwrite' : 'uniquify', saveAs: false }), blobUrl }; }
  catch (error) { await release(blobUrl); throw error; }
}
