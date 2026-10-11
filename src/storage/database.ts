import type { Job, MediaRecord } from '../core/types';
import type { PostJob } from '../services/posts/types';
export interface JobSummary {
  id: string; service: 'discord' | 'posts'; title: string; sourceUrl: string;
  status: Job['status'] | PostJob['status']; createdAt: string; updatedAt: string;
  archiveState?: NonNullable<Job['archive']>['state']; cacheCleared: boolean;
  destinationKind?: 'folder' | 'zip' | 'browser';
}
function jobSummary(job: Job | PostJob): JobSummary {
  const base = { id: job.id, status: job.status, createdAt: job.createdAt, updatedAt: job.updatedAt,
    archiveState: job.archive?.state, cacheCleared: !!job.archive?.cacheCleared, destinationKind: job.destination?.kind };
  return job.service === 'posts'
    ? { ...base, service: 'posts', sourceUrl: job.sourceUrl, title: job.source.postId ? job.posts[0]?.title || job.creatorName : job.creatorName }
    : { ...base, service: 'discord', sourceUrl: job.sourceUrl || `https://kemono.cr/discord/server/${job.serverId}${job.channels.length === 1 ? '/' + job.channels[0].channelId : ''}`, title: job.serverName || job.serverId };
}
let connection: Promise<IDBDatabase> | undefined;
function database(): Promise<IDBDatabase> {
  if (!connection) connection = new Promise((resolve, reject) => {
    const request = indexedDB.open('kemono-archive', 4);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('jobs')) {
        request.result.createObjectStore('jobs', { keyPath: 'id' });
        const media = request.result.createObjectStore('media', { keyPath: ['jobId', 'id'] });
        media.createIndex('jobId', 'jobId');
      }
      if (!request.result.objectStoreNames.contains('postJobs')) request.result.createObjectStore('postJobs', { keyPath: 'id' });
      for (const name of ['jobs', 'postJobs']) {
        const store = request.transaction!.objectStore(name);
        if (!store.indexNames.contains('status')) store.createIndex('status', 'status');
        if (!store.indexNames.contains('archiveState')) store.createIndex('archiveState', 'archive.state');
        if (!store.indexNames.contains('archiveDownloadId')) store.createIndex('archiveDownloadId', 'archive.downloadId');
      }
      const jobs = request.transaction!.objectStore('jobs');
      if (!jobs.indexNames.contains('manifestState')) jobs.createIndex('manifestState', 'manifestState');
      const media = request.transaction!.objectStore('media');
      if (!media.indexNames.contains('downloadId')) media.createIndex('downloadId', 'downloadId');
      if (!media.indexNames.contains('jobStatus')) media.createIndex('jobStatus', ['jobId', 'status']);
      if (!request.result.objectStoreNames.contains('jobSummaries')) {
        const summaries = request.result.createObjectStore('jobSummaries', { keyPath: 'id' });
        summaries.createIndex('status', 'status');
        for (const name of ['jobs', 'postJobs']) {
          const cursor = request.transaction!.objectStore(name).openCursor();
          cursor.onsuccess = () => { const entry = cursor.result; if (entry) { summaries.put(jobSummary(entry.value)); entry.continue(); } };
        }
      }
      if (!request.result.objectStoreNames.contains('settings')) request.result.createObjectStore('settings');
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); connection = undefined; };
      resolve(request.result);
    };
    request.onerror = () => { connection = undefined; reject(request.error); };
  });
  return connection;
}
function result<T>(request: IDBRequest<T>): Promise<T> { return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
function committed(tx: IDBTransaction): Promise<void> { return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error || new Error('Database transaction aborted')); }); }
async function jobsByIndex<T>(store: string, index?: string, keys: string[] = []): Promise<T[]> {
  const source = (await database()).transaction(store).objectStore(store);
  if (!index) return result(source.getAll());
  return (await Promise.all(keys.map(key => result<T[]>(source.index(index).getAll(key))))).flat();
}
export async function getJobs(statuses?: Job['status'][]): Promise<Job[]> { return jobsByIndex('jobs', statuses ? 'status' : undefined, statuses); }
export async function getJobSummaries(): Promise<JobSummary[]> { return jobsByIndex('jobSummaries'); }
export async function hasActiveJobs(): Promise<boolean> {
  const index = (await database()).transaction('jobSummaries').objectStore('jobSummaries').index('status');
  const counts = await Promise.all(['scanning', 'downloading'].map(status => result(index.count(status))));
  return counts.some(count => count > 0);
}
export async function getSavingJobs(): Promise<Job[]> { return jobsByIndex('jobs', 'archiveState', ['saving']); }
export async function getManifestJobs(): Promise<Job[]> { return jobsByIndex('jobs', 'manifestState', ['saving']); }
export async function getArchiveJobsForDownload(id: number): Promise<Job[]> { return result((await database()).transaction('jobs').objectStore('jobs').index('archiveDownloadId').getAll(id)); }
export async function getPostJobsForDownload(id: number): Promise<PostJob[]> { return result((await database()).transaction('postJobs').objectStore('postJobs').index('archiveDownloadId').getAll(id)); }
export async function getMediaForDownload(id: number): Promise<MediaRecord[]> { return result((await database()).transaction('media').objectStore('media').index('downloadId').getAll(id)); }
export async function getJob(id: string): Promise<Job | undefined> { return result((await database()).transaction('jobs').objectStore('jobs').get(id)); }
export async function getMedia(jobId: string, statuses?: MediaRecord['status'][]): Promise<MediaRecord[]> {
  const store = (await database()).transaction('media').objectStore('media');
  if (!statuses) return result(store.index('jobId').getAll(jobId));
  return (await Promise.all(statuses.map(status => result<MediaRecord[]>(store.index('jobStatus').getAll([jobId, status]))))).flat();
}
export async function saveJob(job: Job): Promise<void> {
  const tx = (await database()).transaction(['jobs', 'jobSummaries'], 'readwrite'); const done = committed(tx);
  tx.objectStore('jobs').put(job); tx.objectStore('jobSummaries').put(jobSummary(job)); await done;
}
export async function saveJobAndMedia(job: Job, records: MediaRecord[]): Promise<void> {
  const tx = (await database()).transaction(['jobs', 'jobSummaries', 'media'], 'readwrite'); const done = committed(tx);
  tx.objectStore('jobs').put(job); tx.objectStore('jobSummaries').put(jobSummary(job));
  for (const record of records) tx.objectStore('media').put(record);
  await done;
}
export async function saveMedia(record: MediaRecord): Promise<void> { const tx = (await database()).transaction('media', 'readwrite'); const done = committed(tx); tx.objectStore('media').put(record); await done; }
export async function saveMediaRecords(records: MediaRecord[]): Promise<void> {
  if (!records.length) return;
  const tx = (await database()).transaction('media', 'readwrite'); const done = committed(tx);
  for (const record of records) tx.objectStore('media').put(record);
  await done;
}
export async function getPostJobs(statuses?: PostJob['status'][]): Promise<PostJob[]> { return jobsByIndex('postJobs', statuses ? 'status' : undefined, statuses); }
export async function getSavingPostJobs(): Promise<PostJob[]> { return jobsByIndex('postJobs', 'archiveState', ['saving']); }
export interface CacheMaintenanceSettings { retentionMinutes: number; lastCheckAt: number; removedCaches: number; clearAfterDownload?: boolean }
export async function getCacheSettings(): Promise<CacheMaintenanceSettings> {
  const saved = await result<CacheMaintenanceSettings | undefined>((await database()).transaction('settings').objectStore('settings').get('cache-maintenance'));
  return { retentionMinutes: 5, lastCheckAt: 0, removedCaches: 0, clearAfterDownload: false, ...saved };
}
export async function saveCacheSettings(settings: CacheMaintenanceSettings): Promise<void> {
  const tx = (await database()).transaction('settings', 'readwrite'); const done = committed(tx);
  tx.objectStore('settings').put(settings, 'cache-maintenance'); await done;
}
export async function getPostJob(id: string): Promise<PostJob | undefined> { return result((await database()).transaction('postJobs').objectStore('postJobs').get(id)); }
export async function savePostJob(job: PostJob): Promise<void> {
  job.updatedAt = new Date().toISOString();
  const tx = (await database()).transaction(['postJobs', 'jobSummaries'], 'readwrite'); const done = committed(tx);
  tx.objectStore('postJobs').put(job); tx.objectStore('jobSummaries').put(jobSummary(job)); await done;
}
export async function deleteLocalRecords(jobId?: string): Promise<void> {
  const stores = jobId === undefined ? ['jobs', 'media', 'postJobs', 'jobSummaries', 'settings'] : ['jobs', 'media', 'postJobs', 'jobSummaries'];
  const tx = (await database()).transaction(stores, 'readwrite');
  const done = committed(tx);
  if (jobId === undefined) {
    for (const name of stores) tx.objectStore(name).clear();
  } else {
    tx.objectStore('jobs').delete(jobId); tx.objectStore('postJobs').delete(jobId); tx.objectStore('jobSummaries').delete(jobId);
    const store = tx.objectStore('media'), request = store.index('jobId').openKeyCursor(IDBKeyRange.only(jobId));
    request.onsuccess = () => { const cursor = request.result; if (cursor) { store.delete(cursor.primaryKey); cursor.continue(); } };
  }
  await done;
}
// Page records and cursor commit atomically. A crash cannot advance past unpersisted media.
export async function commitPage(job: Job, records: MediaRecord[]): Promise<void> {
  const tx = (await database()).transaction(['jobs', 'media', 'jobSummaries'], 'readwrite'); const done = committed(tx);
  tx.objectStore('jobs').put(job);
  tx.objectStore('jobSummaries').put(jobSummary(job));
  const store = tx.objectStore('media'); const request = store.index('jobId').openKeyCursor(IDBKeyRange.only(job.id));
  request.onsuccess = () => { const cursor = request.result; if (cursor) { store.delete(cursor.primaryKey); cursor.continue(); } else for (const record of records) store.put(record); };
  await done;
}
