import { postSourceUrl } from '../registry';
import type { PostJob } from './types';

export function postFailures(job: PostJob) {
  return [
    ...job.tasks.filter(task => ['failed', 'unavailable'].includes(task.status)).map(task => ({ ...task, stage: 'download' as const })),
    ...job.tasks.filter(task => task.extraction?.state === 'failed').map(task => ({ stage: 'extraction' as const, postId: task.postId, path: task.path, error: task.extraction!.error || 'Archive extraction failed.', originalKept: true })),
    ...(job.scan.failures || []).map(failure => ({ ...failure, stage: 'discovery' as const,
      sourceUrl: failure.kind === 'post' ? postSourceUrl({ ...job.source, postId: failure.postId }) : `${job.source.origin}/api/v1/${job.source.platform}/user/${job.source.creatorId}?o=${failure.offset}` })),
  ];
}
