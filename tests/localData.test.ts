import 'fake-indexeddb/auto';
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ offscreen: vi.fn() }));
vi.mock('../src/background/offscreenBridge', () => mocks);
import { clearLocalData, type ClearLocalData } from '../src/services/localData';
import { commitPage, deleteLocalRecords, getJob, getJobs, getMedia, getPostJob, getPostJobs, saveMedia, savePostJob } from '../src/storage/database';
import { forgetDirectories, getDirectory, saveDirectory, type ArchiveDirectory } from '../src/storage/destination';
import { normalizeMessages } from '../src/core/mediaNormalizer';
import type { PostJob } from '../src/services/posts/types';
import { job, scope } from './helpers';
import messages from './fixtures/channel-1268995994440302725-0.sanitized.json';

const cancel = vi.fn();
const folder = { kind: 'directory', name: 'Saved archive' } as ArchiveDirectory;
function postJob(id = 'post-job', directoryId = 'post-folder'): PostJob {
  return { id, service: 'posts', source: { origin: 'https://pawchive.pw', platform: 'fanbox', creatorId: '123', postId: null },
    sourceUrl: 'https://pawchive.pw/fanbox/user/123', creatorName: 'Test creator', createdAt: '', updatedAt: '', status: 'downloading', resumeStatus: 'downloading',
    selection: { quality: 'both', images: true, files: true, text: true },
    scan: { offset: 0, pages: 0, total: 0, complete: true, error: null, attempts: 0, nextAt: 0, fingerprints: [] },
    posts: [], detailQueue: [], tasks: [], archive: undefined, nextAt: 0, error: null, destination: { kind: 'folder', directoryId, name: folder.name } };
}
beforeEach(async () => {
  await deleteLocalRecords(); await forgetDirectories(); vi.clearAllMocks();
  mocks.offscreen.mockResolvedValue(null); cancel.mockResolvedValue(undefined);
  vi.stubGlobal('chrome', { downloads: { cancel } });
});

it('removes one Discord job, its media, and its unused folder connection while retaining other jobs', async () => {
  const selected = { ...job(), destination: { kind: 'folder' as const, name: folder.name } };
  const records = normalizeMessages(messages, scope, selected.id).slice(0, 2);
  records[0].status = 'transferring'; records[0].downloadId = 7; records[0].blobUrl = 'blob:active';
  records[1].status = 'downloaded'; records[1].downloadId = 8;
  await commitPage(selected, records); await saveDirectory(selected.id, folder);
  const retained = { ...job(), id: 'retained' }; await commitPage(retained, [{ ...records[0], jobId: retained.id }]);
  await savePostJob(postJob()); await saveDirectory('post-folder', folder);
  await clearLocalData({ type: 'LOCAL_CLEAR', scope: 'job', jobId: selected.id });
  expect(await getJob(selected.id)).toBeUndefined(); expect(await getMedia(selected.id)).toEqual([]);
  expect(await getDirectory(selected.id)).toBeUndefined(); expect(await getDirectory('post-folder')).toEqual(folder);
  expect(await getJob(retained.id)).toBeDefined(); expect(await getMedia(retained.id)).toHaveLength(1); expect(await getPostJob('post-job')).toBeDefined();
  expect(cancel.mock.calls).toEqual([[7]]);
  expect(mocks.offscreen).toHaveBeenCalledWith('local-purge', { jobId: selected.id, blobUrls: ['blob:active'] });
});

it('retains a folder connection shared by another service when removing a post job', async () => {
  const selected = postJob('post-job', 'shared'); await savePostJob(selected); await saveDirectory('shared', folder);
  await commitPage({ ...job(), destination: { kind: 'folder', name: folder.name, directoryId: 'shared' } }, []);
  await clearLocalData({ type: 'LOCAL_CLEAR', scope: 'job', jobId: selected.id });
  expect(await getPostJob(selected.id)).toBeUndefined(); expect(await getDirectory('shared')).toEqual(folder); expect(await getJobs()).toHaveLength(1);
});

it('clears both services, orphaned media and folder connections, and all private caches', async () => {
  const selected = job(); selected.manifestDownloads = [{ id: 17, blobUrl: 'blob:manifest', path: 'manifest.json', state: 'in_progress' }];
  await commitPage(selected, normalizeMessages(messages, scope, selected.id).slice(0, 1));
  const post = postJob(); post.archive = { state: 'saving', filename: 'archive.zip', blobUrl: 'blob:zip', downloadId: 18, bytes: 1, entries: 1, progress: 1, total: 1, error: null };
  await savePostJob(post);
  await saveMedia({ ...normalizeMessages(messages, scope, 'orphan')[0] });
  await saveDirectory('post-folder', folder); await saveDirectory('orphan-folder', folder);
  await clearLocalData({ type: 'LOCAL_CLEAR', scope: 'all' });
  expect(await getJobs()).toEqual([]); expect(await getPostJobs()).toEqual([]);
  expect(await getMedia(selected.id)).toEqual([]); expect(await getMedia('orphan')).toEqual([]);
  expect(await getDirectory('post-folder')).toBeUndefined(); expect(await getDirectory('orphan-folder')).toBeUndefined();
  expect(cancel.mock.calls).toEqual([[18], [17]]);
  expect(mocks.offscreen).toHaveBeenCalledWith('local-purge', { blobUrls: ['blob:zip', 'blob:manifest'] });
});

it('preserves stopped job history and connections so a failed cache purge can be retried', async () => {
  await savePostJob(postJob()); await saveDirectory('post-folder', folder);
  mocks.offscreen.mockRejectedValueOnce(new Error('Cache is busy'));
  await expect(clearLocalData({ type: 'LOCAL_CLEAR', scope: 'all' })).rejects.toThrow('Cache is busy');
  expect((await getPostJob('post-job'))?.status).toBe('cancelled'); expect(await getDirectory('post-folder')).toEqual(folder);
  await clearLocalData({ type: 'LOCAL_CLEAR', scope: 'all' });
  expect(await getPostJobs()).toEqual([]); expect(await getDirectory('post-folder')).toBeUndefined();
});

it('rejects invalid removal requests before stopping jobs or clearing storage', async () => {
  await savePostJob(postJob());
  for (const value of [{ scope: 'job' }, { scope: 'job', jobId: '../outside' }, { scope: 'unknown' }]) {
    await expect(clearLocalData({ type: 'LOCAL_CLEAR', ...value } as ClearLocalData)).rejects.toThrow();
  }
  await expect(clearLocalData({ type: 'LOCAL_CLEAR', scope: 'job', jobId: 'missing' })).rejects.toThrow('already removed');
  expect(mocks.offscreen).not.toHaveBeenCalled(); expect((await getPostJob('post-job'))?.status).toBe('downloading');
});

it('still purges orphaned storage when there are no saved jobs', async () => {
  await saveDirectory('orphan-folder', folder);
  await clearLocalData({ type: 'LOCAL_CLEAR', scope: 'all' });
  expect(mocks.offscreen).toHaveBeenCalledWith('local-purge', { blobUrls: [] });
  expect(await getDirectory('orphan-folder')).toBeUndefined();
});
