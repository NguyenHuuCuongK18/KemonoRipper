import type { ArchiveScope, Scope } from './types';
export const ARCHIVE_ORIGINS = ['https://kemono.cr', 'https://pawchive.pw'];
export const ARCHIVE_PAGE_PATTERNS = ARCHIVE_ORIGINS.map(origin => `${origin}/discord/server/*`);
export const THUMBNAIL_HOSTS = ARCHIVE_ORIGINS.map(origin => `img.${new URL(origin).hostname}`);
export function isArchiveMediaHost(host: string): boolean {
  return /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*(?:kemono\.cr|pawchive\.pw)$/.test(host);
}
export function isThumbnailUrl(input: string): boolean {
  return new URL(input).pathname.startsWith('/thumbnail/data/');
}
export function parseArchiveUrl(input: string): ArchiveScope | null {
  try {
    const url = new URL(input);
    const match = /^\/discord\/server\/(\d+)(?:\/(\d+))?\/?$/.exec(url.pathname);
    if (!ARCHIVE_ORIGINS.includes(url.origin) || url.username || url.password || !match) return null;
    return { serverId: match[1], channelId: match[2] || null, serverName: null, channelName: null };
  } catch { return null; }
}
export function parseChannelUrl(input: string): Scope | null {
  const scope = parseArchiveUrl(input);
  return scope?.channelId ? { ...scope, channelId: scope.channelId } : null;
}
export function requireId(value: unknown): string {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error('Expected a Discord ID encoded as a string');
  return value;
}
const pathPattern = /^\/([0-9a-f]{2})\/([0-9a-f]{2})\/([0-9a-f]{64})\.(png|jpe?g|webp|gif|avif)$/i;
export function imagePath(path: unknown): { path: string; hash: string } | null {
  if (typeof path !== 'string') return null;
  const match = pathPattern.exec(path);
  return match ? { path, hash: match[3].toLowerCase() } : null;
}
export function makeThumbnailUrl(path: unknown, origin = ARCHIVE_ORIGINS[0]): string | null {
  const valid = imagePath(path);
  return valid && ARCHIVE_ORIGINS.includes(origin) ? `https://img.${new URL(origin).hostname}/thumbnail/data${valid.path}` : null;
}
export function safeMediaUrl(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  try {
    const url = new URL(input);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    const host = url.hostname;
    const allowed = (isArchiveMediaHost(host) && url.pathname.startsWith('/thumbnail/data/') && imagePath(url.pathname.slice(15)))
      || (isArchiveMediaHost(host) && url.pathname.startsWith('/data/') && imagePath(url.pathname.slice(5)))
      || ((host === 'cdn.discordapp.com' || host === 'media.discordapp.net') && /^\/attachments\/\d+\/\d+\/[^/]+\.(png|jpe?g|webp|gif|avif)$/i.test(url.pathname));
    if (!allowed) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}
export function pathFromUrl(input: string): string | null {
  const safe = safeMediaUrl(input);
  if (!safe) return null;
  const path = new URL(safe).pathname.replace(/^\/(?:thumbnail\/)?data/, '');
  return imagePath(path)?.path ?? null;
}
