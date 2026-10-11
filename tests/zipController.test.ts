import 'fake-indexeddb/auto';
import { expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ offscreen: vi.fn(), release: vi.fn() }));
vi.mock('../src/background/offscreenBridge', () => ({ ...mocks, saveText: vi.fn() }));
import { command, tick } from '../src/background/controller';
import { commitPage, getJob, getMedia } from '../src/storage/database';
import { normalizeMessages } from '../src/core/mediaNormalizer';
import { job, scope } from './helpers';
import messages from './fixtures/channel-1268995994440302725-0.sanitized.json';

it('collects at most two images at a time and schedules the next ZIP batch without the old long idle gap', async () => {
  const archive = { ...job(), status: 'downloading' as const, destination: { kind: 'zip' as const }, autoManifest: true };
  const records = normalizeMessages(messages, scope, archive.id).slice(0, 3);
  for (const record of records) record.status = 'queued'; await commitPage(archive, records);
  let active = 0, maximum = 0; const finish: (() => void)[] = [];
  mocks.offscreen.mockImplementation(async (action: string) => {
    if (action !== 'image') return null;
    maximum = Math.max(maximum, ++active);
    await new Promise<void>(resolve => finish.push(resolve)); active--;
    return { blobUrl: 'blob:image', bytes: 8, ext: 'jpg', mime: 'image/jpeg', sha256: 'hash', width: 1, height: 1 };
  });
  mocks.release.mockResolvedValue(undefined);
  const download = vi.fn(); vi.stubGlobal('chrome', { downloads: { download } });
  const running = tick();
  await vi.waitFor(() => expect(finish).toHaveLength(2)); expect(maximum).toBe(2);
  for (const complete of finish) complete();
  const delay = await running; expect(delay).toBeGreaterThanOrEqual(100); expect(delay).toBeLessThanOrEqual(250);
  const saved = await getMedia(archive.id); expect(saved.filter(r => r.status === 'staged')).toHaveLength(2); expect(saved.filter(r => r.status === 'queued')).toHaveLength(1);
  expect(download).not.toHaveBeenCalled(); vi.unstubAllGlobals();
});
it('switches an existing paused browser job to ZIP and only reuses verified cache entries', async () => {
  const archive = { ...job(), id: 'switch-zip', status: 'paused' as const, resumeStatus: 'downloading' as const, autoManifest: true, destination: { kind: 'browser' as const } };
  const records = normalizeMessages(messages, scope, archive.id).slice(0, 2); for (const record of records) record.status = 'downloaded'; await commitPage(archive, records);
  mocks.offscreen.mockResolvedValue({ ids: [records[0].id] }); mocks.release.mockResolvedValue(undefined);
  await command({ type: 'DESTINATION', jobId: archive.id, kind: 'zip' }, {});
  expect((await getJob(archive.id))?.destination?.kind).toBe('zip');
  const saved = await getMedia(archive.id); expect(saved.find(r => r.id === records[0].id)?.status).toBe('staged'); expect(saved.find(r => r.id === records[1].id)?.status).toBe('queued');
});
