import type { MediaRecord, Job } from './types';
import { stableToken } from './mediaNormalizer';
export function safeSegment(value: string | null, fallback = 'unnamed'): string {
  let safe = (value || fallback).normalize('NFKC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '_').replace(/^[. ]+|[. ]+$/g, '').slice(0, 40).trim().replace(/[. ]+$/g, '');
  if (!safe || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe)) safe = '_' + (safe || fallback);
  return safe;
}
export function serverFolder(job: Pick<Job, 'serverId' | 'serverName' | 'service'>): string { return `ArchiveRoot/${job.service === 'discord' ? 'discord/' : ''}${job.serverId}_${safeSegment(job.serverName, 'server')}`; }
export function channelFolder(record: Pick<MediaRecord, 'serverId' | 'serverName' | 'channelId' | 'channelName' | 'service'>): string { return `${serverFolder(record)}/${record.channelId}_${safeSegment(record.channelName, 'channel')}`; }
export function buildFilename(record: MediaRecord, ext: string): string {
  if (!/^(png|jpg|webp|gif|avif)$/.test(ext)) throw new Error('Unvalidated image format');
  const stamp = record.publishedAtUtc ? record.publishedAtUtc.slice(0, 19).replace('T', '_').replace(/:(\d{2})/g, '$1') + 'Z' : 'unknown-date';
  return `${channelFolder(record)}/${stamp}_${record.messageId || 'unknown-message'}_${String(record.attachmentIndex).padStart(3, '0')}_${stableToken(record.id).slice(0, 8)}.${ext}`;
}
