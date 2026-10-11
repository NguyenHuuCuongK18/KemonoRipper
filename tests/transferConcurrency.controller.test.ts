import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ offscreen: vi.fn(), release: vi.fn() }));
vi.mock('../src/background/offscreenBridge', () => ({ ...mocks, saveText: vi.fn() }));
import { tick } from '../src/background/controller';
import { tickPosts } from '../src/services/posts/controller';
import { createTasks, normalizePost } from '../src/services/posts/media';
import { commitPage, deleteLocalRecords, getJob, getMedia, getPostJob, savePostJob } from '../src/storage/database';
import { normalizeMessages } from '../src/core/mediaNormalizer';
import type { ApiPost, PostJob } from '../src/services/posts/types';
import { job as discordJob, scope } from './helpers';
import fixture from './fixtures/post-11312487.sanitized.json';
import messages from './fixtures/channel-1268995994440302725-0.sanitized.json';

function postJob(limit: number): PostJob {
  const source = { origin: 'https://pawchive.pw', platform: 'fanbox' as const, creatorId: fixture.user, postId: null };
  const value: PostJob = { id: 'concurrency-posts', service: 'posts', source, sourceUrl: `${source.origin}/fanbox/user/${source.creatorId}`, creatorName: 'Creator',
    createdAt: '', updatedAt: '', status: 'downloading', resumeStatus: 'downloading',
    selection: { quality: 'full res', images: true, files: false, text: false },
    scan: { offset: 0, pages: 1, total: 12, complete: true, error: null, attempts: 0, nextAt: 0, fingerprints: [] },
    posts: Array.from({ length: 12 }, (_, i) => normalizePost({ ...fixture, id: String(2000 + i) } as ApiPost, source)),
    tasks: [], detailQueue: [], archive: undefined, destination: { kind: 'zip' }, nextAt: 0, error: null,
    transferPolicy: { limit, successes: 0, failures: 0, increaseAfter: 0 } };
  value.tasks = createTasks(value, value.selection);
  return value;
}
beforeEach(async () => {
  await deleteLocalRecords(); vi.resetAllMocks();
  vi.stubGlobal('navigator', { hardwareConcurrency: 16, deviceMemory: 8 });
  vi.stubGlobal('chrome', { downloads: { download: vi.fn() } });
  vi.spyOn(Date, 'now').mockReturnValue(100_000);
  mocks.offscreen.mockImplementation(async action => action === 'post-transfer-status' ? { state: 'transferring' } : null);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('fills the post pool to the restored device limit, accounting for transfers already running', async () => {
  const value = postJob(5);
  value.tasks[0].status = value.tasks[1].status = 'transferring';
  await savePostJob(value); await tickPosts();
  expect(mocks.offscreen.mock.calls.filter(([action]) => action === 'post-transfer-start')).toHaveLength(3);
  const saved = (await getPostJob(value.id))!;
  expect(saved.tasks.filter(task => task.status === 'transferring')).toHaveLength(5);
  expect(saved.transferPolicy?.limit).toBe(5);
  await tickPosts();
  expect(mocks.offscreen.mock.calls.filter(([action]) => action === 'post-transfer-start')).toHaveLength(3);
});

it('grows and persists the post pool after successful completions', async () => {
  const value = postJob(2); value.transferPolicy!.successes = 2;
  for (const task of value.tasks.slice(0, 2)) { task.status = 'transferring'; task.attempts = 1; }
  mocks.offscreen.mockImplementation(async action => action === 'post-transfer-status' ? { state: 'done', bytes: 100 } : null);
  await savePostJob(value); await tickPosts();
  const saved = (await getPostJob(value.id))!;
  expect(saved.transferPolicy?.limit).toBe(3);
  expect(saved.tasks.filter(task => task.status === 'transferring')).toHaveLength(3);
  expect(saved.tasks.filter(task => task.status === 'staged')).toHaveLength(2);
});

it('does not start queued posts in the tick that discovers a rate limit and retains its deadline', async () => {
  const value = postJob(6);
  for (const task of value.tasks.slice(0, 2)) { task.status = 'transferring'; task.attempts = 1; }
  mocks.offscreen.mockImplementation(async (action, args) => action === 'post-transfer-status' ? args.recordId === value.tasks[0].id ?
    { state: 'done', status: 429, failure: 'Rate limited', retryAfterMs: 120_000 } : { state: 'done', bytes: 100 } : null);
  await savePostJob(value); await tickPosts();
  const saved = (await getPostJob(value.id))!;
  expect(saved.transferPolicy).toMatchObject({ limit: 3, increaseAfter: 220_000 });
  expect(saved.nextAt).toBe(220_000);
  expect(mocks.offscreen.mock.calls.filter(([action]) => action === 'post-transfer-start')).toHaveLength(0);
  await tickPosts();
  expect(mocks.offscreen.mock.calls.filter(([action]) => action === 'post-transfer-start')).toHaveLength(0);
  vi.mocked(Date.now).mockReturnValue(220_000); await tickPosts();
  expect(mocks.offscreen.mock.calls.filter(([action]) => action === 'post-transfer-start')).toHaveLength(3);
});

it('drains existing post transfers when the network limit falls without aborting collected work', async () => {
  const value = postJob(6);
  for (const task of value.tasks.slice(0, 4)) task.status = 'transferring';
  await savePostJob(value);
  vi.stubGlobal('navigator', { hardwareConcurrency: 16, deviceMemory: 8, connection: { effectiveType: '2g' } });
  await tickPosts();
  expect((await getPostJob(value.id))!.tasks.filter(task => task.status === 'transferring')).toHaveLength(4);
  expect(mocks.offscreen.mock.calls.some(([action]) => action === 'post-transfer-start' || action === 'post-transfer-stop')).toBe(false);
});

it('runs four Discord transfers concurrently on a capable device', async () => {
  const value = { ...discordJob(), status: 'downloading' as const, destination: { kind: 'zip' as const },
    transferPolicy: { limit: 4, successes: 0, failures: 0, increaseAfter: 0 } };
  const records = normalizeMessages(messages, scope, value.id).slice(0, 5);
  for (const record of records) record.status = 'queued';
  await commitPage(value, records);
  const finish: (() => void)[] = [];
  let active = 0, maximum = 0;
  mocks.offscreen.mockImplementation(async action => {
    if (action !== 'image') return null;
    maximum = Math.max(maximum, ++active);
    await new Promise<void>(resolve => finish.push(resolve)); active--;
    return { blobUrl: 'blob:image', bytes: 8, ext: 'jpg', mime: 'image/jpeg', sha256: 'hash', width: 1, height: 1 };
  });
  const running = tick();
  await vi.waitFor(() => expect(finish).toHaveLength(4));
  for (const resolve of finish) resolve();
  await running;
  expect(maximum).toBe(4);
  expect((await getMedia(value.id)).filter(record => record.status === 'staged')).toHaveLength(4);
  expect((await getMedia(value.id)).filter(record => record.status === 'queued')).toHaveLength(1);
});

it('persists a reduced Discord pool and the server retry deadline even at the final attempt', async () => {
  const value = { ...discordJob(), status: 'downloading' as const, destination: { kind: 'zip' as const },
    transferPolicy: { limit: 4, successes: 0, failures: 0, increaseAfter: 0 } };
  const records = normalizeMessages(messages, scope, value.id).slice(0, 5);
  for (const record of records) { record.status = 'queued'; record.attempts = 2; }
  await commitPage(value, records);
  mocks.offscreen.mockResolvedValue({ status: 429, failure: 'Image HTTP 429', retryAfterMs: 120_000 });
  await tick();
  const saved = (await getJob(value.id))!;
  expect(saved.transferPolicy!.limit).toBe(1);
  expect(saved.transferPolicy!.increaseAfter).toBe(220_000);
  expect(saved.mediaNextAt).toBe(220_000);
  const requests = mocks.offscreen.mock.calls.length;
  await tick(); expect(mocks.offscreen).toHaveBeenCalledTimes(requests);
});
