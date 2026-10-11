import type { ArchivedPost, PostJob } from './types';

// Scope belongs to the job, not to the creator's shared download history.
export function selectedPosts(job: Pick<PostJob, 'posts' | 'selectedPostIds'>): ArchivedPost[] {
  if (job.selectedPostIds === undefined) return job.posts;
  const ids = new Set(job.selectedPostIds);
  return job.posts.filter(post => ids.has(post.id));
}

export function changePostSelection(job: PostJob, postId: unknown, selected: unknown): void {
  if (typeof selected !== 'boolean') throw new Error('Invalid post selection.');
  if (postId === undefined) {
    if (selected) delete job.selectedPostIds;
    else job.selectedPostIds = [];
    return;
  }
  if (typeof postId !== 'string' || !job.posts.some(post => post.id === postId)) throw new Error('Choose a post discovered in this creator.');
  const ids = new Set(job.selectedPostIds ?? job.posts.map(post => post.id));
  if (selected) ids.add(postId); else ids.delete(postId);
  job.selectedPostIds = [...ids];
}
