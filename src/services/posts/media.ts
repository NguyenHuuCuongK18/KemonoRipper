import { isArchiveMediaHost, isThumbnailUrl } from '../../core/urlParser';
import { safeSegment } from '../../core/filenameBuilder';
import { normalizeTimestamp } from '../../core/mediaNormalizer';
import { relativePathParts } from '../../storage/folderWriter';
import type { ApiPost, ArchivedPost, Attachment, PostJob, PostMedia, PostScope, PostSelection, PostTask, Quality } from './types';
import { selectedPosts } from './selection';

const storedPath = /^\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}(?:\.[a-z0-9_-]{1,16})?$/i;
const images = /\.(png|jpe?g|webp|gif|avif|bmp|tiff?|svg|heic|heif|jxl)$/i;
export function safePostMediaUrl(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  try {
    const url = new URL(input);
    if (url.protocol !== 'https:' || url.port || url.username || url.password) return null;
    const prefix = isThumbnailUrl(url.href) ? '/thumbnail/data' : '/data';
    if (!isArchiveMediaHost(url.hostname) || !url.pathname.startsWith(prefix + '/') || !storedPath.test(url.pathname.slice(prefix.length))) return null;
    url.hash = ''; return url.href;
  } catch { return null; }
}
function serverMediaUrl(server: unknown, path: string, name: string): string | null {
  if (typeof server !== 'string' || !server) return null;
  try {
    const url = new URL(server.includes('://') ? server : `https://${server}`);
    if (url.pathname === '/' && !url.search && !url.hash) {
      url.pathname = `/data${path}`;
      url.search = `?f=${encodeURIComponent(name)}`;
    }
    const safe = safePostMediaUrl(url.href);
    return safe && new URL(safe).pathname === `/data${path}` ? safe : null;
  } catch { return null; }
}
function attachmentMedia(attachment: Attachment, scope: PostScope, full: boolean | null, ordinal: number): PostMedia | null {
  const path = attachment.path;
  if (typeof path !== 'string' || !storedPath.test(path)) return null;
  const name = typeof attachment.name === 'string' && attachment.name ? attachment.name : path.split('/').at(-1)!;
  const kind = images.test(path) || images.test(name) ? 'image' : 'file';
  const hostname = new URL(scope.origin).hostname;
  const node = Number.isSafeInteger(attachment.node) && attachment.node! >= 1 ? attachment.node : null;
  const originalHost = node ? `n${node}.${hostname}` : hostname === 'pawchive.pw' ? 'file.pawchive.pw' : hostname;
  const originalUrl = full === false ? null : serverMediaUrl(attachment.server, path, name) || safePostMediaUrl(`https://${originalHost}/data${path}?f=${encodeURIComponent(name)}`);
  return { id: `${ordinal}:${path}`, name, path, kind, thumbnailUrl: kind === 'image' ? safePostMediaUrl(`https://img.${hostname}/thumbnail/data${path}`) : null, originalUrl };
}
export function normalizePost(post: ApiPost, scope: PostScope): ArchivedPost {
  const hasFull = typeof post.has_full === 'boolean' ? post.has_full : null;
  const media: PostMedia[] = [];
  for (const attachment of [post.file, ...(post.attachments || [])]) {
    if (!attachment) continue;
    const item = attachmentMedia(attachment, scope, hasFull, media.length + 1);
    if (item && !media.some(previous => previous.path === item.path)) media.push(item);
  }
  // Inline archive images can occur outside the attachment array. Never fetch external embeds.
  for (const match of (post.content || '').matchAll(/(?:src|href)=["']([^"']+)["']/gi)) {
    let url: string | null = null;
    try { url = safePostMediaUrl(new URL(match[1].replaceAll('&amp;', '&'), scope.origin).href); } catch { /* Invalid source markup. */ }
    if (!url) continue;
    const path = new URL(url).pathname.replace(/^\/(?:thumbnail\/)?data/, '');
    const existing = media.find(previous => previous.path === path);
    if (existing) {
      // An observed full-resolution link is more precise than a synthesized default host.
      if (isThumbnailUrl(url)) existing.thumbnailUrl = url;
      else if (hasFull !== false) existing.originalUrl = url;
      continue;
    }
    const item = attachmentMedia({ path }, scope, hasFull, media.length + 1);
    if (item) {
      if (isThumbnailUrl(url)) item.thumbnailUrl = url;
      else item.originalUrl = hasFull === false ? null : url;
      media.push(item);
    }
  }
  return { id: post.id, title: post.title || `Post ${post.id}`, content: post.content || '', published: post.published || null, hasFull, media, embed: post.embed || null };
}
export function creatorFolder(job: Pick<PostJob, 'source' | 'creatorName'>): string {
  return `${job.source.platform}_${job.source.creatorId}_${safeSegment(job.creatorName, 'creator')}`;
}
export function postRelativePath(task: Pick<PostTask, 'path' | 'quality' | 'postId'>): string {
  const parts = relativePathParts(task.path), quality = parts.indexOf(task.quality);
  if (quality < 0 || parts.length !== quality + 3 || !isPostFolder(parts[quality + 1], task.postId)) throw new Error('Unsafe post archive path');
  return parts.slice(quality).join('/');
}
export function isPostFolder(folder: string, postId: string): boolean {
  return folder.startsWith(postId + '_') || /^(?:\d{4}-\d{2}-\d{2}|unknown-date)_/.test(folder) && folder.slice(folder.indexOf('_') + 1).startsWith(postId + '_');
}
export function postFolder(post: Pick<ArchivedPost, 'id' | 'published' | 'title'>): string {
  const date = normalizeTimestamp(post.published)?.slice(0, 10) || 'unknown-date';
  return `${date}_${post.id}_${safeSegment(post.title, 'post')}`;
}
export function thumbnailFallback(task: PostTask, reason: string): PostTask | null {
  if (task.kind !== 'image' || task.quality !== 'full res' || !task.fallbackUrl || !safePostMediaUrl(task.fallbackUrl) || !isThumbnailUrl(task.fallbackUrl)) return null;
  const parts = relativePathParts(task.path), quality = parts.indexOf('full res');
  postRelativePath(task); parts[quality] = 'thumbnail';
  return { ...task, id: task.id.replace(':full res:', ':thumbnail:'), quality: 'thumbnail', url: task.fallbackUrl, path: parts.join('/'), status: 'queued', bytes: null, attempts: 0, nextAt: 0, error: null, synced: false, fallback: true, fallbackReason: reason, fallbackChecked: false };
}
export function postZipJob(job: PostJob): PostJob {
  const base = creatorFolder(job);
  return { ...job, tasks: job.tasks.map(task => ({ ...task, path: `${base}/${postRelativePath(task)}` })) };
}
function filename(name: string): string {
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 && /^[a-z0-9_-]{1,16}$/i.test(name.slice(dot + 1)) ? name.slice(dot) : '';
  return safeSegment(ext ? name.slice(0, dot) : name, 'attachment') + ext;
}
export function createTasks(job: PostJob, selection: PostSelection): PostTask[] {
  const tasks: PostTask[] = [];
  const qualities: Quality[] = selection.quality === 'both' ? ['thumbnail', 'full res'] : [selection.quality];
  for (const post of selectedPosts(job)) for (const quality of qualities) {
    const folder = `${job.destination?.kind === 'folder' ? '' : creatorFolder(job) + '/'}${quality}/${postFolder(post)}`;
    for (const [index, media] of post.media.entries()) {
      if (media.kind === 'image' ? !selection.images : !selection.files || quality === 'thumbnail') continue;
      const url = quality === 'thumbnail' ? media.thumbnailUrl : media.originalUrl;
      const task: PostTask = { id: `${post.id}:${quality}:${media.id}`, postId: post.id, quality, kind: media.kind, url, path: `${folder}/${String(index + 1).padStart(3, '0')}_${filename(media.name)}`, status: url ? 'queued' : 'unavailable', bytes: null, attempts: 0, nextAt: 0, error: url ? null : 'Full-resolution file was not archived.' };
      if (selection.quality === 'full res' && selection.fallbackToThumbnail && media.kind === 'image' && media.thumbnailUrl) task.fallbackUrl = media.thumbnailUrl;
      tasks.push(!url ? thumbnailFallback(task, task.error!) || task : task);
    }
    if (selection.text) tasks.push({ id: `${post.id}:${quality}:text`, postId: post.id, quality, kind: 'text', url: null, path: `${folder}/post.txt`, status: 'queued', bytes: null, attempts: 0, nextAt: 0, error: null });
  }
  return tasks;
}
