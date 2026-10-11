import type { ArchiveDirectory } from '../../storage/destination';
import { parseSync } from './sync';
import type { PostScope, PostSyncIndex } from './types';

export async function readSyncFile(handle: FileSystemFileHandle, source: PostScope): Promise<PostSyncIndex> {
  if (!['sync.json', 'manifest.json'].includes(handle.name)) throw new Error('Choose the archive’s sync.json or manifest.json file.');
  const file = await handle.getFile();
  if (file.size > 32 * 1024 * 1024) throw new Error('The sync JSON exceeds the 32 MiB limit.');
  let json: unknown;
  try { json = JSON.parse(await file.text()); }
  catch { throw new Error('This file is not valid JSON. Choose the archive’s sync.json or manifest.json.'); }
  return parseSync(json, source);
}

export async function assertSyncDirectory(directory: FileSystemDirectoryHandle, file: FileSystemFileHandle): Promise<void> {
  // Match the selected file's identity, not a copied JSON with identical contents.
  const path = await directory.resolve(file);
  if (!path || path.length !== 1 || path[0] !== file.name) throw new Error(`Choose the folder directly containing the selected ${file.name}.`);
}

export async function canUseSyncDirectory(directory: ArchiveDirectory, file: FileSystemFileHandle): Promise<boolean> {
  try {
    if (await directory.queryPermission({ mode: 'readwrite' }) !== 'granted') return false;
    await assertSyncDirectory(directory, file); return true;
  } catch { return false; }
}
