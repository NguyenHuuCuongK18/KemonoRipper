import 'fake-indexeddb/auto';
import { afterEach, it, expect, vi } from 'vitest';
import { command, tick } from '../src/background/controller';
import { getJob } from '../src/storage/database';
import { scope } from './helpers';
import server from './fixtures/server.sanitized.json';
const url = `https://kemono.cr/discord/server/${scope.serverId}/${scope.channelId}`;
afterEach(() => vi.unstubAllGlobals());
it('scans the current channel when discovery fails, preserves rate-limit checkpoints, and resumes the same offset', async () => {
  const transport = vi.fn().mockImplementation(async (url: string) => url.includes('/server/') ? new Response('denied', { status: 403 }) : new Response('limited', { status: 429, headers: { 'retry-after': '120' } }));
  vi.stubGlobal('fetch', transport); vi.stubGlobal('chrome', { tabs: { query: vi.fn().mockResolvedValue([]) } });
  const created = await command({ type: 'START', url, channelIds: [scope.channelId], mode: 'thumbnail', tryOriginal: false }, {}) as { jobId: string };
  await tick(); const archive = (await getJob(created.jobId))!;
  expect(archive.channels).toHaveLength(1); expect(archive.channels[0].offset).toBe(0); expect(archive.channels[0].terminal).toBeNull();
  expect(archive.channels[0].failures[0].reason).toContain('429'); expect(archive.apiNextAt).toBeGreaterThan(Date.now() + 119000);
  const count = transport.mock.calls.length; await tick(); expect(transport).toHaveBeenCalledTimes(count);
  vi.spyOn(Date, 'now').mockReturnValue(archive.apiNextAt + 1);
  transport.mockResolvedValue(new Response('[]', { headers: { 'content-type': 'text/css' } }));
  await tick(); expect((await getJob(created.jobId))?.channels[0].coverage).toBe('complete');
  await tick(); expect((await getJob(created.jobId))?.status).toBe('indexed');
  vi.restoreAllMocks();
});
it('starts all server channels directly from the root, including zero-count channels', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(server))));
  vi.stubGlobal('chrome', { tabs: { query: vi.fn().mockResolvedValue([]) } });
  const created = await command({ type: 'START', url: `https://kemono.cr/discord/server/${scope.serverId}?o=150#navigation`, channelIds: [], mode: 'thumbnail', tryOriginal: false }, {}) as { jobId: string };
  const archive = (await getJob(created.jobId))!;
  expect(archive.scope).toBe('server'); expect(archive.channels.map(c => c.channelId)).toEqual(server.channels.map(c => c.id));
  expect(archive.sourceUrl).toBe(`https://kemono.cr/discord/server/${scope.serverId}`);
  expect(archive.channels.some(c => c.postCount === 0)).toBe(true);
});
it('allows a DOM-discovered server job when the metadata endpoint is denied', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('denied', { status: 403 })));
  const page = { serverId: scope.serverId, serverName: 'DOM server', channels: [{ id: scope.channelId, name: 'DOM channel' }] };
  vi.stubGlobal('chrome', { tabs: { query: vi.fn().mockResolvedValue([{ id: 1, url }]), sendMessage: vi.fn().mockResolvedValue(page) } });
  const created = await command({ type: 'START', url: `https://kemono.cr/discord/server/${scope.serverId}`, channelIds: [], mode: 'thumbnail', tryOriginal: false }, {}) as { jobId: string };
  const archive = (await getJob(created.jobId))!;
  expect(archive.channels[0].channelId).toBe(scope.channelId); expect(archive.channelDiscovery).toBe('dom'); expect(archive.warnings[0]).toContain('hidden or unloaded');
});
it('does not silently fall back to the redirected current channel for an entire-server request', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('denied', { status: 403 })));
  vi.stubGlobal('chrome', { tabs: { query: vi.fn().mockResolvedValue([]) } });
  await expect(command({ type: 'START', url, channelIds: [scope.channelId], allChannels: true, mode: 'thumbnail', tryOriginal: false }, {})).rejects.toThrow();
});
