import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ requireDirectory: vi.fn(), stagedFile: vi.fn(), createArchive: vi.fn() }));
vi.mock('../src/storage/destination', async original => ({ ...await original<typeof import('../src/storage/destination')>(), requireDirectory: mocks.requireDirectory }));
vi.mock('../src/storage/zipCache', () => ({ stagedFile: mocks.stagedFile, createArchive: mocks.createArchive, removeStagedFile: vi.fn() }));
import { checkFolder, folderSync, writePostIndex } from '../src/services/posts/folder';
import { removeExtractedArchive } from '../src/services/posts/extraction';
import { buildPostZip } from '../src/services/posts/zip';
import { emptySync, recordSaved } from '../src/services/posts/sync';
import { archiveSettings, defaultSelection } from '../src/services/posts/settings';
import type { PostJob, PostTask } from '../src/services/posts/types';

const files = new Map<string, Blob>(), events: string[] = [];
let failIndex = false;
function directory(prefix = ''): FileSystemDirectoryHandle {
  return {
    getDirectoryHandle: async (name: string) => directory(prefix + name + '/'),
    getFileHandle: async (name: string, options?: { create?: boolean }) => {
      const path = prefix + name;
      if (!options?.create && !files.has(path)) throw new DOMException('Missing', 'NotFoundError');
      return { getFile: async () => files.get(path), createWritable: async () => {
        let pending: Blob;
        return { write: async (blob: Blob) => { pending = blob; }, close: async () => {
          if (failIndex && path === 'sync.json') throw new Error('Disk full');
          files.set(path, pending); events.push('write:' + path);
        }, abort: async () => {} };
      } };
    },
    removeEntry: async (name: string) => { const path = prefix + name; if (!files.delete(path)) throw new DOMException('Missing', 'NotFoundError'); events.push('remove:' + path); },
  } as unknown as FileSystemDirectoryHandle;
}
function job(): PostJob {
  const task: PostTask = { id: '100:full res:/aa/bb/' + 'a'.repeat(64) + '.zip', postId: '100', quality: 'full res', kind: 'file', url: null, path: 'full res/100_Title/001_bundle.zip', status: 'downloaded', bytes: 8, attempts: 1, nextAt: 0, error: null,
    extraction: { state: 'done', files: [] } };
  task.extraction!.files = [{ id: task.id + ':extract:1', path: task.path + '.extracted/nested/file.txt', bytes: 7 }];
  const value = { id: 'archive-saving', source: { origin: 'https://pawchive.pw', platform: 'fanbox', creatorId: '123', postId: null }, sourceUrl: 'https://pawchive.pw/fanbox/user/123', creatorName: 'Creator', selection: { ...defaultSelection(), extractArchives: true }, posts: [{ id: '100', title: 'Title' }], scan: { complete: true }, tasks: [task], destination: { kind: 'folder', directoryId: 'folder', name: 'Creator' } } as PostJob;
  value.sync = emptySync(value); recordSaved(value.sync, task, 'Title');
  files.set(task.path, new Blob(['original'])); files.set(task.extraction!.files[0].path, new Blob(['content']));
  return value;
}
const json = (value: unknown) => new Blob([JSON.stringify(value)]);
beforeEach(() => { files.clear(); events.length = 0; failIndex = false; vi.resetAllMocks(); mocks.requireDirectory.mockResolvedValue(directory()); });
describe('settings migration and extracted archive saving', () => {
  it('reads old history with default type/extraction settings and creates settings.json at the next save', async () => {
    const value = job(); files.set('sync.json', json(value.sync));
    expect((await folderSync('folder', value))!.selection).toMatchObject({ excludedFileTypes: [], extractArchives: false });
    value.selection = { ...defaultSelection(), excludedFileTypes: ['psd'] }; value.sync!.selection = value.selection;
    await writePostIndex(value);
    expect(JSON.parse(await files.get('settings.json')!.text())).toEqual(archiveSettings(value.source, value.selection));
    expect((await folderSync('folder', value))!.selection).toEqual(value.selection);
  });
  it('rejects malformed settings instead of treating them as an old archive', async () => {
    const value = job(); files.set('sync.json', json(value.sync)); files.set('settings.json', new Blob(['{broken']));
    await expect(folderSync('folder', value)).rejects.toThrow('not valid JSON');
  });
  it('persists recovery history and verifies extracted outputs before removing the compressed file', async () => {
    const value = job(), task = value.tasks[0];
    await removeExtractedArchive(value, task.id);
    expect(files.has(task.path)).toBe(false); expect(files.has(task.extraction!.files[0].path)).toBe(true);
    expect(events.indexOf('write:sync.json')).toBeLessThan(events.indexOf('remove:' + task.path));
    expect(JSON.parse(await files.get('sync.json')!.text()).posts[0].files[0].originalKept).toBe(false);
    await expect(removeExtractedArchive(value, task.id)).resolves.toBeUndefined();
  });
  it('keeps the original if extraction, an output or the metadata write fails', async () => {
    const value = job(), task = value.tasks[0];
    task.extraction!.state = 'failed'; await expect(removeExtractedArchive(value, task.id)).rejects.toThrow('incomplete');
    task.extraction!.state = 'done'; files.set(task.extraction!.files[0].path, new Blob(['bad']));
    await expect(removeExtractedArchive(value, task.id)).rejects.toThrow('incomplete'); expect(files.has(task.path)).toBe(true);
    files.set(task.extraction!.files[0].path, new Blob(['content'])); failIndex = true;
    await expect(removeExtractedArchive(value, task.id)).rejects.toThrow('Disk full'); expect(files.has(task.path)).toBe(true);
  });
  it('syncs complete extracted contents without the original, and redownloads if an output is missing or extraction is disabled', async () => {
    const value = job(), task = value.tasks[0]; await removeExtractedArchive(value, task.id);
    expect((await checkFolder(value)).files).toMatchObject([{ id: task.id, extraction: { state: 'done', originalRemoved: true } }]);
    const old = task.extraction; task.extraction = undefined;
    expect((await checkFolder(value)).files).toEqual([]);
    task.extraction = old; files.delete(task.extraction!.files[0].path);
    expect((await checkFolder(value)).files).toEqual([]);
  });
  it.each(['done', 'failed'] as const)('exports extracted files and keeps the compressed original only on failure (%s)', async state => {
    const value = job(), task = value.tasks[0]; value.destination = { kind: 'zip' }; task.status = 'staged'; task.extraction!.state = state;
    const output = new Map<string, Blob>();
    mocks.stagedFile.mockImplementation(async (_job: string, id: string) => id === task.id ? new Blob(['original']) : new Blob(['content']));
    mocks.createArchive.mockImplementation(async (_job: string, entries: AsyncIterable<{ path: string; blob: Blob }>, total: number) => {
      for await (const entry of entries) output.set(entry.path, entry.blob);
      expect(output.size).toBe(total); return { bytes: 100, entries: total };
    });
    await buildPostZip(value, new AbortController().signal, () => {});
    expect([...output.keys()].some(path => path.endsWith('001_bundle.zip'))).toBe(state === 'failed');
    expect([...output.keys()].some(path => path.endsWith('.extracted/nested/file.txt'))).toBe(true);
    expect([...output.keys()].some(path => path.endsWith('/settings.json'))).toBe(true);
  });
});
