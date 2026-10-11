// Handles stay in IndexedDB: extension runtime messages cannot serialize them.
import type { Job } from '../core/types';
export function directoryKey(job: Job): string { return job.destination?.kind === 'folder' ? job.destination.directoryId || job.id : job.id; }
export interface ArchiveDirectory extends FileSystemDirectoryHandle {
  queryPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
}
export interface DirectoryPickerWindow extends Window {
  showDirectoryPicker?: (options: { id: string; mode: 'readwrite'; startIn?: FileSystemHandle }) => Promise<ArchiveDirectory>;
  showOpenFilePicker?: (options: { id: string; multiple: false; excludeAcceptAllOption: boolean; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<FileSystemFileHandle[]>;
}
let connection: Promise<IDBDatabase> | undefined;
async function database(): Promise<IDBDatabase> {
  return connection ||= new Promise((resolve, reject) => {
    const request = indexedDB.open('kemono-archive-destinations', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('folders');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { connection = undefined; reject(request.error); };
  });
}
export async function getDirectory(jobId: string): Promise<ArchiveDirectory | undefined> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const request = db.transaction('folders').objectStore('folders').get(jobId);
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
export async function saveDirectory(jobId: string, handle: ArchiveDirectory): Promise<void> {
  const tx = (await database()).transaction('folders', 'readwrite');
  const done = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error); });
  tx.objectStore('folders').put(handle, jobId); await done;
}
export async function forgetDirectories(keys?: string[]): Promise<void> {
  const tx = (await database()).transaction('folders', 'readwrite');
  const done = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error); });
  const store = tx.objectStore('folders');
  if (keys === undefined) store.clear();
  else for (const key of keys) store.delete(key);
  await done;
}
export class FolderPermissionError extends Error {
  constructor() { super('Folder access is required. Click Restore folder access, then Allow folder access. Keep that tab open while saving.'); }
}
export async function requireDirectory(jobId: string): Promise<ArchiveDirectory> {
  const handle = await getDirectory(jobId);
  try { if (!handle || await handle.queryPermission({ mode: 'readwrite' }) !== 'granted') throw new FolderPermissionError(); }
  catch { throw new FolderPermissionError(); }
  return handle;
}
