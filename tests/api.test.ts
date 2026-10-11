import { describe, it, expect, vi } from 'vitest';
import { KemonoClient, RequestError, retryAfter } from '../src/api/kemonoClient';
import { parseChannelUrl, makeThumbnailUrl, safeMediaUrl } from '../src/core/urlParser';
const channelId = '1268995994440302725';
const sample = 'https://kemono.cr/discord/server/1217290220718915654/' + channelId;
describe('API boundary', () => {
  it('preserves snowflakes and rejects other origins', () => {
    expect(parseChannelUrl(sample)?.channelId).toBe(channelId);
    expect(parseChannelUrl(sample)?.serverId).toBe('1217290220718915654');
    expect(parseChannelUrl(sample.replace('kemono.cr', 'evil.example'))).toBeNull();
    expect(parseChannelUrl(sample.replace('https:', 'http:'))).toBeNull();
  });
  it('sends the site-required header and parses misleading MIME', async () => {
    const transport = vi.fn().mockResolvedValue(new Response('[{"id":"1268995994440302725","attachments":[]}]', { headers: { 'content-type': 'text/css' } }));
    expect(await new KemonoClient(transport).channel(channelId, 150)).toHaveLength(1);
    expect(transport.mock.calls[0][0]).toContain('?o=150');
    expect(transport.mock.calls[0][1].headers).toEqual({ Accept: 'text/css' });
    expect(transport.mock.calls[0][1].credentials).toBe('omit');
  });
  it.each([403, 404, 429, 500])('does not treat HTTP %i as a terminal page', async status => {
    const client = new KemonoClient(vi.fn().mockResolvedValue(new Response('private error body', { status })));
    await expect(client.channel(channelId, 0)).rejects.toBeInstanceOf(RequestError);
  });
  it.each(['<html>error</html>', '{}', '[{"id":1268995994440302725}]'])('rejects malformed or unsafe response %s', async body => {
    await expect(new KemonoClient(vi.fn().mockResolvedValue(new Response(body))).channel(channelId, 0)).rejects.toThrow();
  });
  it('maps only safe image paths', () => {
    const path = '/82/79/8279311a88d313cf25b6f1ad302ac7f82203f9712829b82785b0b3fac3e0871e.png';
    expect(makeThumbnailUrl(path)).toBe(`https://img.kemono.cr/thumbnail/data${path}`);
    expect(safeMediaUrl(makeThumbnailUrl(path))).toBe(makeThumbnailUrl(path));
    expect(safeMediaUrl('https://file.pawchive.pw/data' + path)).toBe('https://file.pawchive.pw/data' + path);
    expect(safeMediaUrl('https://file.pawchive.pw.evil.example/data' + path)).toBeNull();
    expect(makeThumbnailUrl('/../../evil.png')).toBeNull();
    expect(safeMediaUrl('https://img.kemono.cr.evil.example/thumbnail/data' + path)).toBeNull();
    expect(safeMediaUrl('https://cdn.discordapp.com/avatars/123/avatar.png')).toBeNull();
  });
  it('honors seconds and HTTP-date Retry-After', () => {
    expect(retryAfter('120')).toBe(120000);
    expect(retryAfter('Fri, 09 Oct 2026 00:02:00 GMT', Date.parse('2026-10-09T00:00:00Z'))).toBe(120000);
  });
});
