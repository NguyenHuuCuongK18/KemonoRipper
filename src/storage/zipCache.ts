import type { Job, MediaRecord } from '../core/types';
import { sha256, relativePathParts } from './folderWriter';
import { BlobReader, ZipWriter } from '@zip.js/zip.js';
import { channelFolder, serverFolder } from '../core/filenameBuilder';
import { csv, manifest } from './manifestExporter';

export class ZipStorageError extends Error {
  constructor() { super('ZIP cache could not be written. Free some disk space, then Resume.'); }
}
const cacheActivity = new Map<string, number>();
const activityFile = '.last-used';
async function jobDirectory(jobId: string, create = false): Promise<FileSystemDirectoryHandle> {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(jobId)) throw new Error('Invalid ZIP cache ID');
  const root = await navigator.storage.getDirectory();
  const cache = await root.getDirectoryHandle('kemono-zip-jobs', { create });
  const directory = await cache.getDirectoryHandle(jobId, { create });
  // Persist real cache use across worker/browser restarts, at most once per 15 seconds.
  const now = Date.now();
  if (!cacheActivity.has(jobId) || now - cacheActivity.get(jobId)! >= 15 * 1000) {
    const output = await (await directory.getFileHandle(activityFile, { create: true })).createWritable();
    try { await output.write(String(now)); await output.close(); cacheActivity.set(jobId, now); }
    catch (error) { await output.abort().catch(() => {}); throw error; }
  }
  return directory;
}
async function cacheName(id: string): Promise<string> { return sha256(new Blob([id])); }
export async function stagedFile(jobId: string, recordId: string): Promise<File> {
  const directory = await jobDirectory(jobId);
  return (await directory.getFileHandle(await cacheName(recordId))).getFile();
}
export async function removeStagedFile(jobId: string, recordId: string): Promise<void> {
  try { await (await jobDirectory(jobId)).removeEntry(await cacheName(recordId)); }
  catch (error) { if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error; }
}
export async function stageImage(jobId: string, recordId: string, blob: Blob): Promise<void> {
  try {
    const directory = await jobDirectory(jobId, true);
    const stream = await (await directory.getFileHandle(await cacheName(recordId), { create: true })).createWritable();
    try { await stream.write(blob); await stream.close(); } catch (error) { await stream.abort().catch(() => {}); throw error; }
  } catch { throw new ZipStorageError(); }
}
export async function stageStream(jobId: string, recordId: string, input: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<File> {
  const directory = await jobDirectory(jobId, true);
  const handle = await directory.getFileHandle(await cacheName(recordId), { create: true });
  const output = await handle.createWritable();
  try { await input.pipeTo(output, { signal }); return await handle.getFile(); }
  catch (error) { await output.abort().catch(() => {}); throw error; }
}
export async function stagedMatches(jobId: string, record: Pick<MediaRecord, 'id' | 'sha256' | 'bytes'>): Promise<boolean> {
  try {
    const file = await stagedFile(jobId, record.id);
    return file.size === record.bytes && await sha256(file) === record.sha256;
  } catch (error) { if (error instanceof DOMException && error.name === 'NotFoundError') return false; throw error; }
}
export async function archiveFile(jobId: string): Promise<File> {
  return (await (await jobDirectory(jobId)).getFileHandle('archive.zip')).getFile();
}
export async function clearZipCache(jobId: string): Promise<void> {
  // Resolve only a validated child of this extension's private ZIP cache.
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(jobId)) throw new Error('Invalid ZIP cache ID');
  try {
    const root = await navigator.storage.getDirectory();
    const cache = await root.getDirectoryHandle('kemono-zip-jobs');
    await cache.removeEntry(jobId, { recursive: true });
    cacheActivity.delete(jobId);
  } catch (error) { if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error; }
}
export async function clearAllZipCaches(): Promise<void> {
  // Only the extension's private staging namespace; never a chosen archive folder.
  try { await (await navigator.storage.getDirectory()).removeEntry('kemono-zip-jobs', { recursive: true }); cacheActivity.clear(); }
  catch (error) { if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error; }
}
export interface ZipCacheCleanup {
  before: number;
  protectedJobIds: string[];
  jobUpdatedAt: Record<string, number>;
}
interface IterableDirectory extends FileSystemDirectoryHandle {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
  values(): AsyncIterableIterator<FileSystemHandle>;
}
export interface ZipCacheInfo { id: string; bytes: number; files: number; lastUsedAt: number | null; hasArchive: boolean; error?: string }
export async function listZipCaches(): Promise<ZipCacheInfo[]> {
  let cache: FileSystemDirectoryHandle;
  try { cache = await (await navigator.storage.getDirectory()).getDirectoryHandle('kemono-zip-jobs'); }
  catch (error) { if (error instanceof DOMException && error.name === 'NotFoundError') return []; throw error; }
  const caches: ZipCacheInfo[] = [];
  for await (const [id, directory] of (cache as IterableDirectory).entries()) {
    if (directory.kind !== 'directory' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) continue;
    const info: ZipCacheInfo = { id, bytes: 0, files: 0, lastUsedAt: null, hasArchive: false };
    let modified = 0, marker = 0;
    try {
      // Inspect metadata and the tiny activity marker, never attachment contents.
      for await (const entry of (directory as IterableDirectory).values()) {
        if (entry.kind !== 'file') continue;
        const file = await (entry as FileSystemFileHandle).getFile();
        if (entry.name === activityFile) { const value = Number(await file.text()); if (Number.isFinite(value) && value > 0) marker = value; continue; }
        info.bytes += file.size; info.files++; modified = Math.max(modified, file.lastModified);
        if (entry.name === 'archive.zip') info.hasArchive = true;
      }
      info.lastUsedAt = Math.max(cacheActivity.get(id) || 0, marker || modified) || null;
    } catch { info.error = 'Some temporary files could not be inspected.'; }
    caches.push(info);
  }
  return caches.sort((a, b) => b.bytes - a.bytes || a.id.localeCompare(b.id));
}
export async function pruneZipCaches(options: ZipCacheCleanup): Promise<{ removed: string[] }> {
  if (!Number.isFinite(options.before)) throw new Error('Invalid ZIP cache expiry.');
  let cache: FileSystemDirectoryHandle;
  try { cache = await (await navigator.storage.getDirectory()).getDirectoryHandle('kemono-zip-jobs'); }
  catch (error) { if (error instanceof DOMException && error.name === 'NotFoundError') return { removed: [] }; throw error; }
  const protectedIds = new Set(options.protectedJobIds), removed: string[] = [];
  for await (const [id, directory] of (cache as IterableDirectory).entries()) {
    if (directory.kind !== 'directory' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id) || protectedIds.has(id)) continue;
    let lastUsed = Math.max(options.jobUpdatedAt[id] || 0, cacheActivity.get(id) || 0);
    if (lastUsed >= options.before) continue;
    const child = directory as FileSystemDirectoryHandle;
    try {
      const marker = await (await child.getFileHandle(activityFile)).getFile();
      const timestamp = Number(await marker.text());
      if (!Number.isFinite(timestamp) || timestamp <= 0) continue; // Retain unknown/corrupt activity metadata.
      lastUsed = Math.max(lastUsed, timestamp);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
      // Legacy/orphan caches have no marker: inspect file dates without reading their contents.
      for await (const entry of (child as IterableDirectory).values()) {
        if (entry.kind !== 'file') { lastUsed = Infinity; break; }
        lastUsed = Math.max(lastUsed, (await (entry as FileSystemFileHandle).getFile()).lastModified);
        if (lastUsed >= options.before) break;
      }
    }
    if (lastUsed >= options.before) continue;
    // A busy or inaccessible cache must not prevent other stale caches from being cleaned.
    try { await clearZipCache(id); removed.push(id); } catch { /* Retry on the next check. */ }
  }
  return { removed };
}
export interface ZipEntry { path: string; blob: Blob; date?: Date }
export async function writeZip(output: WritableStream<Uint8Array>, entries: AsyncIterable<ZipEntry>, signal?: AbortSignal, progress?: (count: number) => void): Promise<number> {
  // Images are already compressed. Store their validated bytes and stream to disk.
  const writer = new ZipWriter(output, { level: 0, zip64: true, useWebWorkers: false });
  let count = 0;
  for await (const entry of entries) {
    signal?.throwIfAborted(); relativePathParts(entry.path);
    await writer.add(entry.path, new BlobReader(entry.blob), { signal, lastModDate: entry.date });
    progress?.(++count);
  }
  signal?.throwIfAborted(); await writer.close(); return count;
}
export async function buildZip(job: Job, records: MediaRecord[], signal: AbortSignal, progress: (count: number, total: number) => void): Promise<{ bytes: number; entries: number }> {
  const included = records.filter(r => r.status === 'staged' || r.status === 'downloaded');
  const finalRecords = records.map(r => r.status === 'staged' ? { ...r, status: 'downloaded' as const } : r);
  const finalJob: Job = { ...job, status: 'finished', manifestState: 'saved', archive: undefined };
  const total = included.length + job.channels.length + 4;
  async function* entries(): AsyncGenerator<ZipEntry> {
    for (const record of included) {
      signal.throwIfAborted();
      if (!record.savedPath || !await stagedMatches(job.id, record)) throw new Error('Cached image is missing or damaged; prepare the ZIP again to recover it.');
      yield { path: record.savedPath, blob: await stagedFile(job.id, record.id), date: record.publishedAtUtc ? new Date(record.publishedAtUtc) : undefined };
    }
    for (const channel of job.channels) yield { path: `${channelFolder({ ...job, channelId: channel.channelId, channelName: channel.channelName })}/channel-manifest.json`, blob: new Blob([manifest(finalJob, finalRecords, channel.channelId)]) };
    const base = serverFolder(job);
    yield { path: `${base}/manifest.json`, blob: new Blob([manifest(finalJob, finalRecords)]) };
    yield { path: `${base}/links.csv`, blob: new Blob([csv(finalRecords)]) };
    yield { path: `${base}/failures.json`, blob: new Blob([manifest(finalJob, finalRecords.filter(r => r.status === 'failed' || r.status === 'skipped'))]) };
    yield { path: `${base}/README.txt`, blob: new Blob(['Images are organized by channel. manifest.json records coverage, sources, dates and checksums. failures.json lists unavailable or skipped media. A completed ZIP does not guarantee every archived image was available.\n']) };
  }
  return createArchive(job.id, entries(), total, signal, progress);
}
export async function createArchive(jobId: string, entries: AsyncIterable<ZipEntry>, total: number, signal: AbortSignal, progress: (count: number, total: number) => void): Promise<{ bytes: number; entries: number }> {
  const directory = await jobDirectory(jobId, true);
  const stream = await (await directory.getFileHandle('archive.zip', { create: true })).createWritable();
  try {
    const count = await writeZip(stream, entries, signal, count => progress(count, total));
    return { bytes: (await archiveFile(jobId)).size, entries: count };
  } catch (error) { await stream.abort().catch(() => {}); throw error; }
}
