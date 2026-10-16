import { requireDirectory } from '../../storage/destination';
import { relativePathParts, writeRelativeFile } from '../../storage/folderWriter';
import { stagedFile, removeStagedFile } from '../../storage/zipCache';
import { postRelativePath } from './media';
import { syncKey } from './sync';
import { writePostIndex } from './folder';
import type { ExtractedFile, PostExtraction, PostJob, PostTask } from './types';

interface Running { jobId: string; result: PostExtraction; worker?: Worker; timer?: ReturnType<typeof setTimeout> }
const running = new Map<string, Running>();
const key = (jobId: string, id: string) => `${jobId}:${id}`;
export function extractingJobs(): string[] { return [...running.values()].map(item => item.jobId); }
export function stopExtractions(jobId?: string): void {
  for (const [id, item] of running) if (jobId === undefined || item.jobId === jobId) { item.worker?.terminate(); clearTimeout(item.timer); running.delete(id); }
}
async function sourceFile(job: PostJob, task: PostTask): Promise<Blob> {
  if (task.status === 'downloaded' && job.destination?.kind === 'folder') {
    const parts = relativePathParts(postRelativePath(task)); let directory: FileSystemDirectoryHandle = await requireDirectory(job.destination.directoryId);
    for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part);
    return (await directory.getFileHandle(parts.at(-1)!)).getFile();
  }
  return stagedFile(job.id, task.id);
}
export function startExtraction(job: PostJob, id: string): void {
  const entryKey = key(job.id, id); if (running.has(entryKey)) return;
  const item: Running = { jobId: job.id, result: { state: 'extracting', files: [] } }; running.set(entryKey, item);
  void (async () => {
    const task = job.tasks.find(task => task.id === id); if (!task?.extraction) throw new Error('Archive extraction task was not found.');
    const file = await sourceFile(job, task);
    if (running.get(entryKey) !== item) return;
    const worker = item.worker = new Worker(chrome.runtime.getURL('extract-worker.js'), { type: 'module' });
    const finish = (error?: string, files = item.result.files) => {
      worker.terminate(); clearTimeout(item.timer); item.worker = undefined;
      item.result = { state: error ? 'failed' : 'done', files, ...(error ? { error } : {}) };
    };
    const reset = () => { clearTimeout(item.timer); item.timer = setTimeout(() => finish('Archive extraction stopped making progress. The original was kept.'), 120_000); };
    worker.onmessage = event => {
      const message = event.data as { type: string; file?: ExtractedFile; files?: ExtractedFile[]; error?: string };
      reset();
      if (message.type === 'file' && message.file) item.result.files.push(message.file);
      if (message.type === 'done') finish(message.error, message.files);
    };
    worker.onerror = () => finish('Archive decoder could not read this file. The original was kept.');
    reset(); worker.postMessage({ jobId: job.id, id: syncKey(task.id), file, name: task.path, prefix: postRelativePath(task) + '.extracted/', wasmUrl: chrome.runtime.getURL('libarchive.wasm') });
  })().catch(error => { item.result = { state: 'failed', files: [], error: error instanceof Error ? error.message : 'Archive extraction failed. The original was kept.' }; });
}
export function extractionStatus(jobId: string, id: string): PostExtraction | null { return running.get(key(jobId, id))?.result || null; }
export function forgetExtraction(jobId: string, id: string): void { const item = running.get(key(jobId, id)); item?.worker?.terminate(); clearTimeout(item?.timer); running.delete(key(jobId, id)); }
export async function commitExtraction(job: PostJob, id: string): Promise<ExtractedFile[]> {
  if (job.destination?.kind !== 'folder') throw new Error('Choose a creator folder first.');
  const result = extractionStatus(job.id, id); if (!result || result.state === 'extracting') throw new Error('Archive extraction is not ready.');
  const files: ExtractedFile[] = [];
  for (const file of result.files) {
    const blob = await stagedFile(job.id, file.id); if (blob.size !== file.bytes) throw new Error('Extracted file is incomplete.');
    files.push({ ...file, path: await writeRelativeFile(job.destination.directoryId, file.path, blob) });
  }
  return files;
}
export async function clearExtractedCache(jobId: string, files: ExtractedFile[]): Promise<void> {
  for (const file of files) await removeStagedFile(jobId, file.id).catch(() => {});
}
// Persist recovery metadata and verify every output before removing the compressed source.
// Repeating this after a worker restart is safe, including an already removed source.
export async function removeExtractedArchive(job: PostJob, id: string): Promise<void> {
  const task = job.tasks.find(task => task.id === id);
  if (job.destination?.kind !== 'folder' || task?.extraction?.state !== 'done' || !task.extraction.files.length) throw new Error('Archive extraction is incomplete. The original was kept.');
  await writePostIndex(job);
  const root = await requireDirectory(job.destination.directoryId);
  for (const entry of task.extraction.files) {
    let directory: FileSystemDirectoryHandle = root; const parts = relativePathParts(entry.path);
    for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part);
    if ((await (await directory.getFileHandle(parts.at(-1)!)).getFile()).size !== entry.bytes) throw new Error('An extracted file is incomplete. The original was kept.');
  }
  let directory: FileSystemDirectoryHandle = root; const parts = relativePathParts(postRelativePath(task));
  try {
    for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part);
    const file = await (await directory.getFileHandle(parts.at(-1)!)).getFile();
    if (file.size !== task.bytes) throw new Error('The compressed file changed after extraction. It was kept.');
    await directory.removeEntry(parts.at(-1)!);
  } catch (error) { if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error; }
}
