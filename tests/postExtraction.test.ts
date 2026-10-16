import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BlobWriter, TextReader, ZipWriter } from '@zip.js/zip.js';
import { describe, expect, it } from 'vitest';
import { archiveEntryPath } from '../src/services/posts/archivePaths';
import { extractArchive } from '../src/services/posts/extractArchive';

const wasm = resolve('node_modules/libarchive-wasm/dist/libarchive.wasm');
async function unpack(blob: Blob, name: string) {
  const files = new Map<string, Blob>();
  await extractArchive(blob, name, wasm, async entry => {
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    const output = new WritableStream<Uint8Array>({ write(chunk) { chunks.push(new Uint8Array(chunk)); } });
    await entry.write(output);
    const file = new Blob(chunks); expect(file.size).toBe(entry.size); files.set(entry.path, file);
  }, () => {});
  return files;
}
async function zip(name = 'nested/text.txt', options = {}) {
  const writer = new ZipWriter(new BlobWriter(), { useWebWorkers: false });
  await writer.add(name, new TextReader('Extracted content'), options); return writer.close();
}
describe('archive decoding and safe paths', () => {
  it('streams ZIP contents while preserving arbitrary file extensions', async () => {
    const files = await unpack(await zip('nested/' + 'x'.repeat(80) + '.customformat'), 'test.zip');
    expect([...files.keys()][0]).toMatch(/\.customformat$/);
    expect(await [...files.values()][0].text()).toBe('Extracted content');
  });
  it.each(['../outside.txt', '/absolute.txt', 'C:/file.txt', 'a/../file', 'a//file', 'a:b/file', 'a\u0000b'])('rejects unsafe output %s', path => {
    expect(() => archiveEntryPath(path)).toThrow('unsafe');
  });
  it('normalizes relative archive paths without allowing traversal', () => {
    expect(archiveEntryPath('./nested\\file.txt')).toBe('nested/file.txt');
    expect(archiveEntryPath('CON/file?.txt')).toBe('_CON/file_.txt');
  });
  it('rejects duplicate sanitized paths and symbolic links', async () => {
    const writer = new ZipWriter(new BlobWriter(), { useWebWorkers: false });
    await writer.add('a?.txt', new TextReader('first')); await writer.add('a*.txt', new TextReader('second'));
    await expect(unpack(await writer.close(), 'duplicate.zip')).rejects.toThrow('duplicate');
    await expect(unpack(await zip('link', { unixMode: 0o120777 }), 'link.zip')).rejects.toThrow('symbolic link');
  });
  it('rejects password protection, empty archives and corrupt files so callers keep the compressed source', async () => {
    await expect(unpack(await zip('secret.txt', { password: 'test' }), 'secret.zip')).rejects.toThrow('password');
    const writer = new ZipWriter(new BlobWriter(), { useWebWorkers: false });
    await expect(unpack(await writer.close(), 'empty.zip')).rejects.toThrow('no regular files');
    await expect(unpack(new Blob(['broken archive']), 'broken.zip')).rejects.toThrow();
  });
  it.each(['sample.7z', 'sample.tar.gz', 'rar4-subblock.rar', 'rar5-stored.rar', 'rar5-solid.rar'])('decodes real %s data using the bundled WASM library', async name => {
    const bytes = new Uint8Array(await readFile(resolve('tests/fixtures/archives', name)));
    const files = await unpack(new Blob([bytes]), name);
    expect(files.size).toBeGreaterThan(0);
    expect([...files.values()].some(file => file.size > 0)).toBe(true);
  });
  it('reports encrypted RAR files as failures', async () => {
    const bytes = new Uint8Array(await readFile(resolve('tests/fixtures/archives/rar4-encrypted.rar')));
    await expect(unpack(new Blob([bytes]), 'locked.rar')).rejects.toThrow();
  });
});
