import type { Channel, Server, PageChannels } from './types';
import { requireId } from './urlParser';
export function mergeChannels(serverId: string, api: Server | null, pages: PageChannels[]): Server | null {
  const channels = new Map<string, Channel>();
  for (const channel of api?.channels || []) channels.set(channel.id, { ...channel, sources: ['api'] });
  let name = api?.name || null;
  for (const page of pages) {
    if (page.serverId !== serverId) continue;
    name ||= typeof page.serverName === 'string' ? page.serverName : null;
    for (const channel of page.channels) {
      try { requireId(channel.id); } catch { continue; }
      const existing = channels.get(channel.id);
      if (existing) existing.sources = [...new Set([...(existing.sources || []), 'dom' as const])];
      else channels.set(channel.id, { id: channel.id, name: typeof channel.name === 'string' ? channel.name : channel.id, parentId: null, type: null, postCount: null, sources: ['dom'] });
    }
  }
  return api || channels.size ? { id: serverId, name: name || serverId, channels: [...channels.values()] } : null;
}
