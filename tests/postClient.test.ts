import { describe, expect, it, vi } from 'vitest';
import { InvalidJsonError } from '../src/api/kemonoClient';
import { PostClient } from '../src/services/posts/client';
import type { ApiPost, PostScope } from '../src/services/posts/types';

const scope: PostScope = { origin: 'https://pawchive.pw', platform: 'patreon', creatorId: '19875180', postId: null };
const post: ApiPost = { id: '95624886', user: scope.creatorId, service: scope.platform, content: 'Text', attachments: [] };

describe('post list response recovery', () => {
  it.each(['https://pawchive.pw', 'https://kemono.cr'])('uses the alternate endpoint for invalid JSON on %s at the same offset', async origin => {
    const transport = vi.fn().mockResolvedValueOnce(new Response('[{"id":')).mockResolvedValueOnce(new Response(JSON.stringify([post])));
    await expect(new PostClient(transport).posts({ ...scope, origin }, 1150)).resolves.toEqual([post]);
    const base = `${origin}/api/v1/patreon/user/19875180`;
    expect(transport.mock.calls.map(call => call[0])).toEqual(origin === scope.origin ?
      [`${base}?o=1150`, `${base}/posts?o=1150`] : [`${base}/posts?o=1150`, `${base}?o=1150`]);
  });
  it('uses the alternate endpoint after an interrupted body', async () => {
    const interrupted = new Response(new ReadableStream({ start(controller) { controller.error(new Error('disconnected')); } }));
    const transport = vi.fn().mockResolvedValueOnce(interrupted).mockResolvedValueOnce(new Response(JSON.stringify({ posts: [post] })));
    await expect(new PostClient(transport).posts(scope, 1150)).resolves.toEqual([post]);
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it('keeps the existing 404 endpoint fallback', async () => {
    const transport = vi.fn().mockResolvedValueOnce(new Response('', { status: 404 })).mockResolvedValueOnce(new Response('[]'));
    await expect(new PostClient(transport).posts(scope, 1150)).resolves.toEqual([]);
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it.each([403, 429, 500, 503])('preserves HTTP %i errors for the normal retry policy without immediately trying another endpoint', async status => {
    const transport = vi.fn().mockResolvedValue(new Response('', { status, headers: { 'Retry-After': '30' } }));
    await expect(new PostClient(transport).posts(scope, 1150)).rejects.toMatchObject({ status, retryAfterMs: 30000 });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('propagates rate limiting on the alternate endpoint with its cooldown', async () => {
    const transport = vi.fn().mockResolvedValueOnce(new Response('<html>unavailable</html>'))
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '30' } }));
    await expect(new PostClient(transport).posts(scope, 1150)).rejects.toMatchObject({ status: 429, retryAfterMs: 30000 });
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it('leaves two invalid responses retryable without accepting either as an empty page', async () => {
    const transport = vi.fn().mockImplementation(async () => new Response('[{"id":'));
    const error = await new PostClient(transport).posts(scope, 1150).catch(error => error);
    expect(error).toBeInstanceOf(InvalidJsonError); expect(error.retryable).toBe(true);
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it.each([{ posts: [{ ...post, user: '999' }] }, { posts: 'not a list' }])('still rejects invalid structured responses without changing endpoints: %j', async value => {
    const transport = vi.fn().mockResolvedValue(new Response(JSON.stringify(value)));
    await expect(new PostClient(transport).posts(scope, 1150)).rejects.toMatchObject({ status: 422, retryable: false });
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
