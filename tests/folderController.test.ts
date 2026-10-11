import 'fake-indexeddb/auto';
import { expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ requireDirectory: vi.fn(), fileMatches: vi.fn(), release: vi.fn() }));
vi.mock('../src/storage/destination', async importOriginal => ({ ...await importOriginal<typeof import('../src/storage/destination')>(), requireDirectory: mocks.requireDirectory }));
vi.mock('../src/storage/folderWriter', () => ({ fileMatches: mocks.fileMatches }));
vi.mock('../src/background/offscreenBridge', () => ({ release: mocks.release, offscreen: vi.fn(), saveText: vi.fn() }));
import { command, tick } from '../src/background/controller';
import { FolderPermissionError } from '../src/storage/destination';
import { getJob, getMedia, saveJob, saveMedia } from '../src/storage/database';
import { normalizeMessages } from '../src/core/mediaNormalizer';
import { job, scope } from './helpers';
import messages from './fixtures/channel-1268995994440302725-0.sanitized.json';
it('pauses the whole batch on folder permission loss and requires access before resume', async () => {
  const archive = { ...job(), status: 'downloading' as const, destination: { kind: 'folder' as const, name: 'Pictures' } };
  await saveJob(archive); mocks.requireDirectory.mockRejectedValue(new FolderPermissionError());
  await tick(); const paused = (await getJob(archive.id))!;
  expect(paused.status).toBe('paused'); expect(paused.resumeStatus).toBe('downloading'); expect(paused.destinationError).toContain('Allow folder access');
  await expect(command({ type: 'ACTION', jobId: archive.id, action: 'resume' }, {})).rejects.toBeInstanceOf(FolderPermissionError);
  mocks.requireDirectory.mockResolvedValue({ name: 'Pictures' });
  await command({ type: 'ACTION', jobId: archive.id, action: 'resume' }, {});
  expect((await getJob(archive.id))?.status).toBe('downloading'); expect((await getJob(archive.id))?.destinationError).toBeNull();
});
it('moves an existing paused browser job to a folder while preserving verified files and requeueing missing files', async () => {
  const archive = { ...job(), id: 'migration-job', status: 'paused' as const, resumeStatus: 'downloading' as const, autoManifest: true };
  await saveJob(archive);
  const records = normalizeMessages(messages, scope, archive.id).slice(0, 3);
  for (const [index, record] of records.entries()) {
    record.status = index === 2 ? 'transferring' : index === 0 ? 'staged' : 'downloaded'; record.savedPath = `ArchiveRoot/${index}.jpg`; record.sha256 = 'hash'; record.bytes = 10;
    record.downloadId = index === 2 ? 42 : null; await saveMedia(record);
  }
  const cancel = vi.fn().mockResolvedValue(undefined); vi.stubGlobal('chrome', { downloads: { cancel } });
  mocks.release.mockResolvedValue(undefined); mocks.requireDirectory.mockResolvedValue({ name: 'New destination' }); mocks.fileMatches.mockImplementation(async (_jobId, path) => path === 'ArchiveRoot/0.jpg');
  await command({ type: 'DESTINATION', jobId: archive.id, kind: 'folder' }, {});
  const saved = await getMedia(archive.id);
  expect(saved.find(r => r.id === records[0].id)?.status).toBe('downloaded');
  expect(saved.find(r => r.id === records[1].id)?.status).toBe('queued');
  expect(saved.find(r => r.id === records[2].id)?.downloadId).toBeNull(); expect(cancel).toHaveBeenCalledWith(42);
  expect((await getJob(archive.id))?.destination).toEqual({ kind: 'folder', name: 'New destination' }); vi.unstubAllGlobals();
});
