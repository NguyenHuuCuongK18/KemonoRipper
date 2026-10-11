import type { MediaRecord } from './types';
export function mergeMedia(existing: MediaRecord[], incoming: MediaRecord[]): MediaRecord[] {
  const records = new Map(existing.map(record => [record.id, record]));
  for (const next of incoming) {
    let previous = records.get(next.id);
    if (!previous && next.messageId) {
      const matches = [...records.values()].filter(r => (r.sourceType === 'dom' || next.sourceType === 'dom') && r.sourceType !== next.sourceType && r.serverId === next.serverId && r.channelId === next.channelId && r.messageId === next.messageId &&
        ((r.kemonoPath && r.kemonoPath === next.kemonoPath) || (r.discordCdnUrl && r.discordCdnUrl === next.discordCdnUrl)));
      previous = matches.find(r => r.attachmentIndex === next.attachmentIndex) || (matches.length === 1 ? matches[0] : undefined);
    }
    if (!previous) { records.set(next.id, next); continue; }
    // Prefer verified API identity and timestamps; retain durable download state.
    const authoritative = next.sourceType === 'api' && previous.sourceType === 'dom' ? next : previous;
    const merged: MediaRecord = {
      ...previous, id: authoritative.id, attachmentIndex: authoritative.attachmentIndex,
      publishedRaw: authoritative.publishedRaw || previous.publishedRaw || next.publishedRaw,
      publishedAtUtc: authoritative.publishedAtUtc || previous.publishedAtUtc || next.publishedAtUtc,
      originalFilename: authoritative.originalFilename || previous.originalFilename || next.originalFilename,
      kemonoPath: previous.kemonoPath || next.kemonoPath, kemonoFileHash: previous.kemonoFileHash || next.kemonoFileHash,
      thumbnailUrl: previous.thumbnailUrl || next.thumbnailUrl, originalUrl: previous.originalUrl || next.originalUrl,
      discordCdnUrl: previous.discordCdnUrl || next.discordCdnUrl,
      mediaType: previous.mediaType === 'unknown' ? next.mediaType : previous.mediaType,
      sourceType: previous.sourceType === next.sourceType ? previous.sourceType : 'merged',
      provenance: [...new Set([...previous.provenance, ...next.provenance])], warnings: [...new Set([...previous.warnings, ...next.warnings])],
    };
    records.delete(previous.id); records.set(merged.id, merged);
  }
  return [...records.values()];
}
