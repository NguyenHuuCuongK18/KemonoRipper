import { describe, expect, it, vi } from 'vitest';
import { parsePostUrl, postSourceUrl, serviceForUrl } from '../src/services/registry';
import { PostClient } from '../src/services/posts/client';
import { createTasks, normalizePost, postRelativePath } from '../src/services/posts/media';
import { emptySync, parseSync, recordSaved, syncKey, zipSync } from '../src/services/posts/sync';
import type { ApiPost, PostJob, PostScope } from '../src/services/posts/types';

const scope: PostScope = { origin: 'https://pawchive.pw', platform: 'patreon', creatorId: '19875180', postId: 'p-1237087' };
const post: ApiPost = { id: scope.postId!, user: scope.creatorId, service: scope.platform, title: 'Imported post', content: 'Text',
  published: '2025-03-01T00:00:00', attachments: [], file: { name: 'image.png', path: '/aa/bb/' + 'a'.repeat(64) + '.png' } };
const response = (value: unknown) => new Response(JSON.stringify(value));

describe('Pawchive prefixed post IDs', () => {
  it.each(['https://pawchive.pw', 'https://kemono.cr'])('recognizes single-post links on %s without changing their ID', origin => {
    const source = { ...scope, origin }, url = postSourceUrl(source);
    expect(parsePostUrl(url)).toEqual(source);
    expect(serviceForUrl(url)).toBe('posts');
    expect(parsePostUrl(url + '/')).toEqual(source);
    expect(parsePostUrl(url.replace('p-1237087', '1237087'))?.postId).toBe('1237087');
  });

  it.each([false, true])('accepts the reported ID in a creator list (wrapped: %s)', async wrapped => {
    const transport = vi.fn().mockResolvedValue(response(wrapped ? { posts: [post] } : [post]));
    await expect(new PostClient(transport).posts({ ...scope, postId: null }, 450)).resolves.toEqual([post]);
    expect(transport.mock.calls[0][0]).toBe(`${scope.origin}/api/v1/patreon/user/19875180?o=450`);
  });

  it.each([false, true])('fetches the reported single post (wrapped: %s)', async wrapped => {
    const transport = vi.fn().mockResolvedValue(response(wrapped ? { post } : post));
    await expect(new PostClient(transport).post(scope)).resolves.toEqual(post);
    expect(transport.mock.calls[0][0]).toBe(`${scope.origin}/api/v1/patreon/user/19875180/post/p-1237087`);
  });

  it.each([{ user: '999' }, { service: 'fanbox' }])('still rejects posts from a different creator or service: %j', async mismatch => {
    const client = new PostClient(vi.fn().mockImplementation(async () => response([{ ...post, ...mismatch }])));
    await expect(client.posts(scope, 450)).rejects.toThrow('different creator or service');
  });

  it('still requires the requested post ID to match exactly', async () => {
    const client = new PostClient(vi.fn().mockResolvedValue(response({ ...post, id: '1237087' })));
    await expect(client.post(scope)).rejects.toThrow('different post');
  });

  it.each(['p-', 'p-abc', 'p-123/extra', 'p-123%2fextra', 'p-123?other', 'p-123#other', '../123', '12:34', '9'.repeat(41), 1237087, null])('rejects invalid API post ID %j with an accurate error', async id => {
    const client = new PostClient(vi.fn().mockResolvedValue(response([{ ...post, id }])));
    await expect(client.posts(scope, 450)).rejects.toThrow('Invalid post ID');
  });

  it.each(['p-', 'p-abc', 'p-123/extra', 'p-123%2fextra', 'p-123%3fother', 'p-123%23other', '12:34', '9'.repeat(41)])('rejects invalid post-link ID %s', id => {
    expect(parsePostUrl(`${scope.origin}/patreon/user/19875180/post/${id}`)).toBeNull();
  });

  it('rejects an unsafe detail ID before making a request', async () => {
    const transport = vi.fn();
    await expect(new PostClient(transport).post({ ...scope, postId: '../123' })).rejects.toThrow('Invalid post ID');
    expect(transport).not.toHaveBeenCalled();
  });

  it('retains prefixed IDs through folder paths, native sync, legacy manifests and ZIP history', () => {
    const job = { source: scope, creatorName: 'Creator', selection: { quality: 'full res', images: true, files: true, text: true },
      destination: { kind: 'folder' }, posts: [normalizePost(post, scope)] } as PostJob;
    job.tasks = createTasks(job, job.selection);
    const index = emptySync(job);
    for (const task of job.tasks) {
      task.status = 'downloaded'; task.bytes = 10;
      expect(postRelativePath(task)).toContain('/2025-03-01_p-1237087_Imported post/');
      recordSaved(index, task, post.title!);
    }
    expect(index.posts[0].id).toBe('p-1237087');
    expect(index.posts[0].files).toHaveLength(2);
    expect(parseSync(index, scope).posts).toEqual(index.posts);
    expect(parseSync(zipSync(job), scope).posts).toEqual(index.posts);
    const legacy = { schemaVersion: 1, sourceUrl: postSourceUrl(scope), creator: job.creatorName, selection: job.selection,
      posts: job.posts, files: job.tasks.map(task => ({ ...task, id: task.id.replace(':full res:/', ':full res:1:/') })) };
    expect(parseSync(legacy, scope).posts).toEqual(index.posts);
    expect(syncKey('123:full res:1:/aa/bb/file.png')).toBe('123:full res:/aa/bb/file.png');
  });

  it('rejects unsafe and duplicate post IDs in sync history', () => {
    const index = emptySync({ source: scope, creatorName: 'Creator', selection: { quality: 'full res', images: true, files: true, text: true } });
    for (const id of ['../123', 'p-123/extra', 'p-abc', '9'.repeat(41)]) {
      expect(() => parseSync({ ...index, posts: [{ id, files: [] }] }, scope)).toThrow('Invalid or duplicate post ID');
    }
    expect(() => parseSync({ ...index, posts: [{ id: post.id, files: [] }, { id: post.id, files: [] }] }, scope)).toThrow('duplicate post ID');
  });
});
