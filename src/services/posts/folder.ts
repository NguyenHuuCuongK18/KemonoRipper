import { requireDirectory } from '../../storage/destination';
import { relativePathParts, writeRelativeFile } from '../../storage/folderWriter';
import { stagedFile } from '../../storage/zipCache';
import { assertSyncSource, mergeSync, parseSync, syncKey } from './sync';
import type { PostJob, PostSyncIndex } from './types';

export async function folderSync(directoryId: string, job: PostJob): Promise<PostSyncIndex | undefined> {
  const directory = await requireDirectory(directoryId);
  for (const name of ['sync.json', 'manifest.json']) try {
    const file = await (await directory.getFileHandle(name)).getFile();
    if (file.size > 32 * 1024 * 1024) throw new Error('The sync JSON exceeds the 32 MiB limit.');
    return parseSync(JSON.parse(await file.text()), job.source);
  } catch (error) { if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error; }
  return undefined;
}
export async function checkFolder(job: PostJob): Promise<{ sync: PostSyncIndex | undefined; files: { id: string; path: string; bytes: number }[] }> {
  if (job.destination?.kind !== 'folder') throw new Error('Choose a creator folder first.');
  const directoryId = job.destination.directoryId, directory = await requireDirectory(directoryId);
  const existing = await folderSync(directoryId, job);
  const sync = existing ? mergeSync(job.sync, existing) : job.sync;
  const downloaded = new Map(sync?.posts.flatMap(post => post.files.map(file => [file.id, file] as const)) || []);
  const files = [];
  for (const task of job.tasks) {
    const saved = downloaded.get(syncKey(task.id)); if (!saved) continue;
    try {
      let parent: FileSystemDirectoryHandle = directory;
      const parts = relativePathParts(saved.path);
      for (const part of parts.slice(0, -1)) parent = await parent.getDirectoryHandle(part);
      const file = await (await parent.getFileHandle(parts.at(-1)!)).getFile();
      if (file.size === saved.bytes) files.push({ id: task.id, path: saved.path, bytes: saved.bytes });
    } catch (error) { if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error; }
  }
  return { sync, files };
}
export async function writePostFile(job: PostJob, taskId: string): Promise<{ path: string; bytes: number }> {
  if (job.destination?.kind !== 'folder') throw new Error('Choose a creator folder first.');
  const task = job.tasks.find(task => task.id === taskId);
  if (!task || task.status !== 'staged') throw new Error('The attachment is not ready to save.');
  const blob = await stagedFile(job.id, task.id);
  if (blob.size !== task.bytes) throw new Error('The collected attachment is incomplete. Retry this download.');
  return { path: await writeRelativeFile(job.destination.directoryId, task.path, blob), bytes: blob.size };
}
export async function writePostIndex(job: PostJob): Promise<void> {
  if (job.destination?.kind !== 'folder' || !job.sync) throw new Error('Choose a creator folder first.');
  const directoryId = job.destination.directoryId;
  assertSyncSource(job.sync, job.source);
  const existing = await folderSync(directoryId, job);
  const index = mergeSync(existing, job.sync);
  await writeRelativeFile(directoryId, 'sync.json', new Blob([JSON.stringify(index, null, 2)], { type: 'application/json' }), true);
  await writeRelativeFile(directoryId, 'failures.json', new Blob([JSON.stringify(job.tasks.filter(task => ['failed', 'unavailable'].includes(task.status)), null, 2)], { type: 'application/json' }), true);
}
