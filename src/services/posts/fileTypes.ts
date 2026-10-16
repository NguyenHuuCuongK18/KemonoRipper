import { selectedPosts } from './selection';
import type { PostJob, PostMedia, PostSelection } from './types';

export function fileType(name: string): string {
  const filename = name.split(/[\\/]/).at(-1) || '';
  const compound = /\.(tar\.(?:gz|bz2|xz|zst))$/i.exec(filename)?.[1];
  return compound?.toLowerCase() || /[^.]\.([a-z0-9_-]{1,64})$/i.exec(filename)?.[1].toLowerCase() || 'unknown';
}
export function mediaFileType(media: Pick<PostMedia, 'name' | 'path'>): string { return fileType(media.name) === 'unknown' ? fileType(media.path) : fileType(media.name); }
export function acceptsFileType(type: string, selection: PostSelection): boolean { return !selection.excludedFileTypes?.includes(type); }
export function isArchive(name: string): boolean { return /\.(?:zip|zipx|7z|rar|tar|tgz|tbz2?|txz|tar\.(?:gz|bz2|xz|zst))$/i.test(name); }
export function detectedFileTypes(job: Pick<PostJob, 'posts' | 'selectedPostIds'>) {
  const counts = new Map<string, number>();
  for (const post of selectedPosts(job)) {
    counts.set('txt', (counts.get('txt') || 0) + 1);
    for (const media of post.media) { const type = mediaFileType(media); counts.set(type, (counts.get(type) || 0) + 1); }
  }
  return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([type, count]) => ({ type, count }));
}
