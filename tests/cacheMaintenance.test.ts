import 'fake-indexeddb/auto';
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ offscreen: vi.fn(), release: vi.fn() }));
vi.mock('../src/background/offscreenBridge', () => mocks);
import { cacheList, cacheSettings, cleanupSuccessfulZip, maintainZipCaches, removeJobCache } from '../src/services/cacheMaintenance';
import { commitPage, deleteLocalRecords, getCacheSettings, getJob, getMedia, getPostJob, getPostJobs, getSavingPostJobs, saveCacheSettings, savePostJob } from '../src/storage/database';
import type { PostJob } from '../src/services/posts/types';
import { job } from './helpers';
import { normalizeMessages } from '../src/core/mediaNormalizer';
import { scope } from './helpers';
import messages from './fixtures/channel-1268995994440302725-0.sanitized.json';

const now = Date.parse('2026-10-10T10:00:00Z');
const archive = { state: 'saved' as const, filename: 'archive.zip', blobUrl: null, downloadId: 12, bytes: 50, entries: 1, progress: 1, total: 1, error: null };
function post(id: string, status: PostJob['status'] = 'finished'): PostJob {
  return { id, service: 'posts', source: { origin: 'https://pawchive.pw', platform: 'fanbox', creatorId: '123', postId: null }, sourceUrl: '', creatorName: 'Creator', createdAt: new Date(now - 600_000).toISOString(), updatedAt: '', status, resumeStatus: 'downloading', selection: { quality: 'full res', images: true, files: true, text: true }, scan: { offset: 0, pages: 1, total: 0, complete: true, error: null, attempts: 0, nextAt: 0, fingerprints: [] }, posts: [], tasks: [], detailQueue: [], archive: { ...archive }, nextAt: 0, error: null, destination: { kind: 'zip' } };
}
beforeEach(async () => {
  await deleteLocalRecords(); await saveCacheSettings({ retentionMinutes: 5, lastCheckAt: 0, removedCaches: 0 });
  vi.clearAllMocks(); mocks.offscreen.mockResolvedValue({ removed: [] }); mocks.release.mockResolvedValue(undefined);
});

it('checks once per minute and preserves active, paused, packaging, and saving jobs', async () => {
  for (const status of ['scanning', 'downloading', 'paused', 'finished'] as const) await savePostJob(post(status, status));
  const saving = post('saving'); saving.archive!.state = 'saving'; await savePostJob(saving);
  const building = post('building'); building.archive!.state = 'building'; await savePostJob(building);
  await maintainZipCaches(now); await maintainZipCaches(now + 59_000);
  expect(mocks.offscreen).toHaveBeenCalledTimes(1);
  expect(mocks.offscreen.mock.calls[0]).toEqual(['zip-prune', { cleanup: {
    before: now - 300_000,
    protectedJobIds: expect.arrayContaining(['scanning', 'downloading', 'paused', 'saving', 'building']),
    jobUpdatedAt: expect.any(Object),
  } }]);
  expect(mocks.offscreen.mock.calls[0][1].cleanup.protectedJobIds).not.toContain('finished');
  await maintainZipCaches(now + 60_000); expect(mocks.offscreen).toHaveBeenCalledTimes(2);
});

it('clears expired ZIPs while retaining saved counts, discovery and folder history', async () => {
  const discord = { ...job(), status: 'finished' as const, destination: { kind: 'zip' as const }, archive: { ...archive } };
  const records = normalizeMessages(messages, scope, discord.id).slice(0, 2);
  records[0].status = 'downloaded'; records[1].status = 'downloaded';
  await commitPage(discord, records);
  const postJob = post('post');
  postJob.posts = [{ id: '1', title: 'Keep discovered post', content: 'Text', published: null, hasFull: true, media: [], embed: null }];
  postJob.tasks = [{ id: 'task', postId: '1', quality: 'full res', kind: 'text', url: null, path: 'post.txt', status: 'downloaded', bytes: 4, attempts: 1, nextAt: 0, error: null }];
  await savePostJob(postJob);
  const folder = post('folder'); folder.destination = { kind: 'folder', name: 'Creator', directoryId: 'folder-id' }; folder.archive = undefined;
  await savePostJob(folder);
  mocks.offscreen.mockResolvedValue({ removed: [discord.id, 'post', 'folder', 'orphan'] });
  await maintainZipCaches(now);
  expect((await getJob(discord.id))?.archive).toMatchObject({ state: 'saved', cacheCleared: true }); expect((await getJob(discord.id))?.status).toBe('finished');
  expect((await getJob(discord.id))?.channels).toEqual(discord.channels); expect((await getMedia(discord.id)).map(record => record.status)).toEqual(['downloaded', 'downloaded']);
  const expired = await getPostJob('post'); expect(expired?.archive).toMatchObject({ state: 'saved', cacheCleared: true }); expect(expired?.status).toBe('finished');
  expect(expired?.posts).toEqual(postJob.posts); expect(expired?.tasks).toEqual(postJob.tasks);
  expect((await getPostJob('folder'))?.status).toBe('finished'); expect((await getPostJob('folder'))?.destination).toEqual(folder.destination);
  expect(await getCacheSettings()).toMatchObject({ retentionMinutes: 5, lastCheckAt: now, removedCaches: 4 });
});

it('lists each private cache with size, job name and protection without loading full history', async () => {
  const active = post('active', 'paused'); await savePostJob(active);
  mocks.offscreen.mockResolvedValue([
    { id: 'active', bytes: 100, files: 2, lastUsedAt: now, hasArchive: true },
    { id: 'orphan', bytes: 20, files: 1, lastUsedAt: now, hasArchive: false },
  ]);
  const list = await cacheList(); expect(list.bytes).toBe(120);
  expect(list.caches).toEqual([
    expect.objectContaining({ id: 'active', title: 'Creator', service: 'posts', protected: true }),
    expect.objectContaining({ id: 'orphan', service: 'orphan', protected: false }),
  ]);
});

it('removes a specific unused cache, preserves other jobs and rejects protected or unsafe IDs', async () => {
  await savePostJob(post('selected')); await savePostJob(post('retained'));
  await savePostJob(post('paused', 'paused')); await savePostJob(post('active', 'downloading'));
  await removeJobCache('selected');
  expect(mocks.offscreen).toHaveBeenCalledWith('cache-remove', { jobId: 'selected' });
  expect((await getPostJob('selected'))?.archive?.cacheCleared).toBe(true);
  expect((await getPostJob('retained'))?.archive?.cacheCleared).not.toBe(true);
  await removeJobCache('orphan'); expect(mocks.offscreen).toHaveBeenCalledWith('cache-remove', { jobId: 'orphan' });
  for (const id of ['paused', 'active', '../outside', '']) await expect(removeJobCache(id)).rejects.toThrow();
  expect(mocks.offscreen).toHaveBeenCalledTimes(2);
});

it('keeps saved completion when optional cleanup fails and retries independently of idle expiry', async () => {
  await cacheSettings({ type: 'LOCAL_SETTINGS', retentionMinutes: 0, clearAfterDownload: true });
  const saved = post('saved'); await savePostJob(saved);
  mocks.offscreen.mockRejectedValueOnce(new Error('Cache is busy'));
  await cleanupSuccessfulZip(saved);
  expect((await getPostJob(saved.id))?.archive).toMatchObject({ state: 'saved', cacheCleanupError: expect.stringContaining('retry') });
  expect((await getPostJob(saved.id))?.status).toBe('finished');
  await maintainZipCaches(now);
  expect((await getPostJob(saved.id))?.archive).toMatchObject({ state: 'saved', cacheCleared: true, cacheCleanupError: null });
});

it('resets an unsaved export for redownload after manual removal and leaves it intact on failure', async () => {
  const ready = post('ready'); ready.archive!.state = 'ready'; await savePostJob(ready);
  mocks.offscreen.mockRejectedValueOnce(new Error('Busy'));
  await expect(removeJobCache(ready.id)).rejects.toThrow('Busy');
  expect((await getPostJob(ready.id))?.archive?.state).toBe('ready');
  await removeJobCache(ready.id);
  expect((await getPostJob(ready.id))?.archive).toBeUndefined(); expect((await getPostJob(ready.id))?.status).toBe('ready');
});

it('does not clear bytes for a pending, interrupted or missing successful save', async () => {
  await cacheSettings({ type: 'LOCAL_SETTINGS', clearAfterDownload: true });
  for (const state of ['pending', 'building', 'ready', 'saving', 'failed'] as const) {
    const value = post(state); value.archive!.state = state; await cleanupSuccessfulZip(value);
  }
  expect(mocks.offscreen).not.toHaveBeenCalled();
  await expect(cacheSettings({ type: 'LOCAL_SETTINGS', clearAfterDownload: 'yes' as unknown as boolean })).rejects.toThrow();
  expect((await getCacheSettings()).clearAfterDownload).toBe(true);
});

it('supports disabling cleanup and rejects invalid settings without changing them', async () => {
  await cacheSettings({ type: 'LOCAL_SETTINGS', retentionMinutes: 0 }); await maintainZipCaches(now);
  expect(mocks.offscreen).not.toHaveBeenCalled();
  for (const retentionMinutes of [-1, 11, 1.5, NaN]) await expect(cacheSettings({ type: 'LOCAL_SETTINGS', retentionMinutes })).rejects.toThrow('1–10 minutes');
  expect((await getCacheSettings()).retentionMinutes).toBe(0);
  expect((await cacheSettings({ type: 'LOCAL_SETTINGS', retentionMinutes: 10 })).retentionMinutes).toBe(10);
});

it('retries a failed cleanup without advancing the check time', async () => {
  mocks.offscreen.mockRejectedValueOnce(new Error('Storage is unavailable'));
  await expect(maintainZipCaches(now)).rejects.toThrow('Storage is unavailable');
  expect((await getCacheSettings()).lastCheckAt).toBe(0);
  await maintainZipCaches(now); expect((await getCacheSettings()).lastCheckAt).toBe(now);
});

it('reads only active jobs or pending ZIP saves through IndexedDB indexes', async () => {
  await savePostJob(post('active', 'downloading')); await savePostJob(post('completed'));
  const saving = post('saving'); saving.archive!.state = 'saving'; await savePostJob(saving);
  expect((await getPostJobs(['scanning', 'downloading'])).map(job => job.id)).toEqual(['active']);
  expect((await getSavingPostJobs()).map(job => job.id)).toEqual(['saving']);
  const changed = (await getPostJob('active'))!; changed.status = 'finished'; await savePostJob(changed);
  expect(await getPostJobs(['scanning', 'downloading'])).toEqual([]);
});
