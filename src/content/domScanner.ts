import type { MediaRecord, Scope } from '../core/types';
import { emptyRecord, normalizeTimestamp } from '../core/mediaNormalizer';
import { isThumbnailUrl, pathFromUrl, imagePath, safeMediaUrl } from '../core/urlParser';
export function scanDom(document: Document, scope: Scope): { records: MediaRecord[]; messageCount: number } {
  const containers = [...document.querySelectorAll<HTMLElement>('[id^="message-"]')];
  const records: MediaRecord[] = [];
  for (const container of containers) {
    const messageId = /^message-(\d+)$/.exec(container.id)?.[1] || null;
    const raw = container.querySelector('time[datetime], [datetime], [data-timestamp]');
    const publishedRaw = raw?.getAttribute('datetime') || raw?.getAttribute('data-timestamp') || null;
    let ordinal = 0;
    const seen = new Set<Element>();
    for (const element of container.querySelectorAll<HTMLAnchorElement | HTMLImageElement>('a[href], img')) {
      if (element.closest('[class*="avatar"], [class*="emoji"], [class*="reaction"], nav, header')) continue;
      const anchor = element instanceof document.defaultView!.HTMLAnchorElement ? element : element.closest('a');
      const img = element instanceof document.defaultView!.HTMLImageElement ? element : element.querySelector('img');
      const owner = anchor || img || element;
      if (seen.has(owner)) continue;
      seen.add(owner);
      const original = safeMediaUrl(anchor?.href);
      const imageUrls = img ? [img.currentSrc, img.src, img.getAttribute('data-src'), img.getAttribute('data-lazy-src'), img.getAttribute('data-original'), ...(img.getAttribute('srcset') || '').split(',').map(v => v.trim().split(/\s+/)[0])].map(safeMediaUrl).filter((v): v is string => !!v) : [];
      const thumbnail = imageUrls.find(isThumbnailUrl) || (original && isThumbnailUrl(original) ? original : null);
      const observedOriginal = [original, ...imageUrls].find(url => !!url && !isThumbnailUrl(url)) || null;
      if (!thumbnail && !observedOriginal) continue;
      ordinal++;
      const path = pathFromUrl(thumbnail || observedOriginal!);
      const record = emptyRecord(scope, '', messageId, ordinal, path || thumbnail || observedOriginal!);
      record.sourceType = 'dom'; record.provenance = ['visible-dom']; record.mediaType = 'image';
      record.publishedRaw = publishedRaw; record.publishedAtUtc = normalizeTimestamp(publishedRaw);
      record.kemonoPath = path; record.kemonoFileHash = imagePath(path)?.hash || null;
      record.thumbnailUrl = thumbnail;
      if (observedOriginal?.includes('discordapp.')) record.discordCdnUrl = observedOriginal;
      else record.originalUrl = observedOriginal;
      if (!messageId) record.warnings.push('Temporary DOM identity; message ID was not verified');
      if (!record.publishedAtUtc) record.warnings.push('DOM has no verified publication timestamp');
      records.push(record);
    }
  }
  return { records, messageCount: containers.length };
}
