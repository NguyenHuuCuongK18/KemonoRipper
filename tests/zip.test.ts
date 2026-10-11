import { it, expect } from 'vitest';
import { BlobReader, Uint8ArrayWriter, ZipReader } from '@zip.js/zip.js';
import { writeZip, type ZipEntry } from '../src/storage/zipCache';
async function create(entries: ZipEntry[]): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array[] = [];
  const output = new WritableStream<Uint8Array>({ write(chunk) { chunks.push(chunk.slice()); } });
  async function* input() { yield* entries; }
  await writeZip(output, input());
  const size = chunks.reduce((n, b) => n + b.length, 0), result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}
it('writes a readable ZIP64 archive with safe nested names, exact bytes and valid checksums', async () => {
  const image = new Uint8Array([255, 216, 255, 0, 1, 2, 255, 217]);
  const bytes = await create([{ path: 'ArchiveRoot/server/channel/image.jpg', blob: new Blob([image]) }, { path: 'ArchiveRoot/server/manifest.json', blob: new Blob(['{"ok":true}']) }]);
  const reader = new ZipReader(new BlobReader(new Blob([bytes])), { useWebWorkers: false }); const entries = await reader.getEntries();
  if (entries[0].directory || entries[1].directory) throw new Error('Expected file entries');
  expect(entries.map(e => e.filename)).toEqual(['ArchiveRoot/server/channel/image.jpg', 'ArchiveRoot/server/manifest.json']);
  expect(await entries[0].getData!(new Uint8ArrayWriter(), { checkSignature: true })).toEqual(image);
  expect(entries[0].compressionMethod).toBe(0); expect(entries[0].zip64).toBe(true);
  expect(new TextDecoder().decode(await entries[1].getData!(new Uint8ArrayWriter(), { checkSignature: true }))).toBe('{"ok":true}');
  await reader.close();
});
it('rejects traversal and duplicate ZIP paths instead of exporting unsafe or ambiguous entries', async () => {
  await expect(create([{ path: 'ArchiveRoot/../outside.jpg', blob: new Blob(['bad']) }])).rejects.toThrow('Unsafe');
  await expect(create([{ path: 'ArchiveRoot/same.jpg', blob: new Blob(['a']) }, { path: 'ArchiveRoot/same.jpg', blob: new Blob(['b']) }])).rejects.toThrow();
});
it('allows cancellation before a partially built archive can be reported as complete', async () => {
  const abort = new AbortController(); abort.abort();
  async function* input() { yield { path: 'ArchiveRoot/image.jpg', blob: new Blob(['a']) }; }
  await expect(writeZip(new WritableStream(), input(), abort.signal)).rejects.toThrow();
});
