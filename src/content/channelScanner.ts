import type { Channel, PageChannels } from '../core/types';
import { parseArchiveUrl, parseChannelUrl } from '../core/urlParser';
export function scanChannelNavigation(document: Document, pageUrl: string): PageChannels | null {
  const scope = parseArchiveUrl(pageUrl);
  if (!scope) return null;
  const channels = new Map<string, Channel>();
  for (const anchor of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    let url: URL;
    try { url = new URL(anchor.getAttribute('href')!, pageUrl); } catch { continue; }
    const channel = parseChannelUrl(url.href);
    if (!channel || channel.serverId !== scope.serverId || url.origin !== new URL(pageUrl).origin) continue;
    const name = (anchor.textContent || anchor.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 512);
    if (!channels.has(channel.channelId)) channels.set(channel.channelId, { id: channel.channelId, name: name || channel.channelId, parentId: null, type: null, postCount: null, sources: ['dom'] });
  }
  // Observed live title: "Channel — Server | Kemono". The API name takes priority.
  const title = document.title;
  const separator = title.lastIndexOf(' — ');
  const serverName = separator >= 0 && title.endsWith(' | Kemono') ? title.slice(separator + 3, -9).trim() || null : null;
  return { serverId: scope.serverId, serverName, channels: [...channels.values()] };
}
