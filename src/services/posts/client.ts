import { InvalidJsonError, KemonoClient, RequestError } from '../../api/kemonoClient';
import { isPostId } from './postId';
import type { ApiPost, PostScope } from './types';

export class PostClient extends KemonoClient {
  private validate(value: unknown, scope: PostScope): ApiPost {
    const post = value as ApiPost | null;
    if (!post || typeof post !== 'object' || Array.isArray(post)) throw new RequestError('Invalid post response.', 422);
    if (!isPostId(post.id)) throw new RequestError('Invalid post ID in API response.', 422);
    if (post.user !== scope.creatorId || post.service !== scope.platform) throw new RequestError('Post response belongs to a different creator or service.', 422);
    if (post.attachments != null && (!Array.isArray(post.attachments) || post.attachments.some(item => !item || typeof item !== 'object'))) throw new RequestError('Invalid post attachment list.', 422);
    if (post.content != null && typeof post.content !== 'string') throw new RequestError('Invalid post text.', 422);
    return post;
  }
  async profile(scope: PostScope): Promise<string> {
    const value = await this.json(`/${scope.platform}/user/${scope.creatorId}/profile`, scope.origin) as Record<string, unknown>;
    return value && value.id === scope.creatorId && typeof value.name === 'string' ? value.name : scope.creatorId;
  }
  async total(scope: PostScope): Promise<number | null> {
    const response = await fetch(`${scope.origin}/${scope.platform}/user/${scope.creatorId}`, { headers: { Accept: 'text/html' }, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!response.ok) return null;
    const match = /Showing\s+[\d,]+\s*[-–]\s*[\d,]+\s+of\s+([\d,]+)/i.exec(await response.text());
    const count = match ? Number(match[1].replaceAll(',', '')) : NaN;
    return Number.isSafeInteger(count) && count >= 0 ? count : null;
  }
  async posts(scope: PostScope, offset: number): Promise<ApiPost[]> {
    return (await this.list(scope, offset)).map(post => this.validate(post, scope));
  }
  async page(scope: PostScope, offset: number): Promise<{ posts: ApiPost[]; count: number; failures: { postId: string | null; error: string }[] }> {
    const list = await this.list(scope, offset), posts: ApiPost[] = [], failures: { postId: string | null; error: string }[] = [];
    for (const [index, value] of list.entries()) {
      try { posts.push(this.validate(value, scope)); }
      catch (error) {
        const id = (value as ApiPost | null)?.id;
        failures.push({ postId: isPostId(id) ? id : null, error: `Post ${index + 1} on this page: ${error instanceof Error ? error.message : 'Invalid post response.'}` });
      }
    }
    return { posts, count: list.length, failures };
  }
  private async list(scope: PostScope, offset: number): Promise<unknown[]> {
    const path = `/${scope.platform}/user/${scope.creatorId}`;
    let value: unknown;
    try { value = await this.json(`${path}${scope.origin === 'https://kemono.cr' ? '/posts' : ''}?o=${offset}`, scope.origin); }
    catch (error) {
      // Both list routes address the same page. Recover unreadable responses without bypassing rate limits or validation.
      if (!(error instanceof RequestError) || (error.status !== 404 && error.status !== 0 && !(error instanceof InvalidJsonError))) throw error;
      value = await this.json(`${path}${scope.origin === 'https://kemono.cr' ? '' : '/posts'}?o=${offset}`, scope.origin);
    }
    const list = Array.isArray(value) ? value : (value as { posts?: unknown })?.posts;
    if (!Array.isArray(list)) throw new RequestError('Post list is not an array.', 422);
    return list;
  }
  async post(scope: PostScope): Promise<ApiPost> {
    if (!isPostId(scope.postId)) throw new RequestError('Invalid post ID.', 422);
    const value = await this.json(`/${scope.platform}/user/${scope.creatorId}/post/${scope.postId}`, scope.origin);
    const post = this.validate((value as { post?: unknown })?.post || value, scope);
    if (post.id !== scope.postId) throw new RequestError('The API returned a different post.', 422);
    return post;
  }
}
