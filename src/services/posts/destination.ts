import type { ArchiveDirectory } from '../../storage/destination';
import { creatorFolder } from './media';
import { parseSync } from './sync';
import type { PostJob } from './types';

type Creator = Pick<PostJob, 'source' | 'creatorName'>;
async function isCreatorDirectory(directory: FileSystemDirectoryHandle, job: Creator): Promise<boolean> {
  // Existing creator folders keep their layout, including older extracted archives.
  for (const name of ['sync.json', 'manifest.json']) try {
    const file = await (await directory.getFileHandle(name)).getFile();
    if (file.size > 32 * 1024 * 1024) throw new Error('The sync JSON exceeds the 32 MiB limit.');
    parseSync(JSON.parse(await file.text()), job.source);
    return true;
  } catch (error) { if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error; }
  for (const quality of ['thumbnail', 'full res']) try {
    await directory.getDirectoryHandle(quality); return true;
  } catch (error) { if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error; }
  return directory.name === creatorFolder(job);
}
export async function creatorDirectory(selected: ArchiveDirectory, job: Creator): Promise<ArchiveDirectory> {
  if (await isCreatorDirectory(selected, job)) return selected;
  const directory = await selected.getDirectoryHandle(creatorFolder(job), { create: true });
  await isCreatorDirectory(directory, job);
  return directory as ArchiveDirectory;
}
