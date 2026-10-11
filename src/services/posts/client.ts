import { KemonoClient, RequestError } from '../../api/kemonoClient';
import type { ApiPost, PostScope } from './types';

export class PostClient extends KemonoClient {
  private validate(value: unknown, scope: PostScope): ApiPost {
    const post = value as ApiPost | null;
    if (!post || typeof post !== 'object' || typeof post.id !== 'string' || !/^\d+$/.test(post.id) || post.user !== scope.creatorId || post.service !== scope.platform) throw new RequestError('Post response belongs to a different creator or service.', 422);
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
    const path = `/${scope.platform}/user/${scope.creatorId}`;
    let value: unknown;
    try { value = await this.json(`${path}${scope.origin === 'https://kemono.cr' ? '/posts' : ''}?o=${offset}`, scope.origin); }
    catch (error) {
      if (!(error instanceof RequestError) || error.status !== 404) throw error;
      value = await this.json(`${path}${scope.origin === 'https://kemono.cr' ? '' : '/posts'}?o=${offset}`, scope.origin);
    }
    const list = Array.isArray(value) ? value : (value as { posts?: unknown })?.posts;
    if (!Array.isArray(list)) throw new RequestError('Post list is not an array.', 422);
    return list.map(post => this.validate(post, scope));
  }
  async post(scope: PostScope): Promise<ApiPost> {
    const value = await this.json(`/${scope.platform}/user/${scope.creatorId}/post/${scope.postId}`, scope.origin);
    const post = this.validate((value as { post?: unknown })?.post || value, scope);
    if (post.id !== scope.postId) throw new RequestError('The API returned a different post.', 422);
    return post;
  }
}
