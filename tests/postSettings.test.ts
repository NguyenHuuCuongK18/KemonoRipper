import { describe, expect, it } from 'vitest';
import { archiveSettings, defaultSelection, parseSettings, validSelection } from '../src/services/posts/settings';
import { detectedFileTypes, fileType } from '../src/services/posts/fileTypes';
import { createTasks, normalizePost } from '../src/services/posts/media';
import { emptySync, parseSync, recordSaved, syncKey } from '../src/services/posts/sync';
import type { PostJob } from '../src/services/posts/types';

const source = { origin: 'https://pawchive.pw', platform: 'fanbox' as const, creatorId: '123', postId: null };
function job(): PostJob {
  const names = ['image.PNG', 'source.psd', 'clip.mkv', 'bundle.tar.gz', 'no-extension', 'file.customformat'];
  return { source, creatorName: 'Creator', selection: defaultSelection(), posts: [normalizePost({ id: '100', user: '123', service: 'fanbox', attachments: names.map((name, i) => ({ name, path: `/aa/bb/${String(i).repeat(64)}` })) }, source)] } as PostJob;
}
describe('scanned file types and archive settings', () => {
  it('detects every advertised extension, compound archives and unknown types; all are selected by default', () => {
    const value = job();
    expect(detectedFileTypes(value)).toEqual(['customformat', 'mkv', 'png', 'psd', 'tar.gz', 'txt', 'unknown'].map(type => ({ type, count: 1 })));
    expect(createTasks(value, defaultSelection())).toHaveLength(7);
    expect(fileType('A\\folder/archive.TAR.XZ')).toBe('tar.xz');
    expect(fileType('.hidden')).toBe('unknown');
  });
  it('filters image, other-file and generated text extensions while leaving newly discovered types selected', () => {
    const value = job(), selection = { ...defaultSelection(), excludedFileTypes: ['png', 'psd', 'txt'] };
    const tasks = createTasks(value, selection);
    expect(tasks).toHaveLength(4); expect(tasks.every(task => task.kind === 'file')).toBe(true);
    expect(tasks.some(task => task.path.endsWith('.customformat'))).toBe(true);
    expect(tasks.some(task => task.path.endsWith('no-extension'))).toBe(true);
  });
  it('scopes the type checklist to the selected posts and initializes optional extraction only for archives', () => {
    const value = job(); value.selectedPostIds = [];
    expect(detectedFileTypes(value)).toEqual([]);
    value.selectedPostIds = undefined;
    const tasks = createTasks(value, { ...defaultSelection(), extractArchives: true });
    expect(tasks.filter(task => task.extraction)).toHaveLength(1);
    expect(tasks.find(task => task.extraction)?.path).toMatch(/\.tar.gz$/);
  });
  it('round-trips settings and supplies default values for omitted optional settings', () => {
    const selection = { ...defaultSelection(), excludedFileTypes: ['psd'], extractArchives: true };
    expect(parseSettings(JSON.parse(JSON.stringify(archiveSettings(source, selection))), source)).toEqual(selection);
    expect(parseSettings(archiveSettings(source, { quality: 'full res', images: true, files: true, text: true }), source)).toEqual(defaultSelection());
    expect(validSelection({ ...selection, excludedFileTypes: ['psd', 'png', 'psd'] }).excludedFileTypes).toEqual(['png', 'psd']);
  });
  it('rejects foreign or malformed settings instead of silently changing the archive selection', () => {
    const settings = archiveSettings(source, defaultSelection());
    expect(() => parseSettings(settings, { ...source, creatorId: '456' })).toThrow('different');
    for (const selection of [{ ...defaultSelection(), excludedFileTypes: ['../zip'] }, { ...defaultSelection(), extractArchives: 'yes' }]) expect(() => parseSettings({ ...settings, selection }, source)).toThrow();
  });
  it('validates extracted-only history and rejects foreign paths, duplicate IDs or missing outputs', () => {
    const value = job(), task = createTasks(value, defaultSelection()).find(task => task.kind === 'file')!;
    task.path = 'full res/100_Title/001_source.psd'; task.status = 'downloaded'; task.bytes = 123;
    task.extraction = { state: 'done', files: [{ id: syncKey(task.id) + ':extract:1', path: task.path + '.extracted/a.txt', bytes: 0 }] };
    const index = emptySync(value); recordSaved(index, task, 'Title');
    expect(parseSync(index, source).posts[0].files[0]).toMatchObject({ originalKept: false, extracted: task.extraction.files });
    const corrupt = structuredClone(index); corrupt.posts[0].files[0].extracted![0].path = 'full res/999_Other/a.txt';
    expect(() => parseSync(corrupt, source)).toThrow();
    corrupt.posts[0].files[0].extracted = [];
    expect(() => parseSync(corrupt, source)).toThrow();
  });
});
