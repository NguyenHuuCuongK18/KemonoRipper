import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ offscreen: vi.fn(), release: vi.fn() }));
vi.mock('../src/background/offscreenBridge', () => mocks);
import fixtureData from './fixtures/post-11312487.sanitized.json';
import { createTasks, normalizePost, postFolder, postRelativePath, postZipJob } from '../src/services/posts/media';
import { emptySync, parseSync, recordSaved, validSelection, zipSync } from '../src/services/posts/sync';
import { postCommand, postDetail, reconcilePostDownloads, tickPosts } from '../src/services/posts/controller';
import { deleteLocalRecords, getPostJob, savePostJob, saveCacheSettings } from '../src/storage/database';
import type { ApiPost, PostJob, PostSelection } from '../src/services/posts/types';
import { FolderPermissionError } from '../src/storage/destination';

const selection: PostSelection = { quality: 'full res', images: true, files: true, text: true, fallbackToThumbnail: true };
const fixture = fixtureData as ApiPost;
function job(value: ApiPost = fixture): PostJob {
  const source = { origin: 'https://pawchive.pw', platform: 'fanbox' as const, creatorId: fixture.user, postId: fixture.id };
  return { id: 'saving-test', service: 'posts', source, sourceUrl: `${source.origin}/fanbox/user/${source.creatorId}/post/${fixture.id}`, creatorName: 'Creator', createdAt: '', updatedAt: '', status: 'ready', resumeStatus: 'downloading', selection,
    scan: { offset: 0, pages: 1, total: 1, complete: true, error: null, attempts: 0, nextAt: 0, fingerprints: [] },
    posts: [normalizePost(value, source)], tasks: [], detailQueue: [], archive: undefined, destination: { kind: 'zip' }, nextAt: 0, error: null };
}
beforeEach(async () => { await deleteLocalRecords(); vi.resetAllMocks(); });
afterEach(() => vi.unstubAllGlobals());

describe('folder access recovery', () => {
  function pausedFolder(): PostJob {
    const value = job(); value.destination = { kind: 'folder', directoryId: 'folder', name: 'Creator folder' };
    value.tasks = createTasks(value, selection);
    value.tasks[0].status = 'staged'; value.tasks[0].bytes = 20;
    value.status = 'paused'; value.error = new FolderPermissionError().message;
    return value;
  }
  it('acknowledges the saved folder without resetting staged bytes, selection or automatic sync', async () => {
    const value = pausedFolder(); value.autoDownload = selection; value.sync = emptySync(value);
    const diskIndex = emptySync(value); diskIndex.selection = { ...selection, text: false };
    await savePostJob(value); mocks.offscreen.mockResolvedValue(diskIndex);
    await postCommand({ type: 'POST_FOLDER', jobId: value.id, directoryId: 'folder', name: 'Creator folder' });
    const connected = (await getPostJob(value.id))!;
    expect(connected.tasks).toEqual(value.tasks); expect(connected.autoDownload).toEqual(selection);
    expect(connected.selection).toEqual(selection); expect(connected.status).toBe('paused');
    expect(mocks.offscreen).toHaveBeenCalledWith('post-folder-read', { directoryId: 'folder', postJob: expect.objectContaining({ id: value.id }) });
    expect(mocks.release).not.toHaveBeenCalled();
  });
  it('keeps the pause and staged data when the writer cannot acknowledge access', async () => {
    const value = pausedFolder(); await savePostJob(value);
    mocks.offscreen.mockRejectedValue(new FolderPermissionError());
    await expect(postCommand({ type: 'POST_FOLDER', jobId: value.id, directoryId: 'folder', name: 'Creator folder' })).rejects.toThrow('Folder access is required');
    const stored = (await getPostJob(value.id))!;
    expect(stored.status).toBe('paused'); expect(stored.error).toBe(value.error); expect(stored.tasks).toEqual(value.tasks);
  });
  it('rejects Resume before changing state when folder permission is still missing', async () => {
    const value = pausedFolder(); await savePostJob(value);
    mocks.offscreen.mockRejectedValue(new FolderPermissionError());
    await expect(postCommand({ type: 'POST_ACTION', jobId: value.id, action: 'resume' })).rejects.toThrow('Folder access is required');
    const stored = (await getPostJob(value.id))!;
    expect(stored.status).toBe('paused'); expect(stored.error).toBe(value.error); expect(stored.tasks).toEqual(value.tasks);
  });
  it('clears the permission error and resumes retained staged data after writer confirmation', async () => {
    const value = pausedFolder(); await savePostJob(value); mocks.offscreen.mockResolvedValue(null);
    await postCommand({ type: 'POST_ACTION', jobId: value.id, action: 'resume' });
    const resumed = (await getPostJob(value.id))!;
    expect(resumed.status).toBe('downloading'); expect(resumed.error).toBeNull(); expect(resumed.tasks).toEqual(value.tasks);
    expect(mocks.offscreen).toHaveBeenCalledWith('post-folder-read', { directoryId: 'folder', postJob: expect.objectContaining({ id: value.id }) });
  });
  it('retains an automatic sync when a premature Resume is denied', async () => {
    const value = pausedFolder(); value.tasks = []; value.autoDownload = selection; await savePostJob(value);
    mocks.offscreen.mockRejectedValue(new FolderPermissionError());
    await expect(postCommand({ type: 'POST_ACTION', jobId: value.id, action: 'resume' })).rejects.toThrow('Folder access is required');
    expect(await getPostJob(value.id)).toMatchObject({ status: 'paused', autoDownload: selection, error: value.error });
  });
  it('connects sync history and scans the whole creator only after the writer validates the directory', async () => {
    const value = job(); await savePostJob(value);
    mocks.offscreen.mockResolvedValue(emptySync(value));
    await postCommand({ type: 'POST_SYNC_CONNECT', jobId: value.id, directoryId: 'folder', name: 'Archive' });
    const connected = (await getPostJob(value.id))!;
    expect(connected).toMatchObject({ status: 'scanning', source: { postId: null }, sourceUrl: 'https://pawchive.pw/fanbox/user/24738214', destination: { kind: 'folder', directoryId: 'folder' }, sync: { source: { creatorId: '24738214' } } });
    expect(connected.scan.complete).toBe(false);
  });
  it('leaves the previous job intact if the selected history disappears before connection', async () => {
    const value = job(); await savePostJob(value); mocks.offscreen.mockResolvedValue(null);
    await expect(postCommand({ type: 'POST_SYNC_CONNECT', jobId: value.id, directoryId: 'folder', name: 'Archive' })).rejects.toThrow('no longer available');
    expect(await getPostJob(value.id)).toEqual(value);
  });
  it('preserves paused staged data and pending automatic sync when choosing its sync file', async () => {
    const value = pausedFolder(); value.autoDownload = selection; await savePostJob(value);
    mocks.offscreen.mockResolvedValue(emptySync(value));
    await postCommand({ type: 'POST_SYNC_CONNECT', jobId: value.id, directoryId: 'folder', name: 'Creator folder' });
    const connected = (await getPostJob(value.id))!;
    expect(connected.status).toBe('paused'); expect(connected.tasks).toEqual(value.tasks);
    expect(connected.autoDownload).toEqual(value.autoDownload); expect(connected.scan).toEqual(value.scan);
  });
});

it('cleans a confirmed post ZIP while preserving completion, and requeues cached successes on retry', async () => {
  await saveCacheSettings({ retentionMinutes: 5, clearAfterDownload: true, lastCheckAt: 0, removedCaches: 0 });
  const value = job(); value.status = 'finished'; value.tasks = createTasks(value, selection);
  for (const task of value.tasks) { task.status = 'staged'; task.bytes = 4; }
  value.archive = { state: 'saving', filename: 'post.zip', blobUrl: 'blob:zip', downloadId: 99, bytes: 12, entries: 2, progress: 2, total: 2, error: null };
  await savePostJob(value);
  vi.stubGlobal('chrome', { downloads: { search: vi.fn().mockResolvedValue([{ id: 99, state: 'complete', exists: true }]) } });
  await reconcilePostDownloads(false, 99);
  const completed = (await getPostJob(value.id))!;
  expect(completed.archive).toMatchObject({ state: 'saved', cacheCleared: true }); expect(completed.status).toBe('finished');
  expect(completed.tasks.every(task => task.status === 'downloaded')).toBe(true);
  expect(mocks.offscreen).toHaveBeenCalledWith('cache-remove', { jobId: value.id });
  await expect(postCommand({ type: 'POST_ACTION', jobId: value.id, action: 'save-zip' })).rejects.toThrow('cleared');
  await postCommand({ type: 'POST_ACTION', jobId: value.id, action: 'retry' });
  const retried = (await getPostJob(value.id))!;
  expect(retried.tasks.every(task => task.status === 'queued')).toBe(true); expect(retried.archive).toMatchObject({ state: 'pending', cacheCleared: false });
});

describe('sortable post folders and sync compatibility', () => {
  it.each([
    ['2026-01-28T13:57:38', '2026-01-28'],
    ['2026-01-28T00:30:00+07:00', '2026-01-27'],
    [null, 'unknown-date'], ['nonsense', 'unknown-date'], ['2026-02-30T00:00:00', 'unknown-date'],
  ])('uses a UTC date or explicit unknown date for %s', (published, date) => {
    expect(postFolder({ id: '123', title: 'A/B: title?', published })).toBe(`${date}_123_A_B_ title_`);
  });
  it('names new ZIP and folder tasks consistently by date, ID, and safe title', () => {
    const value = job(), zipTasks = createTasks(value, selection);
    value.destination = { kind: 'folder', directoryId: 'folder', name: 'folder' };
    const folderTasks = createTasks(value, selection);
    expect(zipTasks.every(task => task.path.startsWith('fanbox_24738214_Creator/full res/2026-01-28_11312487_Main file with no attachments/'))).toBe(true);
    expect(folderTasks.map(postRelativePath)).toEqual(zipTasks.map(postRelativePath));
    expect(postZipJob({ ...value, tasks: folderTasks }).tasks.map(task => task.path)).toEqual(zipTasks.map(task => task.path));
  });
  it.each(['11312487_Old title', '2026-01-28_11312487_New title', 'unknown-date_11312487_No date'])('accepts saved history at %s without renaming it', folder => {
    const value = job(), task = createTasks(value, selection)[0];
    task.path = `full res/${folder}/001_image.jpg`; task.status = 'downloaded'; task.bytes = 20;
    const index = emptySync(value); recordSaved(index, task, 'Title');
    expect(parseSync(index, value.source).posts[0].files[0].path).toBe(task.path);
    expect(postRelativePath(task)).toBe(task.path);
  });
  it.each(['2026-01-28_999_Other post', '../11312487_Title', '113124870_Wrong ID'])('rejects unsafe or foreign folder %s', folder => {
    const value = job(), task = createTasks(value, selection)[0];
    task.path = `full res/${folder}/001_image.jpg`; task.status = 'downloaded'; task.bytes = 20;
    const index = emptySync(value); recordSaved(index, task, 'Title');
    expect(() => parseSync(index, value.source)).toThrow();
    expect(() => postRelativePath(task)).toThrow();
  });
});

describe('optional thumbnail fallback', () => {
  it('saves only the original and text when an original is available', () => {
    const tasks = createTasks(job(), selection);
    expect(tasks).toHaveLength(2);
    expect(tasks.every(task => task.quality === 'full res')).toBe(true);
  });
  it('uses thumbnail identity, folder and sync quality for a known missing original', () => {
    const value = job({ ...fixture, has_full: false });
    value.tasks = createTasks(value, selection);
    expect(value.tasks[0]).toMatchObject({ quality: 'thumbnail', status: 'queued', fallback: true });
    expect(value.tasks[0].id).toContain(':thumbnail:');
    expect(value.tasks[0].path).toContain('/thumbnail/2026-01-28_11312487_');
    value.tasks[0].status = 'staged'; value.tasks[0].bytes = 20;
    const index = parseSync(zipSync(value), value.source);
    expect(index.posts[0].files[0].quality).toBe('thumbnail');
    expect(postDetail(value).totals.thumbnails).toBe(1);
    // A thumbnail history entry cannot stand in for an original on a later sync.
    expect(createTasks(job(), selection)[0].id).not.toBe(value.tasks[0].id);
    expect(value.tasks[1].quality).toBe('full res');
  });
  it('does not substitute other files or disabled/legacy original selections', () => {
    const value = job({ ...fixture, has_full: false, attachments: [{ name: 'source.psd', path: '/aa/bb/' + 'a'.repeat(64) + '.psd' }] });
    const legacy = { quality: 'full res' as const, images: true, files: true, text: true };
    for (const choice of [legacy, { ...selection, fallbackToThumbnail: false }]) {
      expect(createTasks(value, choice).filter(task => task.kind !== 'text').every(task => task.status === 'unavailable' && task.quality === 'full res')).toBe(true);
    }
    expect(createTasks(value, selection).find(task => task.kind === 'file')).toMatchObject({ quality: 'full res', status: 'unavailable' });
    expect(validSelection(legacy)).toEqual(legacy);
    expect(() => validSelection({ ...selection, fallbackToThumbnail: 'yes' })).toThrow();
  });
  it.each([404, 410])('switches a missing original (HTTP %s), and forgets the original transfer ID', async status => {
    const value = job(); value.status = 'downloading'; value.tasks = createTasks(value, selection).slice(0, 1);
    value.tasks[0].status = 'transferring'; value.tasks[0].attempts = 1;
    const originalId = value.tasks[0].id;
    await savePostJob(value);
    mocks.offscreen.mockResolvedValue({ state: 'done', status, failure: 'Original missing' });
    await reconcilePostDownloads(true);
    expect((await getPostJob(value.id))!.tasks[0]).toMatchObject({ quality: 'thumbnail', status: 'queued', attempts: 0, fallback: true, fallbackReason: 'Original missing' });
    expect(mocks.offscreen).toHaveBeenCalledWith('post-transfer-forget', { jobId: value.id, recordId: originalId });
  });
  it.each([429, 500, 403, 0])('keeps retry/failure policy for HTTP %s without switching to thumbnails', async status => {
    const value = job(); value.status = 'downloading'; value.tasks = createTasks(value, selection).slice(0, 1);
    value.tasks[0].status = 'transferring'; value.tasks[0].attempts = 3;
    await savePostJob(value);
    mocks.offscreen.mockResolvedValue({ state: 'done', status, failure: 'Unavailable', retryAfterMs: 30000 });
    const before = Date.now(); await reconcilePostDownloads(true);
    const saved = (await getPostJob(value.id))!;
    expect(saved.tasks[0]).toMatchObject({ quality: 'full res', status: 'failed' });
    expect(saved.tasks[0].fallback).toBeUndefined();
    if (status === 429) expect(saved.nextAt).toBeGreaterThanOrEqual(before + 30000);
  });
  it('skips a previously saved thumbnail at its legacy path after an original returns 404', async () => {
    const value = job(); value.destination = { kind: 'folder', directoryId: 'folder', name: 'folder' };
    value.status = 'downloading'; value.tasks = createTasks(value, selection).slice(0, 1);
    value.tasks[0].status = 'transferring'; value.tasks[0].attempts = 1;
    value.nextAt = Date.now() + 60000; await savePostJob(value);
    const id = value.tasks[0].id.replace(':full res:', ':thumbnail:'), path = 'thumbnail/11312487_Old title/001_image.jpg';
    mocks.offscreen.mockImplementation(async (action: string) => {
      if (action === 'post-transfer-status') return { state: 'done', status: 404, failure: 'Not found' };
      if (action === 'post-folder-check') return { files: [{ id, path, bytes: 20 }] };
      return null;
    });
    await tickPosts();
    expect((await getPostJob(value.id))!.tasks[0]).toMatchObject({ id, path, status: 'downloaded', synced: true, fallback: true });
    expect(mocks.offscreen.mock.calls.some(([action]) => action === 'post-transfer-start')).toBe(false);
  });
  it('rechecks a fallback after folder access is restored', async () => {
    const value = job({ ...fixture, has_full: false });
    value.destination = { kind: 'folder', directoryId: 'folder', name: 'folder' }; value.status = 'downloading';
    value.tasks = createTasks(value, selection).slice(0, 1); value.nextAt = Date.now() + 60000;
    await savePostJob(value); mocks.offscreen.mockRejectedValueOnce(new Error('Folder access required'));
    await tickPosts(); expect((await getPostJob(value.id))!.status).toBe('paused');
    expect((await getPostJob(value.id))!.tasks[0].fallbackChecked).toBe(false);
    mocks.offscreen.mockImplementation(async (action: string) => action === 'post-folder-check' ? { files: [] } : null);
    await postCommand({ type: 'POST_ACTION', jobId: value.id, action: 'resume' });
    await tickPosts(); expect((await getPostJob(value.id))!.tasks[0].fallbackChecked).toBe(true);
  });
});
