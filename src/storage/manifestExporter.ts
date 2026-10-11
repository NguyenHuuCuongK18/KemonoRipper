import type { Job, MediaRecord, Summary } from '../core/types';
export function summarize(job: Job, records: MediaRecord[]): Summary {
  const summary: Summary = { discovered: records.length, downloaded: 0, staged: 0, failed: 0, skipped: 0, queued: 0, pages: 0, messages: 0,
    incomplete: (job.scope === 'server' && job.channelDiscovery === 'dom') || job.status === 'cancelled' };
  for (const channel of job.channels) { summary.pages += channel.pages; summary.messages += channel.messageIds.length; if (channel.coverage !== 'complete') summary.incomplete = true; }
  for (const record of records) {
    switch (record.status) {
      case 'downloaded': summary.downloaded++; break;
      case 'staged': summary.staged++; break;
      case 'failed': summary.failed++; break;
      case 'skipped': summary.skipped++; break;
      case 'queued': case 'transferring': summary.queued++; break;
    }
    if (['failed', 'skipped', 'queued', 'transferring', 'staged'].includes(record.status) || record.mediaType === 'unknown' || !record.messageId || !(record.thumbnailUrl || record.originalUrl || record.discordCdnUrl)) summary.incomplete = true;
  }
  return summary;
}
export function manifest(job: Job, records: MediaRecord[], channelId?: string): string {
  const selected = channelId ? records.filter(r => r.channelId === channelId) : records;
  const scopedJob = channelId ? { ...job, channels: job.channels.filter(c => c.channelId === channelId) } : job;
  return JSON.stringify({
    schemaVersion: 1, exportedAt: new Date().toISOString(), job: { ...scopedJob, archive: scopedJob.archive ? { ...scopedJob.archive, blobUrl: undefined } : undefined, manifestDownloads: scopedJob.manifestDownloads.map(({ blobUrl: _blob, ...download }) => download) }, totals: summarize(scopedJob, selected),
    coverageNote: 'Complete means every requested API page reached a validated empty array. DOM coverage is limited to observed messages. Indexed links are not a claim that every image is available.',
    timestampPolicy: 'Timezone-less archive publication times are interpreted as UTC; raw values are retained.',
    media: selected.map(({ blobUrl: _blob, ...record }) => record),
  }, null, 2);
}
const columns = ['serverId', 'serverName', 'channelId', 'channelName', 'messageId', 'publishedRaw', 'publishedAtUtc', 'attachmentIndex', 'originalFilename', 'kemonoPath', 'kemonoFileHash', 'originalUrl', 'discordCdnUrl', 'thumbnailUrl', 'resolvedUrl', 'quality', 'sourceType', 'status', 'savedPath', 'sha256', 'errorMessage'] as const;
export function csv(records: MediaRecord[]): string {
  const cell = (value: unknown) => {
    let text = value == null ? '' : String(value);
    if (/^[\s]*[=+\-@\t\r]/.test(text)) text = "'" + text; // Spreadsheet formula injection.
    return '"' + text.replaceAll('"', '""') + '"';
  };
  return '\uFEFF' + [columns.join(','), ...records.map(record => columns.map(key => cell(record[key])).join(','))].join('\r\n');
}
