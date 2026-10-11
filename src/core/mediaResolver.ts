import type { Job, MediaRecord } from './types';
import { safeMediaUrl } from './urlParser';
export interface Candidate { url: string; quality: 'thumbnail' | 'original' }
export function candidates(record: MediaRecord, job: Pick<Job, 'mode' | 'tryOriginal'>): Candidate[] {
  const originals = [record.originalUrl, record.discordCdnUrl].map(safeMediaUrl).filter((v): v is string => !!v).map(url => ({ url, quality: 'original' as const }));
  const preview = safeMediaUrl(record.thumbnailUrl);
  const thumbnails = preview ? [{ url: preview, quality: 'thumbnail' as const }] : [];
  const list = job.mode === 'original' ? originals : job.mode === 'best' && job.tryOriginal ? [...originals, ...thumbnails] : thumbnails;
  return list.filter((value, index) => list.findIndex(v => v.url === value.url) === index);
}
export function detectImage(bytes: Uint8Array): { ext: string; mime: string } | null {
  const text = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  if (bytes.length < 12) return null;
  if (bytes[0] === 0x89 && text(1, 4) === 'PNG' && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10) return { ext: 'png', mime: 'image/png' };
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (['GIF87a', 'GIF89a'].includes(text(0, 6))) return { ext: 'gif', mime: 'image/gif' };
  if (text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  if (text(4, 8) === 'ftyp' && /avif|avis/.test(text(8, Math.min(bytes.length, 40)))) return { ext: 'avif', mime: 'image/avif' };
  return null;
}
