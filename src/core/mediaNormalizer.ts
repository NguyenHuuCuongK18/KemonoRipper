import type { ApiMessage, MediaRecord, Scope } from './types';
import { ARCHIVE_ORIGINS, imagePath, makeThumbnailUrl, safeMediaUrl } from './urlParser';

export function stableToken(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const char of value) hash = BigInt.asUintN(64, (hash ^ BigInt(char.codePointAt(0)!)) * 0x100000001b3n);
  return hash.toString(16).padStart(16, '0');
}
export function normalizeTimestamp(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})?$/.exec(raw);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction, zone] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  if (m < 1 || m > 12 || d < 1 || d > new Date(Date.UTC(y, m, 0)).getUTCDate() || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null;
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}.${(fraction || '').padEnd(3, '0').slice(0, 3)}${zone || 'Z'}`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
export function emptyRecord(scope: Scope, jobId: string, messageId: string | null, ordinal: number, identity: string): MediaRecord {
  return {
    ...scope, jobId, id: `${scope.serverId}:${scope.channelId}:${messageId || 'dom'}:${ordinal}:${stableToken(identity)}`,
    messageId, attachmentIndex: ordinal, attachmentId: null, publishedRaw: null, publishedAtUtc: null,
    originalFilename: null, kemonoPath: null, kemonoFileHash: null, originalUrl: null, discordCdnUrl: null,
    thumbnailUrl: null, resolvedUrl: null, mediaType: 'unknown', sourceType: 'api', provenance: [], warnings: [],
    status: 'discovered', savedPath: null, errorMessage: null, attempts: 0, nextAttemptAt: 0,
    downloadId: null, blobUrl: null, quality: null, bytes: null, sha256: null, mime: null, width: null, height: null, candidateFailures: [],
  };
}
export function normalizeMessages(messages: ApiMessage[], scope: Scope, jobId: string, origin = ARCHIVE_ORIGINS[0]): MediaRecord[] {
  const records: MediaRecord[] = [];
  for (const message of messages) {
    if (message.server && message.server !== scope.serverId) throw new Error('Message belongs to a different server');
    const stamp = (record: MediaRecord): MediaRecord => {
      record.publishedRaw = typeof message.published === 'string' ? message.published : null;
      record.publishedAtUtc = normalizeTimestamp(record.publishedRaw);
      record.provenance = ['api'];
      if (!record.publishedAtUtc) record.warnings.push('Missing or invalid publication timestamp');
      else if (!/(Z|[+-]\d\d:\d\d)$/.test(record.publishedRaw!)) record.warnings.push('Archive timestamp has no timezone; interpreted as UTC');
      return record;
    };
    const attachments = message.attachments || [];
    attachments.forEach((attachment, index) => {
      const path = typeof attachment.path === 'string' ? attachment.path : null;
      const record = stamp(emptyRecord(scope, jobId, message.id, index + 1, path || attachment.name || `attachment-${index}`));
      record.originalFilename = typeof attachment.name === 'string' ? attachment.name : null;
      const valid = imagePath(path);
      if (valid) {
        record.kemonoPath = valid.path; record.kemonoFileHash = valid.hash;
        record.thumbnailUrl = makeThumbnailUrl(valid.path, origin); record.mediaType = 'image';
      } else {
        record.discordCdnUrl = safeMediaUrl(path);
        if (record.discordCdnUrl?.includes('discordapp.')) record.mediaType = 'image';
        else { record.discordCdnUrl = null; record.warnings.push('Unsupported attachment path; needs an observed image URL'); }
      }
      records.push(record);
    });
    const urls = typeof message.content === 'string' ? message.content.match(/https:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\/attachments\/[^\s<>"')]+/g) || [] : [];
    const unique = [...new Set(urls.map(safeMediaUrl).filter((v): v is string => !!v))];
    unique.forEach((url, index) => {
      const record = stamp(emptyRecord(scope, jobId, message.id, attachments.length + index + 1, url));
      record.discordCdnUrl = url; record.mediaType = 'image'; record.originalFilename = new URL(url).pathname.split('/').at(-1)!;
      try { record.originalFilename = decodeURIComponent(record.originalFilename); } catch { /* Preserve an undecodable source filename verbatim. */ }
      record.provenance.push('inline-content'); records.push(record);
    });
  }
  return records;
}
