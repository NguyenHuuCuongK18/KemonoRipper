import type { Command } from '../core/types';
import { command as discordCommand } from './discord';
import { getJob, getJobs, getJobSummaries, saveJob } from '../storage/database';
import { pausePosts, postCommand } from './posts/controller';
import type { PostCommand } from './posts/types';
import { supportedSite } from './registry';
import { clearLocalData, type ClearLocalData } from './localData';
import { cacheList, cacheSettings, removeJobCache, type CacheCommand, type CacheSettingsCommand } from './cacheMaintenance';

export interface PageContext { url: string; expectedPosts: number | null }
export type ServiceCommand = Command | PostCommand | ClearLocalData | CacheSettingsCommand | CacheCommand | { type: 'PAGE_CONTEXT' } | { type: 'SERVICE_JOBS' } | { type: 'DISCORD_DOWNLOAD'; jobId: string; quality: 'thumbnail' | 'full res' | 'best' };
export function isReadOnlyCommand(message: ServiceCommand): boolean {
  return ['PAGE_CONTEXT', 'SERVICE_JOBS', 'DETAIL', 'POST_DETAIL', 'LOCAL_STATUS', 'CACHE_LIST'].includes(message.type);
}
export async function route(message: ServiceCommand, sender: chrome.runtime.MessageSender): Promise<unknown> {
  const folderPage = sender.id === chrome.runtime.id && sender.tab?.url?.split('#')[0] === chrome.runtime.getURL('folder/index.html');
  if (sender.tab?.url && !supportedSite(sender.tab.url) && !folderPage) throw new Error('Archive Ripper works only on Kemono and Pawchive.');
  if (message.type === 'LOCAL_CLEAR') { await clearLocalData(message); return null; }
  if (message.type === 'LOCAL_STATUS' || message.type === 'LOCAL_SETTINGS') return cacheSettings(message);
  if (message.type === 'CACHE_LIST') return cacheList();
  if (message.type === 'CACHE_REMOVE') { await removeJobCache(message.jobId); return null; }
  if (message.type === 'PAGE_CONTEXT') {
    const tab = sender.tab?.id !== undefined ? await chrome.tabs.get(sender.tab.id) : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
    if (!tab?.id || !supportedSite(tab.url || '')) return null;
    try {
      const context = await chrome.tabs.sendMessage(tab.id, { type: 'PAGE_CONTEXT' }) as PageContext;
      if (context?.url === tab.url) return context;
    } catch { /* A newly installed extension can use the tab URL before its content script is reloaded. */ }
    return { url: tab.url, expectedPosts: null };
  }
  if (message.type === 'SERVICE_JOBS') {
    return (await getJobSummaries()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  if (message.type.startsWith('POST_')) {
    if (message.type === 'POST_DOWNLOAD' || message.type === 'POST_SYNC_IMPORT' || message.type === 'POST_SYNC_CONNECT' || (message.type === 'POST_ACTION' && ['resume', 'retry', 'rescan'].includes(message.action))) {
      await pausePosts();
      for (const job of await getJobs(['scanning', 'downloading'])) { job.resumeStatus = job.status as 'scanning' | 'downloading'; job.status = 'paused'; await saveJob(job); }
    }
    return postCommand(message as PostCommand);
  }
  if (message.type === 'DISCORD_DOWNLOAD') {
    const job = await getJob(message.jobId); if (!job || !['thumbnail', 'full res', 'best'].includes(message.quality)) throw new Error('Invalid Discord download.');
    if (!['indexed', 'finished'].includes(job.status)) throw new Error('Finish scanning before downloading.');
    job.mode = message.quality === 'full res' ? 'original' : message.quality;
    job.tryOriginal = message.quality === 'best'; await saveJob(job); await pausePosts();
    return discordCommand({ type: 'ACTION', jobId: job.id, action: 'download' }, sender);
  }
  if (message.type === 'START' || (message.type === 'ACTION' && ['download', 'resume', 'retry'].includes(message.action))) await pausePosts();
  return discordCommand(message as Command, sender);
}
