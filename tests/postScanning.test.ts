import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../src/background/offscreenBridge', () => ({ offscreen: vi.fn(), release: vi.fn() }));
import { postCommand, tickPosts } from '../src/services/posts/controller';
import { normalizePost } from '../src/services/posts/media';
import { deleteLocalRecords, getPostJob, savePostJob } from '../src/storage/database';
import type { ApiPost, PostJob, PostScope } from '../src/services/posts/types';

const source: PostScope = { origin: 'https://pawchive.pw', platform: 'patreon', creatorId: '19875180', postId: null };
const post: ApiPost = { id: 'p-1237087', user: source.creatorId, service: source.platform, title: 'Imported post', content: 'Text', attachments: [], detail_fetched: true };

function pausedScan(): PostJob {
  const error = 'Post response belongs to a different creator or service.';
  return { id: 'scan-test', service: 'posts', source, sourceUrl: `${source.origin}/patreon/user/${source.creatorId}`, creatorName: 'Creator',
    createdAt: '', updatedAt: '', status: 'paused', resumeStatus: 'scanning',
    selection: { quality: 'full res', images: true, files: true, text: true },
    scan: { offset: 450, pages: 9, total: null, complete: false, error, attempts: 1, nextAt: 0, fingerprints: ['earlier-page'] },
    posts: Array.from({ length: 450 }, (_, i) => normalizePost({ ...post, id: String(i + 1) }, source)),
    tasks: [], detailQueue: [], archive: undefined, nextAt: 0, error };
}

beforeEach(async () => { await deleteLocalRecords(); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it.each(['resume', 'retry'] as const)('%s continues an existing failed scan at offset 450 and keeps its earlier posts', async action => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const job = pausedScan(); await savePostJob(job);
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify([post]))).mockResolvedValueOnce(new Response('[]'));
  vi.stubGlobal('fetch', fetch);
  await postCommand({ type: 'POST_ACTION', jobId: job.id, action });
  await tickPosts();
  const resumed = (await getPostJob(job.id))!;
  expect(resumed).toMatchObject({ status: 'scanning', error: null, scan: { offset: 500, pages: 10, error: null, attempts: 0 } });
  expect(resumed.posts.slice(0, 450)).toEqual(job.posts);
  expect(resumed.posts[450]).toMatchObject({ id: 'p-1237087' });
  expect(resumed.scan.fingerprints[0]).toBe('earlier-page');
  expect(fetch.mock.calls[0][0]).toBe(`${source.origin}/api/v1/patreon/user/19875180?o=450`);
  vi.setSystemTime(Date.now() + 1000); await tickPosts();
  expect(await getPostJob(job.id)).toMatchObject({ status: 'ready', scan: { complete: true, total: 451, error: null } });
  expect(fetch.mock.calls[1][0]).toBe(`${source.origin}/api/v1/patreon/user/19875180?o=500`);
});

it('fetches missing detail for a prefixed post before continuing pagination', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const job = pausedScan(); job.scan.offset = 500;
  job.posts.push(normalizePost({ ...post, content: undefined, attachments: undefined }, source));
  job.detailQueue = [post.id]; await savePostJob(job);
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ post })));
  vi.stubGlobal('fetch', fetch);
  await postCommand({ type: 'POST_ACTION', jobId: job.id, action: 'resume' }); await tickPosts();
  const stored = (await getPostJob(job.id))!;
  expect(stored).toMatchObject({ status: 'scanning', error: null, detailQueue: [], scan: { offset: 500, error: null } });
  expect(stored.posts[450]).toMatchObject({ id: post.id, content: 'Text' });
  expect(fetch.mock.calls[0][0]).toBe(`${source.origin}/api/v1/patreon/user/19875180/post/p-1237087`);
});

it('retries incomplete pages with backoff, then records and skips the page without losing earlier posts', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const job = pausedScan();
  job.scan = { ...job.scan, offset: 1150, pages: 23, total: 3349 };
  job.posts = Array.from({ length: 1150 }, (_, i) => normalizePost({ ...post, id: String(i + 1) }, source));
  await savePostJob(job);
  const fetch = vi.fn().mockImplementation(async () => new Response('[{"id":'));
  vi.stubGlobal('fetch', fetch);
  await postCommand({ type: 'POST_ACTION', jobId: job.id, action: 'resume' });
  for (let attempt = 1; attempt <= 3; attempt++) {
    const attemptedAt = Date.now(); await tickPosts();
    const stored = (await getPostJob(job.id))!;
    expect(stored).toMatchObject({ status: 'scanning', scan: { offset: attempt < 3 ? 1150 : 1200, pages: attempt < 3 ? 23 : 24, total: 3349, attempts: attempt < 3 ? attempt : 0, complete: false } });
    expect(stored.posts).toEqual(job.posts); expect(stored.scan.fingerprints).toEqual(job.scan.fingerprints);
    expect(fetch).toHaveBeenCalledTimes(attempt * 2);
    expect(fetch.mock.calls.every(call => new URL(call[0]).searchParams.get('o') === '1150')).toBe(true);
    if (attempt < 3) {
      expect(stored.scan.nextAt).toBe(attemptedAt + 2000 * 2 ** (attempt - 1));
      await tickPosts(); expect(fetch).toHaveBeenCalledTimes(attempt * 2);
      vi.setSystemTime(stored.scan.nextAt);
    } else expect(stored.scan.failures).toEqual([expect.objectContaining({ kind: 'page', offset: 1150, attempts: 3 })]);
  }
  fetch.mockResolvedValueOnce(new Response('[]'));
  vi.setSystemTime(Date.now() + 1000); await tickPosts();
  expect(await getPostJob(job.id)).toMatchObject({ status: 'ready', scan: { complete: true, total: 3349 } });
  fetch.mockResolvedValueOnce(new Response(JSON.stringify([post])));
  await postCommand({ type: 'POST_ACTION', jobId: job.id, action: 'retry' }); await tickPosts();
  const resumed = (await getPostJob(job.id))!;
  expect(resumed).toMatchObject({ status: 'ready', error: null, scan: { offset: 1250, pages: 25, total: 1151, failures: [], attempts: 0, error: null, complete: true } });
  expect(fetch.mock.calls.at(-1)![0]).toBe(`${source.origin}/api/v1/patreon/user/19875180?o=1150`);
  expect(resumed.posts.slice(0, 1150)).toEqual(job.posts); expect(resumed.posts[1150].id).toBe(post.id);
});
