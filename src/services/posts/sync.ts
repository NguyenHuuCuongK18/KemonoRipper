import { relativePathParts } from '../../storage/folderWriter';
import { parsePostUrl } from '../registry';
import { isPostFolder } from './media';
import type { PostJob, PostScope, PostSelection, PostSyncFile, PostSyncIndex, PostTask } from './types';

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid post sync JSON.');
  return value as Record<string, unknown>;
};
export function syncKey(id: string): string { return id.replace(/^(\d+:(?:thumbnail|full res):)\d+:(\/)/, '$1$2'); }
export function validSelection(value: unknown): PostSelection {
  const selection = object(value);
  if (!['thumbnail', 'full res', 'both'].includes(String(selection.quality)) || ['images', 'files', 'text'].some(key => typeof selection[key] !== 'boolean')) throw new Error('Invalid content selection.');
  if (selection.fallbackToThumbnail !== undefined && typeof selection.fallbackToThumbnail !== 'boolean') throw new Error('Invalid thumbnail fallback selection.');
  return { quality: selection.quality as PostSelection['quality'], images: selection.images as boolean, files: selection.files as boolean, text: selection.text as boolean, ...(selection.fallbackToThumbnail !== undefined ? { fallbackToThumbnail: selection.fallbackToThumbnail } : {}) };
}
export function assertSyncSource(index: PostSyncIndex, source: PostScope): void {
  if (index.source.origin !== source.origin || index.source.platform !== source.platform || index.source.creatorId !== source.creatorId) throw new Error('This JSON belongs to a different website, service, or creator. Open that creator’s profile to sync it.');
}
function readFile(value: unknown, postId: string, legacy = false): PostSyncFile {
  const file = object(value);
  if (typeof file.id !== 'string' || file.id.length > 500 || !['thumbnail', 'full res'].includes(String(file.quality)) || !['image', 'file', 'text'].includes(String(file.kind)) || typeof file.path !== 'string' || file.path.length > 2000 || !Number.isSafeInteger(file.bytes) || (file.bytes as number) <= 0) throw new Error('Invalid downloaded file in sync JSON.');
  const id = syncKey(file.id);
  if (!id.startsWith(`${postId}:${file.quality}:`) || (file.kind === 'text' ? id !== `${postId}:${file.quality}:text` : !/^\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{64}(?:\.[a-z0-9_-]{1,16})?$/i.test(id.slice(`${postId}:${file.quality}:`.length)))) throw new Error('Invalid downloaded file ID in sync JSON.');
  let path = file.path;
  if (legacy) {
    const parts = relativePathParts(path);
    const quality = parts.findIndex(part => part === file.quality);
    if (quality < 0) throw new Error('Invalid legacy archive path.');
    path = parts.slice(quality).join('/');
  }
  const parts = relativePathParts(path);
  if (parts.length !== 3 || parts[0] !== file.quality || !isPostFolder(parts[1], postId)) throw new Error('Downloaded paths must stay inside this post’s quality folder.');
  return { id, quality: file.quality as PostSyncFile['quality'], kind: file.kind as PostSyncFile['kind'], path, bytes: file.bytes as number };
}
export function parseSync(input: unknown, scope: PostScope): PostSyncIndex {
  const data = object(input);
  const legacy = data.schemaVersion === 1 && typeof data.sourceUrl === 'string' && Array.isArray(data.files) && Array.isArray(data.posts);
  let source: PostScope | null;
  if (legacy) source = parsePostUrl(data.sourceUrl as string);
  else {
    if (data.format !== 'archive-ripper-post-sync' || data.version !== 1) throw new Error('Choose sync.json or a post archive manifest.json. A failures.json is not a download history.');
    const raw = object(data.source);
    source = parsePostUrl(`${raw.origin}/${raw.platform}/user/${raw.creatorId}`);
    if (!source || raw.origin !== source.origin || raw.platform !== source.platform || raw.creatorId !== source.creatorId) throw new Error('Invalid creator in sync JSON.');
  }
  if (!source) throw new Error('Invalid creator in sync JSON.');
  const index: PostSyncIndex = { format: 'archive-ripper-post-sync', version: 1, source: { origin: source.origin, platform: source.platform, creatorId: source.creatorId }, creatorName: String(legacy ? data.creator || source.creatorId : data.creatorName || source.creatorId).slice(0, 300), updatedAt: new Date().toISOString(), selection: validSelection(data.selection), posts: [] };
  assertSyncSource(index, scope);
  if (!Array.isArray(data.posts) || data.posts.length > 100000) throw new Error('Invalid post list in sync JSON.');
  let count = 0;
  const ids = new Set<string>();
  const legacyFiles = new Map<string, unknown[]>();
  if (legacy) for (const raw of data.files as unknown[]) {
    const file = object(raw);
    if (!['staged', 'downloaded'].includes(String(file.status))) continue;
    const postId = String(file.postId);
    const files = legacyFiles.get(postId) || []; files.push(file); legacyFiles.set(postId, files);
  }
  for (const raw of data.posts) {
    const post = object(raw);
    if (typeof post.id !== 'string' || !/^\d{1,40}$/.test(post.id) || ids.has(post.id)) throw new Error('Invalid or duplicate post ID in sync JSON.');
    ids.add(post.id);
    const files = legacy ? legacyFiles.get(post.id) || [] : post.files;
    if (!Array.isArray(files) || (count += files.length) > 200000) throw new Error('Invalid file list in sync JSON.');
    const parsed = files.map(file => readFile(file, post.id as string, legacy));
    if (new Set(parsed.map(file => file.id)).size !== parsed.length) throw new Error('Duplicate file ID in sync JSON.');
    if (parsed.length) index.posts.push({ id: post.id, title: String(post.title || `Post ${post.id}`).slice(0, 500), files: parsed });
  }
  return index;
}
export function emptySync(job: Pick<PostJob, 'source' | 'creatorName' | 'selection'>): PostSyncIndex {
  const { origin, platform, creatorId } = job.source;
  return { format: 'archive-ripper-post-sync', version: 1, source: { origin, platform, creatorId }, creatorName: job.creatorName, updatedAt: new Date().toISOString(), selection: job.selection, posts: [] };
}
export function mergeSync(base: PostSyncIndex | undefined, incoming: PostSyncIndex): PostSyncIndex {
  if (!base) return structuredClone(incoming);
  assertSyncSource(incoming, { ...base.source, postId: null });
  const merged = structuredClone(base), posts = new Map(merged.posts.map(post => [post.id, post]));
  for (const post of incoming.posts) {
    const previous = posts.get(post.id);
    if (!previous) { const copy = structuredClone(post); merged.posts.push(copy); posts.set(copy.id, copy); }
    else { const files = new Map(previous.files.map(file => [file.id, file])); for (const file of post.files) files.set(file.id, { ...file }); previous.files = [...files.values()]; }
  }
  merged.selection = incoming.selection; merged.updatedAt = new Date().toISOString();
  return merged;
}
export function recordSaved(index: PostSyncIndex, task: PostTask, title: string): void {
  if (!['downloaded', 'staged'].includes(task.status) || !task.bytes) return;
  let post = index.posts.find(post => post.id === task.postId);
  if (!post) { post = { id: task.postId, title, files: [] }; index.posts.push(post); }
  const file = { id: syncKey(task.id), quality: task.quality, kind: task.kind, path: task.path, bytes: task.bytes };
  const old = post.files.findIndex(previous => previous.id === file.id);
  if (old < 0) post.files.push(file); else post.files[old] = file;
  index.updatedAt = new Date().toISOString();
}
export function zipSync(job: PostJob): PostSyncIndex {
  const index = emptySync(job);
  for (const task of job.tasks) {
    const parts = relativePathParts(task.path), quality = parts.findIndex(part => part === task.quality);
    recordSaved(index, { ...task, path: parts.slice(quality).join('/') }, job.posts.find(post => post.id === task.postId)?.title || task.postId);
  }
  return index;
}
