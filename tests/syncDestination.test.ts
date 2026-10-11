import { describe, expect, it, vi } from 'vitest';
import { assertSyncDirectory, canUseSyncDirectory, readSyncFile } from '../src/services/posts/syncDestination';
import type { ArchiveDirectory } from '../src/storage/destination';
import type { PostScope } from '../src/services/posts/types';

const source: PostScope = { origin: 'https://pawchive.pw', platform: 'fanbox', creatorId: '123', postId: null };
const index = { format: 'archive-ripper-post-sync', version: 1, source: { origin: source.origin, platform: source.platform, creatorId: source.creatorId }, creatorName: 'Creator', updatedAt: '', selection: { quality: 'full res', images: true, files: true, text: true }, posts: [] };
function file(name = 'sync.json', contents = JSON.stringify(index), size = contents.length): FileSystemFileHandle {
  return { name, getFile: vi.fn().mockResolvedValue({ size, text: vi.fn().mockResolvedValue(contents) }) } as unknown as FileSystemFileHandle;
}
function directory(path: string[] | null, permission: PermissionState = 'granted'): ArchiveDirectory {
  return { resolve: vi.fn().mockResolvedValue(path), queryPermission: vi.fn().mockResolvedValue(permission) } as unknown as ArchiveDirectory;
}

describe('choosing a sync file', () => {
  it('validates native sync and older manifest files', async () => {
    expect(await readSyncFile(file(), source)).toMatchObject({ source: index.source, posts: [] });
    const legacy = { schemaVersion: 1, sourceUrl: source.origin + '/fanbox/user/123', creator: 'Creator', selection: index.selection, files: [], posts: [] };
    expect(await readSyncFile(file('manifest.json', JSON.stringify(legacy)), source)).toMatchObject({ source: index.source, posts: [] });
  });
  it('rejects a different creator before connecting or granting a folder', async () => {
    await expect(readSyncFile(file('sync.json', JSON.stringify({ ...index, source: { ...index.source, creatorId: '456' } })), source)).rejects.toThrow('different website, service, or creator');
  });
  it('rejects a failure report and malformed JSON', async () => {
    await expect(readSyncFile(file('failures.json', '[]'), source)).rejects.toThrow('sync.json or manifest.json');
    await expect(readSyncFile(file('sync.json', '{'), source)).rejects.toThrow('not valid JSON');
  });
  it('rejects oversized files without reading their contents', async () => {
    const handle = file('sync.json', '', 32 * 1024 * 1024 + 1);
    await expect(readSyncFile(handle, source)).rejects.toThrow('32 MiB');
    expect((await handle.getFile()).text).not.toHaveBeenCalled();
  });
  it.each([null, ['child', 'sync.json'], ['another.json']])('rejects the wrong folder or a parent folder: %j', async path => {
    await expect(assertSyncDirectory(directory(path), file())).rejects.toThrow('directly containing');
  });
  it('accepts only the direct folder of the selected file and reuses existing write access', async () => {
    const handle = file(), folder = directory(['sync.json']);
    await expect(assertSyncDirectory(folder, handle)).resolves.toBeUndefined();
    expect(await canUseSyncDirectory(folder, handle)).toBe(true);
    expect(folder.resolve).toHaveBeenCalledWith(handle);
    expect(await canUseSyncDirectory(directory(null), handle)).toBe(false);
  });
  it('requires another user gesture for missing access without attempting to prompt in the background', async () => {
    const handle = file(), folder = directory(['sync.json'], 'prompt');
    expect(await canUseSyncDirectory(folder, handle)).toBe(false);
    expect(folder.resolve).not.toHaveBeenCalled();
  });
});
