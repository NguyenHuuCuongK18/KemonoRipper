import { BlobReader, ZipReader } from '@zip.js/zip.js';
import { ArchiveReader, libarchiveWasm } from 'libarchive-wasm';
import { archiveEntryPath } from './archivePaths';

export interface ArchiveOutput { path: string; size: number; write: (output: WritableStream<Uint8Array>) => Promise<void> }
export async function extractArchive(blob: Blob, name: string, wasmUrl: string, save: (entry: ArchiveOutput) => Promise<void>, progress: () => void): Promise<void> {
  let count = 0, total = 0;
  const paths = new Set<string>();
  const check = (raw: string, size: number) => {
    const path = archiveEntryPath(raw);
    if (!Number.isSafeInteger(size) || size < 0 || ++count > 10000 || (total += size) > 8 * 1024 ** 3) throw new Error('Archive extraction exceeds supported file count or size.');
    if (paths.has(path.toLowerCase())) throw new Error('Archive contains duplicate file paths.'); paths.add(path.toLowerCase());
    return path;
  };
  if (/\.zipx?$/i.test(name)) {
    const reader = new ZipReader(new BlobReader(blob), { useWebWorkers: false });
    try {
      for await (const entry of reader.getEntriesGenerator()) {
        if (entry.directory) continue;
        if (entry.encrypted) throw new Error('Archive is password protected. The original was kept.');
        if (((entry.unixMode || 0) & 0o170000) === 0o120000) throw new Error('Archive contains a symbolic link.');
        const path = check(entry.filename, entry.uncompressedSize);
        await save({ path, size: entry.uncompressedSize, write: async output => { await entry.getData!(output, { checkSignature: true, preventClose: true, onprogress: progress }); } });
        progress();
      }
    } finally { await reader.close(); }
  } else {
    if (blob.size > 512 * 1024 ** 2) throw new Error('This archive exceeds the 512 MiB in-browser decoder input limit. The original was kept.');
    const lib = await libarchiveWasm({ locateFile: () => wasmUrl }), reader = new ArchiveReader(lib, new Int8Array(await blob.arrayBuffer()));
    try {
      for (const entry of reader.entries()) {
        if (entry.getFiletype() === 'Directory') continue;
        if (entry.getFiletype() !== 'File' || entry.getHardlinkTarget() || entry.getSymlinkTarget()) throw new Error('Archive contains a link or unsupported special file.');
        if (entry.isEncrypted()) throw new Error('Archive is password protected. The original was kept.');
        const size = entry.getSize(), path = check(entry.getPathname(), size);
        await save({ path, size, write: async output => {
          const writer = output.getWriter(); let received = 0;
          try {
            for (;;) {
              const chunk = reader.readData(1024 * 1024);
              if (!chunk.length) break;
              received += chunk.length;
              if (received > size) throw new Error('Archive entry exceeds its declared size.');
              await writer.write(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)); progress();
            }
            if (received !== size) throw new Error('Archive entry is truncated.');
          } finally { writer.releaseLock(); }
        } });
        progress();
      }
      const error = lib.error_string(reader.archive); if (error) throw new Error('Archive decoder reported incomplete or unsupported data.');
    } finally { reader.free(); }
  }
  if (!count) throw new Error('Archive contains no regular files. The original was kept.');
}
