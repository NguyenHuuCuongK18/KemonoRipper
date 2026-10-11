import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { getJobs, getPostJobs, getCacheSettings, getJobSummaries } from '../src/storage/database';
import { job } from './helpers';

it('upgrades the v2 database with indexes and compact summaries without losing existing history', async () => {
  const existing = job(); existing.status = 'downloading';
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('kemono-archive', 2);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('jobs', { keyPath: 'id' });
      request.result.createObjectStore('media', { keyPath: ['jobId', 'id'] }).createIndex('jobId', 'jobId');
      request.result.createObjectStore('postJobs', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('jobs', 'readwrite'); tx.objectStore('jobs').put(existing);
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
  });
  db.close();
  expect(await getJobs(['downloading'])).toEqual([existing]);
  expect(await getJobs(['finished'])).toEqual([]); expect(await getPostJobs(['downloading'])).toEqual([]);
  expect((await getCacheSettings()).retentionMinutes).toBe(5);
  expect(await getJobSummaries()).toEqual([expect.objectContaining({ id: existing.id, service: 'discord', status: 'downloading', title: existing.serverName })]);
  expect((await getJobSummaries())[0]).not.toHaveProperty('channels');
});
