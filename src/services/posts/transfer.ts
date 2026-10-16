import { detectImage } from '../../core/mediaResolver';
import { retryAfter } from '../../api/kemonoClient';
import { stageImage, stagedFile, stageStream } from '../../storage/zipCache';
import { safePostMediaUrl } from './media';
import type { ArchivedPost, PostScope, PostTask, PostTransferProgress } from './types';
import { abortable, transferWatchdog } from './transferWatchdog';

export async function transferPost(jobId: string, task: PostTask, post: ArchivedPost, source: PostScope, abort?: AbortSignal, progress?: (value: PostTransferProgress) => void): Promise<{ bytes?: number; ext?: string; failure?: string; status?: number; retryAfterMs?: number }> {
  if (task.kind === 'text') {
    const document = new DOMParser().parseFromString(post.content, 'text/html');
    document.querySelectorAll('script,style,iframe,object').forEach(node => node.remove());
    document.querySelectorAll('br').forEach(node => node.replaceWith('\n'));
    document.querySelectorAll('p,div,li,h1,h2,h3,blockquote').forEach(node => node.append('\n'));
    document.querySelectorAll<HTMLAnchorElement>('a[href]').forEach(node => node.append(` (${node.getAttribute('href')})`));
    const text = `${post.title}\nPublished: ${post.published || 'Unknown'}\nSource: ${source.origin}/${source.platform}/user/${source.creatorId}/post/${post.id}\n\n${document.body.textContent || ''}${post.embed ? '\n\nEmbed metadata:\n' + JSON.stringify(post.embed, null, 2) : ''}\n`;
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    await stageImage(jobId, task.id, blob); return { bytes: blob.size };
  }
  const url = safePostMediaUrl(task.url);
  if (!url) throw new Error('Attachment URL is outside the archive hosts and paths.');
  const watchdog = transferWatchdog(abort), { signal } = watchdog;
  let receivedBytes = 0, totalBytes: number | null = null;
  const report = (phase: PostTransferProgress['phase']) => progress?.({ receivedBytes, totalBytes, phase, updatedAt: Date.now() });
  try {
    signal.throwIfAborted(); report('connecting');
    const response = await fetch(url, { credentials: 'omit', redirect: 'error', signal });
    if (!response.ok) return { failure: `File HTTP ${response.status}`, status: response.status, retryAfterMs: retryAfter(response.headers.get('retry-after')) };
    if (!response.body) throw new Error('The attachment is empty.');
    const mime = (response.headers.get('content-type') || '').split(';')[0].trim();
    if (['text/html', 'application/xhtml+xml', 'application/json'].includes(mime) && !/\.(?:html?|xhtml|json)$/i.test(task.path)) { await response.body.cancel(); throw new Error('The server returned an error page instead of the attachment.'); }
    const expected = Number(response.headers.get('content-length'));
    totalBytes = expected > 0 && !response.headers.get('content-encoding') ? expected : null;
    watchdog.reset(); report('downloading');
    const stream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, output) {
      if (chunk.byteLength) { receivedBytes += chunk.byteLength; watchdog.reset(); report('downloading'); }
      output.enqueue(chunk);
    } }));
    const file = await stageStream(jobId, task.id, stream, signal);
    signal.throwIfAborted(); watchdog.reset(true); report('validating');
    if (!file.size || (expected > 0 && !response.headers.get('content-encoding') && expected !== file.size)) throw new Error('The attachment transfer is incomplete.');
    const header = new Uint8Array(await file.slice(0, 512).arrayBuffer());
    if (!/\.(?:html?|xhtml)$/i.test(task.path) && /^\s*(?:<!doctype html|<html)/i.test(new TextDecoder().decode(header))) throw new Error('The server returned an error page instead of the attachment.');
    const format = detectImage(header);
    if (task.kind === 'image') {
      const preserveOriginal = task.quality === 'full res' && /\.(?:bmp|tiff?|svg|heic|heif|jxl)$/i.test(task.path);
      if (!format && !preserveOriginal && !(mime.startsWith('image/') && !/^\s*(?:<!doctype html|<html|\{)/i.test(new TextDecoder().decode(header)))) throw new Error('The server did not return an image.');
      if (task.quality === 'thumbnail' || format) {
        const bitmap = await abortable(createImageBitmap(file), signal, bitmap => bitmap.close()); const valid = bitmap.width > 0 && bitmap.height > 0; bitmap.close();
        if (!valid) throw new Error('The image could not be decoded.');
      }
    }
    signal.throwIfAborted(); return { bytes: file.size, ext: format?.ext };
  } finally { watchdog.dispose(); }
}
export async function postTaskCached(jobId: string, task: PostTask): Promise<boolean> {
  try {
    if (task.bytes === null || (await stagedFile(jobId, task.id)).size !== task.bytes) return false;
    for (const entry of task.extraction?.files || []) if ((await stagedFile(jobId, entry.id)).size !== entry.bytes) return false;
    return true;
  } catch { return false; }
}
