import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ offscreen: vi.fn(), release: vi.fn() }));
vi.mock('../src/background/offscreenBridge', () => mocks);
import { postCommand, postDetail, tickPosts } from '../src/services/posts/controller';
import { createTasks, normalizePost } from '../src/services/posts/media';
import { emptySync, recordSaved, zipSync } from '../src/services/posts/sync';
import { changePostSelection } from '../src/services/posts/selection';
import { deleteLocalRecords, getPostJob, savePostJob } from '../src/storage/database';
import type { ApiPost, PostJob } from '../src/services/posts/types';
import fixture from './fixtures/post-11312487.sanitized.json';

function job(single = false): PostJob {
  const source = { origin: 'https://pawchive.pw', platform: 'fanbox' as const, creatorId: fixture.user, postId: single ? '1' : null };
  return { id: 'selection-test', service: 'posts', source, sourceUrl: `${source.origin}/fanbox/user/${source.creatorId}${single ? '/post/1' : ''}`, creatorName: 'Creator', createdAt: '', updatedAt: '', status: 'ready', resumeStatus: 'downloading',
    selection: { quality: 'full res', images: true, files: true, text: true },
    scan: { offset: 0, pages: 1, total: single ? 1 : 3, complete: true, error: null, attempts: 0, nextAt: 0, fingerprints: [] },
    posts: (single ? ['1'] : ['1', '2', '3']).map(id => normalizePost({ ...fixture, id } as ApiPost, source)),
    tasks: [], detailQueue: [], archive: undefined, destination: { kind: 'zip' }, nextAt: 0, error: null };
}
beforeEach(async () => { await deleteLocalRecords(); vi.resetAllMocks(); });
afterEach(() => vi.unstubAllGlobals());

it('defaults to all posts and distinguishes selecting no posts from selecting all', () => {
  const value = job(); expect(createTasks(value, value.selection)).toHaveLength(6);
  changePostSelection(value, undefined, false);
  expect(createTasks(value, value.selection)).toHaveLength(0);
  changePostSelection(value, '2', true);
  expect(createTasks(value, value.selection).map(task => task.postId)).toEqual(['2', '2']);
  changePostSelection(value, undefined, true);
  expect(createTasks(value, value.selection)).toHaveLength(6);
  expect(value.selectedPostIds).toBeUndefined();
});

it('can exclude a post without dropping undisplayed posts from the creator', () => {
  const value = job();
  changePostSelection(value, '2', false);
  expect(value.selectedPostIds).toEqual(['1', '3']);
  const detail = postDetail(value, 1);
  expect(detail.posts).toHaveLength(1);
  expect(detail.totals.selectedPosts).toBe(2);
  expect(detail.job).not.toHaveProperty('selectedPostIds');
  expect(detail.allPostsSelected).toBe(false);
});

it.each([[null, true], ['999', true], ['1', 'yes']])('rejects invalid post selection %j without changing the job', (id, selected) => {
  const value = job(), previous = structuredClone(value);
  expect(() => changePostSelection(value, id, selected)).toThrow();
  expect(value).toEqual(previous);
});

it('persists individual selections and builds only their tasks after reading the job again', async () => {
  const value = job(); await savePostJob(value);
  await postCommand({ type: 'POST_SELECT', jobId: value.id, selected: false });
  await postCommand({ type: 'POST_SELECT', jobId: value.id, postId: '2', selected: true });
  await postCommand({ type: 'POST_DOWNLOAD', jobId: value.id, destination: 'zip', selection: value.selection });
  const saved = (await getPostJob(value.id))!;
  expect(saved.selectedPostIds).toEqual(['2']);
  expect(saved.tasks).toHaveLength(2);
  expect(saved.tasks.every(task => task.postId === '2')).toBe(true);
});

it('rejects an empty selection without consuming previous completed tasks', async () => {
  const value = job(); value.status = 'finished'; value.tasks = createTasks(value, value.selection);
  for (const task of value.tasks) { task.status = 'staged'; task.bytes = 100; }
  value.selectedPostIds = []; await savePostJob(value);
  await expect(postCommand({ type: 'POST_DOWNLOAD', jobId: value.id, destination: 'zip', selection: value.selection })).rejects.toThrow('Select at least one post');
  expect((await getPostJob(value.id))!.tasks).toEqual(value.tasks);
});

it.each(['downloading', 'scanning', 'paused'] as const)('does not alter the scope of an ongoing %s job', async status => {
  const value = job(); value.status = status; value.tasks = createTasks(value, value.selection); await savePostJob(value);
  await expect(postCommand({ type: 'POST_SELECT', jobId: value.id, selected: false })).rejects.toThrow('Finish or cancel');
  expect((await getPostJob(value.id))!.selectedPostIds).toBeUndefined();
});

it.each(['POST_SYNC_CONNECT', 'POST_SYNC_IMPORT'] as const)('%s keeps a single-post scope and fetches only that post', async type => {
  const value = job(true), index = emptySync(value); await savePostJob(value);
  mocks.offscreen.mockResolvedValue(index);
  if (type === 'POST_SYNC_CONNECT') await postCommand({ type, jobId: value.id, directoryId: 'archive', name: 'Archive' });
  else await postCommand({ type, jobId: value.id, json: index });
  const connected = (await getPostJob(value.id))!;
  expect(connected.source).toEqual(value.source); expect(connected.sourceUrl).toBe(value.sourceUrl);
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...fixture, id: '1' })));
  vi.stubGlobal('fetch', fetchMock); await tickPosts();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(String(fetchMock.mock.calls[0][0])).toContain('/post/1');
  expect((await getPostJob(value.id))!.posts.map(post => post.id)).toEqual(['1']);
});

it('retains a creator subset while connecting history and on an explicit rescan', async () => {
  const value = job(); value.selectedPostIds = ['2']; await savePostJob(value);
  mocks.offscreen.mockResolvedValue(emptySync(value));
  await postCommand({ type: 'POST_SYNC_CONNECT', jobId: value.id, directoryId: 'archive', name: 'Archive' });
  expect((await getPostJob(value.id))!.selectedPostIds).toEqual(['2']);
  const connected = (await getPostJob(value.id))!; connected.status = 'ready'; await savePostJob(connected);
  await postCommand({ type: 'POST_ACTION', jobId: value.id, action: 'rescan' });
  expect((await getPostJob(value.id))!.selectedPostIds).toEqual(['2']);
});

it('extends a finished creator folder with selected posts without starting a whole-creator rescan', async () => {
  const value = job(); value.status = 'finished'; value.selectedPostIds = ['2'];
  value.destination = { kind: 'folder', directoryId: 'archive', name: 'Archive' };
  const previous = { ...value, selectedPostIds: ['1'] }, history = emptySync(value);
  for (const task of createTasks(previous, value.selection)) { task.status = 'downloaded'; task.bytes = 100; recordSaved(history, task, 'First post'); }
  value.sync = history; await savePostJob(value);
  mocks.offscreen.mockResolvedValue({ sync: history, files: [] });
  await postCommand({ type: 'POST_DOWNLOAD', jobId: value.id, destination: 'folder', selection: value.selection });
  const saved = (await getPostJob(value.id))!;
  expect(saved.status).toBe('downloading'); expect(saved.scan.complete).toBe(true); expect(saved.autoDownload).toBeUndefined();
  expect(saved.tasks.every(task => task.postId === '2')).toBe(true);
  expect(saved.sync!.posts.map(post => post.id)).toEqual(['1']);
  for (const task of saved.tasks) { task.status = 'staged'; task.bytes = 100; }
  expect(zipSync(saved).posts.map(post => post.id)).toEqual(['2']);
});
