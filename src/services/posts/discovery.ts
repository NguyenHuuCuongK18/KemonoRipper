import { RequestError } from '../../api/kemonoClient';
import { PostClient } from './client';
import { normalizePost } from './media';
import type { ApiPost, PostJob, PostScanFailure } from './types';

type Target = Pick<PostScanFailure, 'kind' | 'offset' | 'postId'>;
const key = (target: Target) => target.kind === 'post' ? `post:${target.postId}` : `page:${target.offset}`;
function target(job: PostJob): Target | undefined {
  if (job.detailQueue.length) return { kind: 'post', offset: job.scan.offset, postId: job.detailQueue[0] };
  if (job.scan.retrying) return job.scan.retryQueue?.[0];
  return { kind: job.source.postId ? 'post' : 'page', offset: job.scan.offset, postId: job.source.postId };
}
function clearFailure(job: PostJob, item: Target): void {
  job.scan.failures = job.scan.failures?.filter(failure => key(failure) !== key(item));
}
function recordFailure(job: PostJob, item: Target, error: string, status: number | null): void {
  const failure: PostScanFailure = { ...item, error, status, attempts: job.scan.attempts, at: new Date().toISOString() };
  const failures = job.scan.failures ||= [], index = failures.findIndex(previous => key(previous) === key(item));
  if (index < 0) failures.push(failure); else failures[index] = failure;
}
function finish(job: PostJob): void {
  job.scan.complete = true; job.scan.retrying = false; job.status = 'ready';
  if (!job.scan.failures?.length) job.scan.total = job.posts.length;
}
function advance(job: PostJob, item: Target): void {
  if (item.kind === 'post' && job.detailQueue[0] === item.postId) job.detailQueue.shift();
  else if (job.scan.retrying) job.scan.retryQueue?.shift();
  else if (job.source.postId) finish(job);
  else { job.scan.offset += 50; job.scan.pages++; }
  if (job.scan.retrying && !job.scan.retryQueue?.length && !job.detailQueue.length) finish(job);
}
function readyForNext(job: PostJob): void {
  job.scan.attempts = 0; job.scan.error = null; job.scan.errorStatus = null; job.scan.nextAt = Date.now() + 1000;
  job.error = null;
}
export function canSkipPostError(job: Pick<PostJob, 'status' | 'scan'>): boolean {
  return job.status === 'paused' && !job.scan.complete && !!job.scan.error && ![401, 403, 429].includes(job.scan.errorStatus || 0);
}
export function skipPostError(job: PostJob): void {
  if (!canSkipPostError(job)) throw new Error('Only a paused discovery error can be skipped. Restore site access or wait for rate limits before continuing.');
  const item = target(job); if (!item) throw new Error('There is no discovery error to skip.');
  recordFailure(job, item, job.scan.error!, job.scan.errorStatus ?? null);
  job.status = 'scanning'; job.scan.consecutiveFailures = 0; advance(job, item); readyForNext(job);
}
export function retryPostFailures(job: PostJob): void {
  job.scan.retryQueue = structuredClone(job.scan.failures || []);
  job.scan.retrying = true; job.scan.complete = false; job.scan.consecutiveFailures = 0;
}
function acceptPost(job: PostJob, post: ApiPost): void {
  const normalized = normalizePost(post, job.source), index = job.posts.findIndex(previous => previous.id === post.id);
  if (index < 0) job.posts.push(normalized); else if (job.scan.retrying || job.detailQueue[0] === post.id) job.posts[index] = normalized;
  const needsDetail = post.detail_fetched === false || post.content === undefined || post.attachments === undefined;
  if (!job.source.postId && needsDetail && !job.detailQueue.includes(post.id)) job.detailQueue.push(post.id);
  if (!needsDetail) clearFailure(job, { kind: 'post', offset: job.scan.offset, postId: post.id });
}
export async function discoverPosts(job: PostJob, client: PostClient): Promise<void> {
  const item = target(job);
  if (!item) { finish(job); readyForNext(job); return; }
  try {
    if (item.kind === 'post') {
      acceptPost(job, await client.post({ ...job.source, postId: item.postId }));
      clearFailure(job, item); advance(job, item);
    } else {
      if (!job.scan.retrying && job.scan.pages >= 10000) throw new Error('The profile exceeded the scan page limit.');
      const page = await client.page(job.source, item.offset), fingerprint = page.posts.map(post => post.id).join(',');
      if (!job.scan.retrying && fingerprint && job.scan.fingerprints.includes(fingerprint)) throw new Error('The API repeated a page. Retry or skip this error to continue.');
      if (fingerprint && !job.scan.fingerprints.includes(fingerprint)) job.scan.fingerprints.push(fingerprint);
      clearFailure(job, item);
      for (const post of page.posts) acceptPost(job, post);
      for (const failure of page.failures) recordFailure(job, { kind: failure.postId ? 'post' : 'page', offset: item.offset, postId: failure.postId }, failure.error, 422);
      job.scan.consecutiveFailures = page.count && !page.posts.length ? (job.scan.consecutiveFailures || 0) + 1 : 0;
      if (job.scan.consecutiveFailures >= 3) {
        job.scan.error = 'Three consecutive pages contained no valid posts. Restore site access, then Resume, or skip this error.';
        job.scan.errorStatus = 422; job.status = 'paused'; job.resumeStatus = 'scanning'; job.error = job.scan.error;
        return;
      }
      advance(job, item);
      if (!page.count && !job.scan.retrying) finish(job);
    }
    readyForNext(job);
  } catch (error) {
    job.scan.attempts++; job.scan.error = error instanceof Error ? error.message : 'Post discovery failed.';
    job.scan.errorStatus = error instanceof RequestError ? error.status : null;
    const retryable = error instanceof RequestError && error.retryable;
    if (retryable && job.scan.attempts < 3) job.scan.nextAt = Date.now() + Math.max(2000 * 2 ** (job.scan.attempts - 1), error.retryAfterMs);
    else if (error instanceof RequestError && ![401, 403, 429].includes(error.status) && (retryable || [404, 410, 422].includes(error.status))) {
      recordFailure(job, item, job.scan.error, error.status);
      if (item.kind === 'page') job.scan.consecutiveFailures = (job.scan.consecutiveFailures || 0) + 1;
      if (item.kind === 'page' && job.scan.consecutiveFailures! >= 3) {
        job.status = 'paused'; job.resumeStatus = 'scanning';
        job.error = `${job.scan.error} Three consecutive pages failed. Restore site access, then Resume, or skip this error.`;
      } else { advance(job, item); readyForNext(job); }
    } else { job.status = 'paused'; job.resumeStatus = 'scanning'; job.error = job.scan.error; }
  }
}
