import 'fake-indexeddb/auto';
import { beforeEach, it, expect, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ offscreen: vi.fn(), release: vi.fn() }));
vi.mock('../src/background/offscreenBridge', () => mocks);
import { newArchive, prepareZip, reconcileZip, saveZip } from '../src/background/zipArchive';
import { commitPage, getJob, getMedia, saveCacheSettings } from '../src/storage/database';
import { normalizeMessages } from '../src/core/mediaNormalizer';
import { job, scope } from './helpers';
import messages from './fixtures/channel-1268995994440302725-0.sanitized.json';
import type { Job } from '../src/core/types';
const download = vi.fn(), search = vi.fn();
beforeEach(async () => {
  await saveCacheSettings({ retentionMinutes: 5, clearAfterDownload: false, lastCheckAt: 0, removedCaches: 0 });
  vi.clearAllMocks(); download.mockResolvedValue(77); mocks.release.mockResolvedValue(undefined);
  vi.stubGlobal('chrome', { downloads: { download, search } });
});
it('clears private bytes only after Chrome confirms the complete ZIP and keeps successful history', async () => {
  await saveCacheSettings({ retentionMinutes: 5, clearAfterDownload: true, lastCheckAt: 0, removedCaches: 0 });
  const archive = archiveJob(); archive.status = 'finished'; archive.archive.state = 'saving'; archive.archive.downloadId = 77;
  const records = normalizeMessages(messages, scope, archive.id).slice(0, 1); records[0].status = 'staged';
  await commitPage(archive, records);
  search.mockResolvedValue([{ id: 77, state: 'in_progress', exists: true }]); await reconcileZip(archive);
  expect(mocks.offscreen).not.toHaveBeenCalledWith('cache-remove', expect.anything());
  search.mockResolvedValue([{ id: 77, state: 'complete', exists: true }]); await reconcileZip(archive);
  expect(mocks.offscreen).toHaveBeenCalledWith('cache-remove', { jobId: archive.id });
  expect((await getJob(archive.id))?.archive).toMatchObject({ state: 'saved', cacheCleared: true });
  expect((await getJob(archive.id))?.status).toBe('finished'); expect((await getMedia(archive.id))[0].status).toBe('downloaded');
  await expect(saveZip((await getJob(archive.id))!)).rejects.toThrow('cleared');
});
it.each(['interrupted', 'missing'])('retains ZIP data after an %s download even when immediate cleanup is enabled', async outcome => {
  await saveCacheSettings({ retentionMinutes: 5, clearAfterDownload: true, lastCheckAt: 0, removedCaches: 0 });
  const archive = archiveJob(); archive.archive.state = 'saving'; archive.archive.downloadId = 77;
  search.mockResolvedValue([{ id: 77, state: outcome === 'missing' ? 'complete' : 'interrupted', exists: outcome !== 'missing' }]);
  await reconcileZip(archive);
  expect(archive.archive.state).toBe('ready'); expect(mocks.offscreen).not.toHaveBeenCalledWith('cache-remove', expect.anything());
});
function archiveJob(): Job & { archive: NonNullable<Job['archive']> } { const result = { ...job(), status: 'downloading' as const, destination: { kind: 'zip' as const } }; return { ...result, archive: newArchive(result) }; }
it('starts ZIP packaging without blocking for its completion or starting browser downloads', async () => {
  const archive = archiveJob(); mocks.offscreen.mockResolvedValue(null);
  await prepareZip(archive, []);
  expect(archive.archive.state).toBe('building'); expect(mocks.offscreen).toHaveBeenCalledWith('zip-build-start', expect.anything()); expect(download).not.toHaveBeenCalled();
});
it('creates one explicit browser Save request only after the ZIP is ready', async () => {
  const archive = archiveJob(); archive.archive.state = 'building';
  mocks.offscreen.mockResolvedValueOnce({ state: 'ready', progress: 8, total: 8, bytes: 100, entries: 8, error: null }).mockResolvedValueOnce({ blobUrl: 'blob:zip', bytes: 100 });
  await prepareZip(archive, []);
  expect(download).toHaveBeenCalledTimes(1); expect(download).toHaveBeenCalledWith(expect.objectContaining({ filename: expect.stringMatching(/\.zip$/), saveAs: true }));
  expect(archive.archive.state).toBe('saving'); expect(archive.manifestState).toBe('saving');
});
it('keeps collected images reusable after cancelling the single Save dialog', async () => {
  const archive = archiveJob(); archive.archive.state = 'ready'; download.mockRejectedValueOnce(new Error('USER_CANCELED'));
  mocks.offscreen.mockResolvedValue({ blobUrl: 'blob:zip', bytes: 100 });
  await saveZip(archive); expect(archive.archive.state).toBe('ready'); expect(archive.archive.error).toContain('remain cached');
  await saveZip(archive); expect(archive.archive.state).toBe('saving'); expect(download).toHaveBeenCalledTimes(2);
  expect(mocks.offscreen.mock.calls.every(call => call[0] === 'zip-open')).toBe(true);
});
it('marks staged files as downloaded only when the entire ZIP download completes', async () => {
  const archive = archiveJob(); archive.archive.state = 'saving'; archive.archive.downloadId = 77; archive.archive.blobUrl = 'blob:zip';
  const records = normalizeMessages(messages, scope, archive.id).slice(0, 2); records[0].status = 'staged'; records[1].status = 'failed';
  await commitPage(archive, records);
  search.mockResolvedValue([{ id: 77, state: 'in_progress', exists: true }]); await reconcileZip(archive);
  expect((await getMedia(archive.id))[0].status).not.toBe('downloaded');
  search.mockResolvedValue([{ id: 77, state: 'complete', exists: true }]); await reconcileZip(archive);
  expect((await getMedia(archive.id)).find(r => r.id === records[0].id)?.status).toBe('downloaded');
  expect((await getMedia(archive.id)).find(r => r.id === records[1].id)?.status).toBe('failed');
  expect((await getJob(archive.id))?.archive?.state).toBe('saved');
});
it('recovers a browser ZIP download created before its ID was committed', async () => {
  const archive = archiveJob(); archive.archive.state = 'saving'; archive.archive.blobUrl = 'blob:zip';
  await commitPage(archive, []); search.mockResolvedValue([{ id: 88, state: 'complete', exists: true, url: 'blob:zip' }]);
  await reconcileZip(archive, true); expect(archive.archive.state).toBe('saved'); expect(archive.archive.downloadId).toBe(88); expect(download).not.toHaveBeenCalled();
});
it('makes interrupted ZIPs ready to save again instead of refetching images', async () => {
  const archive = archiveJob(); archive.archive.state = 'saving'; archive.archive.downloadId = 77;
  search.mockResolvedValue([{ id: 77, state: 'interrupted' }]); await reconcileZip(archive, true);
  expect(archive.archive.state).toBe('ready'); expect(download).not.toHaveBeenCalled();
});
it('restarts packaging after an offscreen restart without discarding collected media', async () => {
  const archive = archiveJob(); archive.archive.state = 'building'; mocks.offscreen.mockResolvedValue(null);
  await prepareZip(archive, []); expect(archive.archive.state).toBe('pending'); expect(download).not.toHaveBeenCalled();
});
