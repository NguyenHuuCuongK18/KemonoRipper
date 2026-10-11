// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseArchiveUrl, parseChannelUrl } from '../src/core/urlParser';
import { scanChannelNavigation } from '../src/content/channelScanner';
import { mergeChannels } from '../src/core/channelDiscovery';
import { KemonoClient } from '../src/api/kemonoClient';
import server from './fixtures/server.sanitized.json';
const root = `https://kemono.cr/discord/server/${server.id}`;
describe('server root and rendered channel navigation', () => {
  it('accepts exact server-root IDs without inventing a current channel', () => {
    expect(parseArchiveUrl(root)).toMatchObject({ serverId: server.id, channelId: null });
    expect(parseArchiveUrl(root + '/?o=150')).toMatchObject({ serverId: server.id, channelId: null });
    expect(parseChannelUrl(root)).toBeNull();
    expect(parseArchiveUrl(root + '/1268995994440302725')?.channelId).toBe('1268995994440302725');
    expect(parseArchiveUrl(root.replace('kemono.cr', 'evil.example'))).toBeNull();
    expect(parseArchiveUrl(root + '/not-a-channel')).toBeNull();
  });
  it('finds all 65 real rendered channel links, including empty channels and threads', async () => {
    document.body.innerHTML = readFileSync('tests/fixtures/server-navigation.sanitized.html', 'utf8');
    document.title = "🅿atreon-sketch-gallery — Dangpa's Art | Kemono";
    const page = scanChannelNavigation(document, root)!;
    expect(page.channels).toHaveLength(65); expect(page.serverName).toBe("Dangpa's Art");
    expect(new Set(page.channels.map(c => c.id))).toEqual(new Set(server.channels.map(c => c.id)));
    const api = await new KemonoClient(async () => new Response(JSON.stringify(server))).server(server.id);
    const merged = mergeChannels(server.id, api, [page])!;
    expect(merged.channels).toHaveLength(65);
    expect(merged.channels.every(c => c.sources?.includes('api') && c.sources?.includes('dom'))).toBe(true);
    expect(merged.channels.some(c => c.postCount === 0)).toBe(true);
    expect(merged.channels.some(c => c.type === 11 && c.parentId)).toBe(true);
  });
  it('deduplicates navigation and excludes other servers, origins and unrelated links', () => {
    // Synthetic malformed navigation cases supplement the actual sanitized fixture.
    document.body.innerHTML = `<a href="${root}/123">Channel</a><a href="${root}/123?o=150">Duplicate</a><a href="https://kemono.cr/discord/server/999/456">Other server</a><a href="https://evil.example/discord/server/${server.id}/789">Other origin</a><a href="/account">Account</a>`;
    expect(scanChannelNavigation(document, root)?.channels.map(c => c.id)).toEqual(['123']);
  });
  it('keeps DOM-only channels and uses them when metadata is unavailable', () => {
    const page = { serverId: server.id, serverName: 'Observed server', channels: [{ id: '123', name: 'Observed channel', parentId: null, type: null, postCount: null }] };
    expect(mergeChannels(server.id, null, [page])?.channels[0]).toMatchObject({ id: '123', sources: ['dom'] });
    const api = { id: server.id, name: 'API name', channels: [{ ...page.channels[0], name: 'API channel', parentId: '99', postCount: 0 }] };
    const merged = mergeChannels(server.id, api, [page, { ...page, serverId: '999' }])!;
    expect(merged.name).toBe('API name'); expect(merged.channels[0]).toMatchObject({ name: 'API channel', parentId: '99', postCount: 0, sources: ['api', 'dom'] });
    expect(mergeChannels(server.id, null, [{ ...page, serverId: '999' }])).toBeNull();
  });
});
