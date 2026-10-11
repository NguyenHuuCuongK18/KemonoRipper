import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ requireDirectory: vi.fn() }));
vi.mock('../src/storage/destination', async importOriginal => ({ ...await importOriginal<typeof import('../src/storage/destination')>(), requireDirectory: mocks.requireDirectory }));
import { fileMatches, pathParts, sha256, writeFile } from '../src/storage/folderWriter';
import { FolderPermissionError } from '../src/storage/destination';
const files = new Map<string, Blob>();
let failClose = false;
function directory(path = ''): FileSystemDirectoryHandle {
  return {
    getDirectoryHandle: async (name: string) => directory(path + name + '/'),
    getFileHandle: async (name: string, options?: { create?: boolean }) => {
      const key = path + name;
      if (!options?.create && !files.has(key)) throw new DOMException('Missing', 'NotFoundError');
      return {
        getFile: async () => files.get(key),
        createWritable: async () => {
          let pending: Blob;
          return { write: async (blob: Blob) => { pending = blob; }, close: async () => { if (failClose) throw new Error('Disk full'); files.set(key, pending); }, abort: vi.fn().mockResolvedValue(undefined) };
        },
      };
    },
  } as unknown as FileSystemDirectoryHandle;
}
beforeEach(() => { files.clear(); failClose = false; mocks.requireDirectory.mockResolvedValue(directory()); });
it('rejects absolute paths, traversal, Windows drives, and empty components', () => {
  for (const path of ['/ArchiveRoot/file', 'C:/ArchiveRoot/file', 'ArchiveRoot/../file', 'ArchiveRoot//file', 'ArchiveRoot/a\\b', 'ArchiveRoot/a:b']) expect(() => pathParts(path)).toThrow('Unsafe');
});
it('writes nested archive paths and verifies the committed bytes', async () => {
  const blob = new Blob(['validated image']); const path = 'ArchiveRoot/server/channel/image.jpg';
  expect(await writeFile('job', path, blob)).toBe(path);
  expect(await fileMatches('job', path, await sha256(blob), blob.size)).toBe(true);
  expect(await fileMatches('job', path, 'different hash', blob.size)).toBe(false);
  expect(await fileMatches('job', 'ArchiveRoot/missing.jpg', 'hash', 10)).toBe(false);
});
it('preserves conflicting files and reuses a matching committed retry without duplicates', async () => {
  const path = 'ArchiveRoot/image.jpg'; files.set(path, new Blob(['existing']));
  expect(await writeFile('job', path, new Blob(['new']))).toBe('ArchiveRoot/image (1).jpg');
  expect(await writeFile('job', path, new Blob(['new']))).toBe('ArchiveRoot/image (1).jpg');
  expect(await files.get(path)!.text()).toBe('existing'); expect(files.size).toBe(2);
});
it('refreshes manifests only when overwrite is explicitly requested', async () => {
  const path = 'ArchiveRoot/manifest.json'; files.set(path, new Blob(['old']));
  await writeFile('job', path, new Blob(['new']), true); expect(await files.get(path)!.text()).toBe('new');
});
it('does not report successful saving before the writable stream closes', async () => {
  failClose = true;
  await expect(writeFile('job', 'ArchiveRoot/image.jpg', new Blob(['new']))).rejects.toThrow('Disk full'); expect(files.size).toBe(0);
});
it('stops for missing folder permission without writing anything', async () => {
  mocks.requireDirectory.mockRejectedValue(new FolderPermissionError());
  await expect(writeFile('job', 'ArchiveRoot/image.jpg', new Blob(['new']))).rejects.toBeInstanceOf(FolderPermissionError); expect(files.size).toBe(0);
});
