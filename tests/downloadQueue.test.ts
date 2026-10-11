import { beforeEach, it, expect, vi } from 'vitest';
import messages from './fixtures/channel-1268995994440302725-0.sanitized.json';
import { normalizeMessages } from '../src/core/mediaNormalizer';
import { scope, job } from './helpers';
const mocks = vi.hoisted(() => ({ offscreen: vi.fn(), release: vi.fn(), saveMedia: vi.fn(), fileMatches: vi.fn() }));
vi.mock('../src/background/offscreenBridge', () => ({ offscreen: mocks.offscreen, release: mocks.release }));
vi.mock('../src/storage/database', () => ({ saveMedia: mocks.saveMedia }));
vi.mock('../src/storage/folderWriter', () => ({ fileMatches: mocks.fileMatches }));
import { FolderPermissionError } from '../src/storage/destination';
import { ZipStorageError } from '../src/storage/zipCache';
import { reconcileImage, startImage } from '../src/background/downloadQueue';
const download = vi.fn(), search = vi.fn();
const image = { blobUrl: 'blob:chrome-extension://test/image', ext: 'png', mime: 'image/png', bytes: 55959, width: 800, height: 593, sha256: 'eb1d7a6022f5772f1e7b8cf8d94223b271601c43dc15b29ef6899d5f7aadab43' };
beforeEach(() => {
  vi.clearAllMocks(); download.mockResolvedValue(42); mocks.release.mockResolvedValue(undefined); mocks.saveMedia.mockResolvedValue(undefined);
  vi.stubGlobal('chrome', { downloads: { download, search }, permissions: { contains: vi.fn().mockResolvedValue(true) } });
});
it('requires browser completion after byte validation before marking downloaded', async () => {
  const record = normalizeMessages(messages, scope, 'test-job')[0]; mocks.offscreen.mockResolvedValue(image);
  await startImage(record, job()); expect(record.status).toBe('transferring'); expect(record.sha256).not.toBe(record.kemonoFileHash);
  search.mockResolvedValue([{ id: 42, state: 'complete', exists: true }]); await reconcileImage(record);
  expect(record.status).toBe('downloaded'); expect(record.blobUrl).toBeNull();
});
it('falls back to a thumbnail after an explicitly enabled original fails', async () => {
  const record = normalizeMessages(messages, scope, 'test-job')[0]; record.originalUrl = 'https://n3.kemono.cr/data' + record.kemonoPath;
  mocks.offscreen.mockResolvedValueOnce({ failure: 'Image HTTP 404', status: 404 }).mockResolvedValueOnce(image);
  await startImage(record, { ...job(), mode: 'best', tryOriginal: true });
  expect(record.quality).toBe('thumbnail'); expect(record.candidateFailures[0].reason).toContain('404'); expect(download).toHaveBeenCalledTimes(1);
});
it('honors a rate limit before attempting any fallback host', async () => {
  const record = normalizeMessages(messages, scope, 'test-job')[0]; record.originalUrl = 'https://n3.kemono.cr/data' + record.kemonoPath;
  mocks.offscreen.mockResolvedValue({ failure: 'Image HTTP 429', status: 429, retryAfterMs: 120000 });
  const now = Date.now(); const delay = await startImage(record, { ...job(), mode: 'best', tryOriginal: true });
  expect(delay).toBe(120000); expect(record.nextAttemptAt).toBeGreaterThanOrEqual(now + 120000); expect(mocks.offscreen).toHaveBeenCalledTimes(1); expect(download).not.toHaveBeenCalled();
});
it('caps failed image attempts and never downloads a rejected body', async () => {
  const record = normalizeMessages(messages, scope, 'test-job')[0]; mocks.offscreen.mockRejectedValue(new Error('HTML body'));
  await startImage(record, job()); await startImage(record, job()); await startImage(record, job());
  expect(record.status).toBe('failed'); expect(record.attempts).toBe(3); expect(download).not.toHaveBeenCalled();
});
it('reconciles a browser download created before its ID was committed', async () => {
  const record = normalizeMessages(messages, scope, 'test-job')[0]; record.status = 'transferring'; record.savedPath = 'ArchiveRoot/file.png'; record.blobUrl = image.blobUrl;
  search.mockResolvedValue([{ id: 77, url: image.blobUrl, state: 'complete', exists: true }]);
  await reconcileImage(record, true); expect(record.downloadId).toBe(77); expect(record.status).toBe('downloaded'); expect(download).not.toHaveBeenCalled();
});
it('requeues an interrupted transfer without losing its durable identity', async () => {
  const record = normalizeMessages(messages, scope, 'test-job')[0]; record.status = 'transferring'; record.attempts = 1; record.downloadId = 42;
  search.mockResolvedValue([{ id: 42, state: 'interrupted', error: 'NETWORK_FAILED' }]);
  await reconcileImage(record, true); expect(record.status).toBe('queued'); expect(record.downloadId).toBeNull(); expect(record.errorMessage).toBe('NETWORK_FAILED');
});
it('saves a validated image directly to the chosen folder without invoking browser downloads', async () => {
  const record = normalizeMessages(messages, scope, 'test-job')[0];
  mocks.offscreen.mockResolvedValueOnce(image).mockResolvedValueOnce({ path: 'ArchiveRoot/chosen/image.jpg' });
  await startImage(record, { ...job(), destination: { kind: 'folder', name: 'Pictures' } });
  expect(record.status).toBe('downloaded'); expect(record.savedPath).toBe('ArchiveRoot/chosen/image.jpg'); expect(download).not.toHaveBeenCalled();
});
it('keeps work queued when folder access is revoked without consuming image retries', async () => {
  const record = normalizeMessages(messages, scope, 'test-job')[0];
  mocks.offscreen.mockResolvedValueOnce(image).mockRejectedValueOnce(new FolderPermissionError());
  await expect(startImage(record, { ...job(), destination: { kind: 'folder', name: 'Pictures' } })).rejects.toBeInstanceOf(FolderPermissionError);
  expect(record.status).toBe('queued'); expect(record.attempts).toBe(0); expect(download).not.toHaveBeenCalled();
});
it('recovers a committed folder write by matching its checksum without browser history', async () => {
  const record = normalizeMessages(messages, scope, 'test-job')[0];
  record.status = 'transferring'; record.savedPath = 'ArchiveRoot/image.jpg'; record.sha256 = image.sha256; record.bytes = image.bytes;
  mocks.fileMatches.mockResolvedValue(true);
  await reconcileImage(record, true, { ...job(), destination: { kind: 'folder', name: 'Pictures' } });
  expect(record.status).toBe('downloaded'); expect(search).not.toHaveBeenCalled(); expect(download).not.toHaveBeenCalled();
});
it('stages ZIP images on local disk without creating individual browser downloads', async () => {
  const record = normalizeMessages(messages, scope, 'test-job')[0]; mocks.offscreen.mockResolvedValueOnce(image).mockResolvedValueOnce(null);
  await startImage(record, { ...job(), destination: { kind: 'zip' } });
  expect(record.status).toBe('staged'); expect(record.downloadId).toBeNull(); expect(download).not.toHaveBeenCalled();
  expect(mocks.offscreen).toHaveBeenCalledWith('stage-image', expect.objectContaining({ recordId: record.id }));
});
it('recovers an interrupted image collection from its persisted ZIP cache', async () => {
  const record = normalizeMessages(messages, scope, 'test-job')[0]; record.status = 'transferring';
  mocks.offscreen.mockResolvedValue({ ids: [record.id] }); await reconcileImage(record, true, { ...job(), destination: { kind: 'zip' } });
  expect(record.status).toBe('staged'); expect(download).not.toHaveBeenCalled(); expect(search).not.toHaveBeenCalled();
});
it('preserves retry budget and pauses collection when the ZIP disk cache cannot be written', async () => {
  const record = normalizeMessages(messages, scope, 'test-job')[0];
  mocks.offscreen.mockResolvedValueOnce(image).mockRejectedValueOnce(new ZipStorageError());
  await expect(startImage(record, { ...job(), destination: { kind: 'zip' } })).rejects.toBeInstanceOf(ZipStorageError);
  expect(record.status).toBe('queued'); expect(record.attempts).toBe(0); expect(download).not.toHaveBeenCalled();
});
