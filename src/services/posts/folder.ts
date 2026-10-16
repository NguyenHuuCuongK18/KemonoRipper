import { requireDirectory } from '../../storage/destination';
import { relativePathParts, writeRelativeFile } from '../../storage/folderWriter';
import { stagedFile } from '../../storage/zipCache';
import { assertSyncSource, mergeSync, parseSync, syncKey } from './sync';
import { postFailures } from './failures';
import { archiveSettings, parseSettings } from './settings';
import type { PostExtraction, PostJob, PostSyncIndex } from './types';

export async function folderSync(directoryId: string, job: PostJob): Promise<PostSyncIndex | undefined> {
  const directory = await requireDirectory(directoryId);
  for (const name of ['sync.json', 'manifest.json']) try {
    const file = await (await directory.getFileHandle(name)).getFile();
    if (file.size > 32 * 1024 * 1024) throw new Error('The sync JSON exceeds the 32 MiB limit.');
    const index = parseSync(JSON.parse(await file.text()), job.source);
    try {
      const settings = await (await directory.getFileHandle('settings.json')).getFile();
      if (settings.size > 128 * 1024) throw new Error('Archive settings.json is too large.');
      let value: unknown; try { value = JSON.parse(await settings.text()); } catch { throw new Error('Archive settings.json is not valid JSON.'); }
      index.selection = parseSettings(value, job.source);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
      index.selection = { ...index.selection, excludedFileTypes: [], extractArchives: false };
    }
    return index;
  } catch (error) { if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error; }
  return undefined;
}
export async function checkFolder(job: PostJob): Promise<{ sync: PostSyncIndex | undefined; files: { id: string; path: string; bytes: number; extraction?: PostExtraction }[] }> {
  if (job.destination?.kind !== 'folder') throw new Error('Choose a creator folder first.');
  const directoryId = job.destination.directoryId, directory = await requireDirectory(directoryId);
  const existing = await folderSync(directoryId, job);
  const sync = existing ? mergeSync(job.sync, existing) : job.sync;
  const downloaded = new Map(sync?.posts.flatMap(post => post.files.map(file => [file.id, file] as const)) || []);
  const files = [];
  async function matches(path: string, bytes: number): Promise<boolean> {
    try {
      let parent: FileSystemDirectoryHandle = directory;
      const parts = relativePathParts(path);
      for (const part of parts.slice(0, -1)) parent = await parent.getDirectoryHandle(part);
      return (await (await parent.getFileHandle(parts.at(-1)!)).getFile()).size === bytes;
    } catch (error) { if (error instanceof DOMException && error.name === 'NotFoundError') return false; throw error; }
  }
  for (const task of job.tasks) {
    const saved = downloaded.get(syncKey(task.id)); if (!saved) continue;
    const original = await matches(saved.path, saved.bytes);
    let extraction: PostExtraction | undefined;
    if (task.extraction && saved.extracted?.length) {
      let complete = true;
      for (const entry of saved.extracted) if (!await matches(entry.path, entry.bytes)) { complete = false; break; }
      if (complete) extraction = { state: 'done', files: saved.extracted, originalRemoved: !original };
    }
    if (original || (extraction && saved.originalKept === false)) files.push({ id: task.id, path: saved.path, bytes: saved.bytes, ...(extraction ? { extraction } : {}) });
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
  await writeRelativeFile(directoryId, 'failures.json', new Blob([JSON.stringify(postFailures(job), null, 2)], { type: 'application/json' }), true);
  const settings = JSON.stringify(archiveSettings(job.source, job.selection), null, 2);
  let unchanged = false;
  try { unchanged = await (await (await (await requireDirectory(directoryId)).getFileHandle('settings.json')).getFile()).text() === settings; }
  catch (error) { if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error; }
  if (!unchanged) await writeRelativeFile(directoryId, 'settings.json', new Blob([settings], { type: 'application/json' }), true);
}
