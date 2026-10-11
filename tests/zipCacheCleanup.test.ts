import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { archiveFile, clearAllZipCaches, listZipCaches, pruneZipCaches, stagedFile } from '../src/storage/zipCache';

class MemoryFile {
  readonly kind = 'file';
  constructor(readonly name: string, public file: File) {}
  async getFile() { return this.file; }
  async createWritable() {
    let data: BlobPart = '';
    return { write: async (value: BlobPart) => { data = value; }, close: async () => { this.file = new File([data], this.name); }, abort: async () => {} };
  }
}
class MemoryDirectory {
  readonly kind = 'directory';
  children = new Map<string, MemoryDirectory | MemoryFile>();
  constructor(readonly name: string) {}
  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<MemoryDirectory> {
    if (!this.children.has(name) && options?.create) this.children.set(name, new MemoryDirectory(name));
    const entry = this.children.get(name);
    if (!entry || entry.kind !== 'directory') throw new DOMException('Missing directory', 'NotFoundError');
    return entry;
  }
  async getFileHandle(name: string, options?: { create?: boolean }): Promise<MemoryFile> {
    if (!this.children.has(name) && options?.create) this.children.set(name, new MemoryFile(name, new File([], name)));
    const entry = this.children.get(name);
    if (!entry || entry.kind !== 'file') throw new DOMException('Missing file', 'NotFoundError');
    return entry;
  }
  removeEntry = vi.fn(async (name: string) => { if (!this.children.delete(name)) throw new DOMException('Missing entry', 'NotFoundError'); });
  async *entries() { yield* this.children.entries(); }
  async *values() { yield* this.children.values(); }
  addFile(name: string, contents: string, modified: number) { this.children.set(name, new MemoryFile(name, new File([contents], name, { lastModified: modified }))); }
}
let root: MemoryDirectory, cache: MemoryDirectory;
const now = Date.now(), old = now - 600_000;
beforeEach(async () => {
  root = new MemoryDirectory('root');
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } });
  await clearAllZipCaches();
  root.removeEntry.mockClear();
  cache = await root.getDirectoryHandle('kemono-zip-jobs', { create: true });
});
afterEach(() => vi.unstubAllGlobals());
async function cached(id: string, lastUsed?: number) {
  const directory = await cache.getDirectoryHandle(id, { create: true });
  directory.addFile('archive.zip', 'saved bytes', old);
  if (lastUsed !== undefined) directory.addFile('.last-used', String(lastUsed), old);
  return directory;
}
it('removes only idle private caches, preserving recent use, ongoing jobs and user folders', async () => {
  await cached('expired', old); await cached('orphan'); await cached('recent', now);
  await cached('paused', old); await cached('recent-job', old);
  const legacy = await cached('legacy'); legacy.addFile('partial', 'new data', now);
  const corrupt = await cached('corrupt'); corrupt.addFile('.last-used', 'invalid', old);
  const user = await root.getDirectoryHandle('chosen-folder', { create: true }); user.addFile('archive.zip', 'keep', old);
  expect(await pruneZipCaches({ before: now - 300_000, protectedJobIds: ['paused'], jobUpdatedAt: { 'recent-job': now } })).toEqual({ removed: ['expired', 'orphan'] });
  expect([...cache.children.keys()]).toEqual(['recent', 'paused', 'recent-job', 'legacy', 'corrupt']);
  expect(user.children.has('archive.zip')).toBe(true); expect(root.removeEntry).not.toHaveBeenCalled();
});
it('refreshes idle time when a ZIP is opened and retains untouched archive bytes', async () => {
  const directory = await cached('opened', old);
  const file = await archiveFile('opened'); expect(await file.text()).toBe('saved bytes');
  const timestamp = Number(await (await (await directory.getFileHandle('.last-used')).getFile()).text());
  expect(timestamp).toBeGreaterThanOrEqual(now);
  expect(await pruneZipCaches({ before: now - 300_000, protectedJobIds: [], jobUpdatedAt: {} })).toEqual({ removed: [] });
});
it('records staged file reads as cache activity and retains caches at the expiry boundary', async () => {
  const directory = await cached('read', old);
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('record')))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  directory.addFile(hash, 'staged bytes', old); expect(await (await stagedFile('read', 'record')).text()).toBe('staged bytes');
  await cached('boundary', now - 300_000);
  expect(await pruneZipCaches({ before: now - 300_000, protectedJobIds: [], jobUpdatedAt: {} })).toEqual({ removed: [] });
});
it('continues past a busy cache and retries it on the next check', async () => {
  await cached('busy', old); await cached('expired', old);
  cache.removeEntry.mockRejectedValueOnce(new DOMException('Busy', 'NoModificationAllowedError'));
  expect(await pruneZipCaches({ before: now - 300_000, protectedJobIds: [], jobUpdatedAt: {} })).toEqual({ removed: ['expired'] });
  expect(await pruneZipCaches({ before: now - 300_000, protectedJobIds: [], jobUpdatedAt: {} })).toEqual({ removed: ['busy'] });
});
it('does not create a cache namespace during checks and rejects invalid cutoffs', async () => {
  await clearAllZipCaches();
  expect(await pruneZipCaches({ before: now, protectedJobIds: [], jobUpdatedAt: {} })).toEqual({ removed: [] });
  expect(root.children.has('kemono-zip-jobs')).toBe(false);
  await expect(pruneZipCaches({ before: NaN, protectedJobIds: [], jobUpdatedAt: {} })).rejects.toThrow('Invalid');
});
it('lists cache sizes and file counts without extending idle lifetime or touching chosen folders', async () => {
  const directory = await cached('listed', old); directory.addFile('staged', 'bytes', old);
  const user = await root.getDirectoryHandle('chosen-folder', { create: true }); user.addFile('keep.zip', 'saved', now);
  expect(await listZipCaches()).toEqual([{ id: 'listed', bytes: 16, files: 2, lastUsedAt: old, hasArchive: true }]);
  expect(await pruneZipCaches({ before: now - 300_000, protectedJobIds: [], jobUpdatedAt: {} })).toEqual({ removed: ['listed'] });
  expect(user.children.has('keep.zip')).toBe(true);
});
