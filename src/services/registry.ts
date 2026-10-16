import { ARCHIVE_ORIGINS, parseArchiveUrl } from '../core/urlParser';
import { isPostId } from './posts/postId';
import type { PostScope } from './posts/types';

export function supportedSite(input: string): boolean {
  try { const url = new URL(input); return ARCHIVE_ORIGINS.includes(url.origin) && !url.username && !url.password; } catch { return false; }
}
export function parsePostUrl(input: string): PostScope | null {
  if (!supportedSite(input)) return null;
  const url = new URL(input);
  const match = /^\/(fanbox|patreon)\/user\/(\d+)(?:\/post\/([^/]+))?\/?$/.exec(url.pathname);
  return match && (match[3] === undefined || isPostId(match[3])) ? { origin: url.origin, platform: match[1] as PostScope['platform'], creatorId: match[2], postId: match[3] || null } : null;
}
export function serviceForUrl(input: string): 'discord' | 'posts' | null {
  return parseArchiveUrl(input) ? 'discord' : parsePostUrl(input) ? 'posts' : null;
}
export function postSourceUrl(scope: PostScope): string {
  return `${scope.origin}/${scope.platform}/user/${scope.creatorId}${scope.postId ? `/post/${scope.postId}` : ''}`;
}
