import { createArchive, stagedFile, type ZipEntry } from '../../storage/zipCache';
import { creatorFolder, postZipJob } from './media';
import { zipSync } from './sync';
import type { PostJob } from './types';

export async function buildPostZip(job: PostJob, signal: AbortSignal, progress: (count: number, total: number) => void): Promise<{ bytes: number; entries: number }> {
  job = postZipJob(job);
  const included = job.tasks.filter(task => ['staged', 'downloaded'].includes(task.status));
  async function* entries(): AsyncGenerator<ZipEntry> {
    for (const task of included) {
      signal.throwIfAborted();
      const blob = await stagedFile(job.id, task.id);
      if (blob.size !== task.bytes) throw new Error('A cached attachment is missing or incomplete. Retry the download.');
      const published = job.posts.find(post => post.id === task.postId)?.published;
      const date = published ? new Date(/(?:Z|[+-]\d\d:\d\d)$/.test(published) ? published : published + 'Z') : undefined;
      yield { path: task.path, blob, date: date && Number.isFinite(date.getTime()) ? date : undefined };
    }
    const base = creatorFolder(job);
    const postIds = new Set(job.tasks.map(task => task.postId));
    const posts = job.posts.filter(post => postIds.has(post.id)).map(post => ({ ...post, content: job.selection.text ? post.content : undefined, embed: job.selection.text ? post.embed : undefined }));
    const manifest = { schemaVersion: 1, sourceUrl: job.sourceUrl, creator: job.creatorName, service: job.source.platform, selection: job.selection, selectedPostIds: job.selectedPostIds, scan: job.scan, posts, files: job.tasks };
    yield { path: `${base}/manifest.json`, blob: new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }) };
    yield { path: `${base}/sync.json`, blob: new Blob([JSON.stringify(zipSync(job), null, 2)], { type: 'application/json' }) };
    yield { path: `${base}/failures.json`, blob: new Blob([JSON.stringify(job.tasks.filter(task => ['failed', 'unavailable'].includes(task.status)), null, 2)], { type: 'application/json' }) };
  }
  return createArchive(job.id, entries(), included.length + 3, signal, progress);
}
