import { afterEach, describe, expect, it, vi } from 'vitest';
import { PostClient } from '../src/services/posts/client';
import { canSkipPostError, discoverPosts, retryPostFailures, skipPostError } from '../src/services/posts/discovery';
import { postFailures } from '../src/services/posts/failures';
import { normalizePost, createTasks } from '../src/services/posts/media';
import { emptySync, recordSaved } from '../src/services/posts/sync';
import type { ApiPost, PostJob } from '../src/services/posts/types';

const post: ApiPost = { id: '100', user: '19875180', service: 'patreon', content: 'Saved list text', attachments: [], detail_fetched: true };
function job(): PostJob {
  const source = { origin: 'https://pawchive.pw', platform: 'patreon' as const, creatorId: post.user, postId: null };
  return { id: 'tolerance', service: 'posts', source, sourceUrl: `${source.origin}/patreon/user/${post.user}`, creatorName: 'Creator', createdAt: '', updatedAt: '',
    status: 'scanning', resumeStatus: 'scanning', selection: { quality: 'full res', images: true, files: true, text: true },
    scan: { offset: 50, pages: 1, total: 150, complete: false, error: null, attempts: 0, nextAt: 0, fingerprints: ['100'] },
    posts: [normalizePost(post, source)], detailQueue: [], tasks: [], archive: undefined, nextAt: 0, error: null };
}
const unavailable = (status: number) => new PostClient(vi.fn().mockImplementation(async () => new Response('', { status, headers: { 'Retry-After': '30' } })));
afterEach(() => vi.useRealTimers());

describe('best effort post discovery', () => {
  it.each([404, 410])('retains list metadata when post detail is missing (HTTP %i) and discovers later pages', async status => {
    const value = job(); value.detailQueue = [post.id];
    await discoverPosts(value, unavailable(status));
    expect(value).toMatchObject({ status: 'scanning', detailQueue: [], posts: [expect.objectContaining({ id: post.id, content: post.content })] });
    expect(value.scan.failures).toEqual([expect.objectContaining({ kind: 'post', postId: post.id, status })]);
    await discoverPosts(value, new PostClient(vi.fn().mockResolvedValue(new Response(JSON.stringify([{ ...post, id: '200' }])))));
    expect(value.posts.map(post => post.id)).toEqual(['100', '200']);
    await discoverPosts(value, new PostClient(vi.fn().mockResolvedValue(new Response('[]'))));
    expect(value).toMatchObject({ status: 'ready', scan: { complete: true, total: 150 } });
  });

  it('keeps good posts on a page with invalid IDs and foreign creator records', async () => {
    const value = job();
    const client = new PostClient(vi.fn().mockResolvedValue(new Response(JSON.stringify([{ ...post, id: '200' }, { ...post, id: '../unsafe' }, { ...post, id: '300', user: '999' }]))));
    await discoverPosts(value, client);
    expect(value.posts.map(post => post.id)).toEqual(['100', '200']);
    expect(value.scan).toMatchObject({ offset: 100, complete: false });
    expect(value.scan.failures).toEqual([expect.objectContaining({ kind: 'page', offset: 50 }), expect.objectContaining({ kind: 'post', postId: '300' })]);
  });

  it('does not mistake a page containing only invalid records for the end', async () => {
    const value = job();
    await discoverPosts(value, new PostClient(vi.fn().mockResolvedValue(new Response('[null,{}]'))));
    expect(value.scan).toMatchObject({ offset: 100, complete: false }); expect(value.status).toBe('scanning');
    expect(value.scan.failures).toHaveLength(1);
  });
  it('pauses after three nonempty pages containing no valid records', async () => {
    const value = job(), client = new PostClient(vi.fn().mockImplementation(async () => new Response('[null,{}]')));
    for (let index = 0; index < 3; index++) await discoverPosts(value, client);
    expect(value).toMatchObject({ status: 'paused', scan: { offset: 150, complete: false } });
    expect(value.scan.failures).toHaveLength(3);
  });

  it.each([401, 403, 429])('pauses instead of skipping site-wide HTTP %i failures', async status => {
    const value = job(); value.scan.attempts = 2;
    await discoverPosts(value, unavailable(status));
    expect(value).toMatchObject({ status: 'paused', scan: { offset: 50, errorStatus: status } });
    expect(value.scan.failures).toBeUndefined(); expect(canSkipPostError(value)).toBe(false);
    expect(() => skipPostError(value)).toThrow('Restore site access');
  });

  it('stops automatic skipping after three consecutive failed pages', async () => {
    const value = job();
    for (let index = 0; index < 3; index++) { value.scan.attempts = 2; await discoverPosts(value, unavailable(503)); }
    expect(value.status).toBe('paused'); expect(value.scan.offset).toBe(150); expect(value.scan.failures).toHaveLength(3);
    expect(value.error).toContain('Three consecutive pages');
    expect(canSkipPostError(value)).toBe(true);
    skipPostError(value);
    expect(value).toMatchObject({ status: 'scanning', scan: { offset: 200, consecutiveFailures: 0, error: null } });
    expect(value.scan.failures).toHaveLength(3);
  });

  it('allows an older paused job to skip its error without dropping earlier posts', () => {
    const value = job(); value.status = 'paused'; value.scan.error = 'API returned invalid JSON; this page is incomplete.';
    skipPostError(value);
    expect(value).toMatchObject({ status: 'scanning', scan: { offset: 100, pages: 2, attempts: 0, error: null } });
    expect(value.posts).toHaveLength(1); expect(value.scan.failures![0].error).toContain('invalid JSON');
  });

  it('retries a missing detail without restarting pagination or losing earlier metadata', async () => {
    const value = job(); value.detailQueue = [post.id]; await discoverPosts(value, unavailable(404));
    value.scan.complete = true; value.status = 'ready'; const offset = value.scan.offset;
    retryPostFailures(value); value.status = 'scanning';
    await discoverPosts(value, new PostClient(vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...post, content: 'Recovered detail' })))));
    expect(value).toMatchObject({ status: 'ready', scan: { offset, complete: true, failures: [] } });
    expect(value.posts[0].content).toBe('Recovered detail');
  });

  it('keeps a retried gap in the report if it is still unavailable', async () => {
    const value = job(); value.detailQueue = [post.id]; await discoverPosts(value, unavailable(404));
    value.scan.complete = true; retryPostFailures(value);
    await discoverPosts(value, unavailable(404));
    expect(value.scan).toMatchObject({ complete: true, total: 150 }); expect(value.scan.failures).toHaveLength(1);
  });

  it('can finish a missing single post with a report and no fabricated metadata', async () => {
    const value = job(); value.source.postId = '200'; value.posts = [];
    await discoverPosts(value, unavailable(404));
    expect(value).toMatchObject({ status: 'ready', posts: [], scan: { complete: true } });
    expect(postFailures(value)[0]).toMatchObject({ stage: 'discovery', postId: '200', status: 404, sourceUrl: `${value.sourceUrl}/post/200` });
  });

  it('reports discovery and media errors without recording failures as successful sync history', async () => {
    const value = job(); value.detailQueue = [post.id]; await discoverPosts(value, unavailable(404));
    value.tasks = createTasks(value, value.selection); value.tasks[0].status = 'failed'; value.tasks[0].error = 'File HTTP 404';
    const index = emptySync(value); recordSaved(index, value.tasks[0], 'Post');
    expect(index.posts).toEqual([]);
    expect(postFailures(value)).toEqual([expect.objectContaining({ stage: 'download', error: 'File HTTP 404' }), expect.objectContaining({ stage: 'discovery', status: 404 })]);
  });
});
