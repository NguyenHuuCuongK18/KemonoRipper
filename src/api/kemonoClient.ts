import { ARCHIVE_ORIGINS, requireId } from '../core/urlParser';
import type { ApiMessage, Server } from '../core/types';

export class RequestError extends Error {
  constructor(message: string, public status: number, public retryAfterMs = 0) { super(message); this.name = 'RequestError'; }
  get retryable(): boolean { return this.status === 0 || this.status === 429 || this.status >= 500; }
}
export class InvalidJsonError extends RequestError {
  constructor() { super('API returned invalid or incomplete JSON. Retry failures to continue this page.', 422); this.name = 'InvalidJsonError'; }
  override get retryable(): boolean { return true; }
}
export function retryAfter(value: string | null, now = Date.now()): number {
  if (!value) return 0;
  const seconds = Number(value);
  return Math.max(0, Number.isFinite(seconds) ? seconds * 1000 : (Date.parse(value) - now) || 0);
}
export class KemonoClient {
  constructor(private transport: typeof fetch = (input, init) => fetch(input, init)) {}
  async json(path: string, origin = ARCHIVE_ORIGINS[0]): Promise<unknown> {
    if (!ARCHIVE_ORIGINS.includes(origin)) throw new Error('Unsupported archive origin');
    let response: Response;
    try {
      response = await this.transport(`${origin}/api/v1${path}`, {
        headers: { Accept: 'text/css' }, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(20000),
      });
    } catch { throw new RequestError('API network request failed or timed out. Open the channel to check site access.', 0); }
    if (!response.ok) {
      const hint = response.status === 403 ? ' Access denied; the required Accept: text/css header was sent. Check access in the site tab.' : '';
      // Never include raw error bodies (which can contain session or anti-abuse data).
      throw new RequestError(`API HTTP ${response.status}.${hint}`, response.status, retryAfter(response.headers.get('retry-after')));
    }
    let body: string;
    try { body = await response.text(); }
    catch { throw new RequestError('API response was interrupted or timed out. Retry failures to continue this page.', 0); }
    try { return JSON.parse(body); }
    catch { throw new InvalidJsonError(); }
  }
  async channel(channelId: string, offset: number, origin = ARCHIVE_ORIGINS[0]): Promise<ApiMessage[]> {
    requireId(channelId);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid page offset');
    const data = await this.json(`/discord/channel/${channelId}?o=${offset}`, origin);
    if (!Array.isArray(data)) throw new RequestError('Channel response is not an array', 422);
    for (const message of data) {
      if (!message || typeof message !== 'object') throw new RequestError('Invalid message object', 422);
      requireId(message.id);
      if (message.channel !== undefined && requireId(message.channel) !== channelId) throw new RequestError('Channel response contains a different channel', 422);
      if (message.server !== undefined) requireId(message.server);
      if (message.attachments != null && (!Array.isArray(message.attachments) || message.attachments.some((a: unknown) => !a || typeof a !== 'object' || Array.isArray(a)))) throw new RequestError('Invalid attachment list', 422);
    }
    return data;
  }
  async server(serverId: string, origin = ARCHIVE_ORIGINS[0]): Promise<Server> {
    requireId(serverId);
    const data = await this.json(`/discord/server/${serverId}`, origin) as Record<string, unknown> | null;
    if (!data || requireId(data.id) !== serverId || !Array.isArray(data.channels)) throw new RequestError('Invalid server metadata', 422);
    return {
      id: serverId, name: typeof data.name === 'string' ? data.name : serverId,
      channels: data.channels.map(c => ({
        id: requireId(c.id), name: typeof c.name === 'string' ? c.name : c.id,
        parentId: typeof c.parent_channel_id === 'string' ? requireId(c.parent_channel_id) : null,
        type: typeof c.type === 'number' ? c.type : null,
        postCount: Number.isSafeInteger(c.post_count) && c.post_count >= 0 ? c.post_count : null,
      })),
    };
  }
}
