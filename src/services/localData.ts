import { getJobs, getMedia, getPostJobs, deleteLocalRecords, saveJob, savePostJob } from '../storage/database';
import { directoryKey, forgetDirectories } from '../storage/destination';
import { offscreen } from '../background/offscreenBridge';

export type ClearLocalData = { type: 'LOCAL_CLEAR'; scope: 'job'; jobId: string } | { type: 'LOCAL_CLEAR'; scope: 'all' };

export async function clearLocalData(message: ClearLocalData): Promise<void> {
  if (message.scope !== 'all' && message.scope !== 'job') throw new Error('Choose which local data to clear.');
  const jobId = message.scope === 'job' ? message.jobId : undefined;
  if (message.scope === 'job' && (typeof jobId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(jobId))) throw new Error('Invalid job to remove.');
  const [discord, posts] = await Promise.all([getJobs(), getPostJobs()]);
  const selectedDiscord = discord.filter(job => jobId === undefined || job.id === jobId);
  const selectedPosts = posts.filter(job => jobId === undefined || job.id === jobId);
  if (jobId !== undefined && !selectedDiscord.length && !selectedPosts.length) throw new Error('This job was already removed.');
  const blobs = new Set<string>(), downloads = new Set<number>();
  for (const job of [...selectedDiscord, ...selectedPosts]) {
    if (job.archive?.blobUrl) blobs.add(job.archive.blobUrl);
    if (job.archive?.state === 'saving' && job.archive.downloadId !== null) downloads.add(job.archive.downloadId);
  }
  for (const job of selectedDiscord) {
    // Persist the stopped state before cleanup so a failed purge cannot restart work.
    job.status = 'cancelled'; await saveJob(job);
    for (const record of await getMedia(job.id)) {
      if (record.blobUrl) blobs.add(record.blobUrl);
      if (record.status === 'transferring' && record.downloadId !== null) downloads.add(record.downloadId);
    }
    for (const download of job.manifestDownloads) {
      blobs.add(download.blobUrl);
      if (download.state === 'in_progress') downloads.add(download.id);
    }
  }
  for (const job of selectedPosts) { job.status = 'cancelled'; job.autoDownload = undefined; await savePostJob(job); }
  for (const id of downloads) await chrome.downloads.cancel(id).catch(() => {});
  await offscreen('local-purge', { ...(jobId !== undefined ? { jobId } : {}), blobUrls: [...blobs] });
  if (jobId === undefined) await forgetDirectories();
  else {
    const keys = new Set([jobId,
      ...selectedDiscord.filter(job => job.destination?.kind === 'folder').map(directoryKey),
      ...selectedPosts.flatMap(job => job.destination?.kind === 'folder' && job.destination.directoryId ? [job.destination.directoryId] : []),
    ]);
    // A selected directory can be shared by several jobs; retain live connections.
    for (const job of discord) if (job.id !== jobId && job.destination?.kind === 'folder') keys.delete(directoryKey(job));
    for (const job of posts) if (job.id !== jobId && job.destination?.kind === 'folder') keys.delete(job.destination.directoryId);
    await forgetDirectories([...keys]);
  }
  await deleteLocalRecords(jobId);
}
