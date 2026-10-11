import { FolderPermissionError, requireDirectory } from './destination';
export function relativePathParts(path: string): string[] {
  const parts = path.split('/');
  if (!path || parts.some(p => !p || p === '.' || p === '..' || /[\\:\x00-\x1f<>"|?*]/.test(p))) throw new Error('Unsafe archive path');
  return parts;
}
export function pathParts(path: string): string[] {
  const parts = relativePathParts(path);
  if (parts[0] !== 'ArchiveRoot' || parts.length < 2) throw new Error('Unsafe archive path');
  return parts;
}
async function parent(jobId: string, path: string, create: boolean, relative = false): Promise<{ directory: FileSystemDirectoryHandle; name: string }> {
  const parts = relative ? relativePathParts(path) : pathParts(path); let directory: FileSystemDirectoryHandle = await requireDirectory(jobId);
  for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part, { create });
  return { directory, name: parts.at(-1)! };
}
export async function sha256(blob: Blob): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map(b => b.toString(16).padStart(2, '0')).join('');
}
export async function fileMatches(jobId: string, path: string, hash: string, bytes: number): Promise<boolean> {
  try {
    const { directory, name } = await parent(jobId, path, false);
    const file = await (await directory.getFileHandle(name)).getFile();
    return file.size === bytes && await sha256(file) === hash;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') return false;
    if (error instanceof DOMException && ['NotAllowedError', 'SecurityError'].includes(error.name)) throw new FolderPermissionError();
    throw error;
  }
}
// Serialize reservations so two writes cannot choose the same unused name.
let writes: Promise<unknown> = Promise.resolve();
export function writeFile(jobId: string, path: string, blob: Blob, overwrite = false): Promise<string> {
  return writeArchiveFile(jobId, path, blob, overwrite, false);
}
export function writeRelativeFile(directoryId: string, path: string, blob: Blob, overwrite = false): Promise<string> {
  return writeArchiveFile(directoryId, path, blob, overwrite, true);
}
function writeArchiveFile(jobId: string, path: string, blob: Blob, overwrite: boolean, relative: boolean): Promise<string> {
  const next = writes.catch(() => {}).then(async () => {
    try {
      const { directory, name } = await parent(jobId, path, true, relative);
      const dot = name.lastIndexOf('.'); const stem = dot < 0 ? name : name.slice(0, dot); const extension = dot < 0 ? '' : name.slice(dot);
      let chosen = name;
      if (!overwrite) for (let suffix = 0; ; suffix++) {
        chosen = suffix ? `${stem} (${suffix})${extension}` : name;
        try {
          const existing = await (await directory.getFileHandle(chosen)).getFile();
          // A completed write before a worker restart can be reused safely.
          if (existing.size === blob.size && await sha256(existing) === await sha256(blob)) return path.slice(0, -name.length) + chosen;
        } catch (error) { if (error instanceof DOMException && error.name === 'NotFoundError') break; throw error; }
      }
      const file = await directory.getFileHandle(chosen, { create: true });
      const stream = await file.createWritable();
      try { await stream.write(blob); await stream.close(); } catch (error) { await stream.abort().catch(() => {}); throw error; }
      return path.slice(0, -name.length) + chosen;
    } catch (error) {
      if (error instanceof DOMException && ['NotAllowedError', 'SecurityError'].includes(error.name)) throw new FolderPermissionError();
      throw error;
    }
  });
  writes = next; return next;
}
