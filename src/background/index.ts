import { downloadChanged, recover, tick } from '../services/discord';
import { isReadOnlyCommand, route, type ServiceCommand } from '../services/router';
import { reconcilePostDownloads, tickPosts } from '../services/posts/controller';
import { supportedSite } from '../services/registry';
import { maintainZipCaches } from '../services/cacheMaintenance';
import { hasActiveJobs } from '../storage/database';
import { SerialQueue, WorkerPump } from './scheduler';
const queue = new SerialQueue();
const pump = new WorkerPump(() => queue.run(async () => {
  const postsActive = await tickPosts();
  const delay = postsActive ? 750 : await tick();
  return await hasActiveJobs() ? delay || 1200 : undefined;
}));
chrome.runtime.onMessage.addListener((message: ServiceCommand & { target?: string }, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message.target === 'offscreen') return;
  const readOnly = isReadOnlyCommand(message);
  const result = readOnly ? route(message, sender) : queue.run(() => route(message, sender));
  result.then(data => respond({ ok: true, data }), error => respond({ ok: false, error: error instanceof Error ? error.message : 'Archive operation failed' })).finally(() => { if (!readOnly) pump.wake(); });
  return true;
});
chrome.downloads.onChanged.addListener(delta => {
  if (!delta.state || !['complete', 'interrupted'].includes(delta.state.current || '')) return;
  void queue.run(async () => { await downloadChanged(delta); await reconcilePostDownloads(false, delta.id); }).catch(() => {}).finally(() => pump.wake());
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'archive-tick') pump.wake();
  if (alarm.name === 'archive-maintenance') void queue.run(() => maintainZipCaches()).catch(() => {});
});
async function recoverServices(): Promise<void> { await recover(); await reconcilePostDownloads(true); await maintainZipCaches(); }
chrome.runtime.onStartup.addListener(() => { void queue.run(recoverServices).catch(() => {}).finally(() => pump.wake()); });
chrome.runtime.onInstalled.addListener(() => { void chrome.alarms.create('archive-tick', { periodInMinutes: 0.5 }); });
void chrome.alarms.create('archive-tick', { periodInMinutes: 0.5 });
void chrome.alarms.create('archive-maintenance', { periodInMinutes: 1 });
void queue.run(recoverServices).catch(() => {}).finally(() => pump.wake());
chrome.action.onClicked.addListener(tab => {
  if (!tab.id || !supportedSite(tab.url || '')) return;
  void (async () => {
    try { await chrome.tabs.sendMessage(tab.id!, { type: 'TOGGLE_OVERLAY' }); }
    catch { await chrome.scripting.executeScript({ target: { tabId: tab.id! }, files: ['content.js'] }); await chrome.tabs.sendMessage(tab.id!, { type: 'TOGGLE_OVERLAY' }); }
  })().catch(() => { void chrome.action.setTitle({ tabId: tab.id, title: 'Refresh this page, then open Archive Ripper.' }); });
});
async function updateAction(tab: chrome.tabs.Tab): Promise<void> { if (tab.id !== undefined) await (supportedSite(tab.url || '') ? chrome.action.enable(tab.id) : chrome.action.disable(tab.id)); }
chrome.tabs.onUpdated.addListener((_id, _change, tab) => { void updateAction(tab); });
void chrome.action.disable().then(async () => { for (const tab of await chrome.tabs.query({ url: ['https://kemono.cr/*', 'https://pawchive.pw/*'] })) await updateAction(tab); });
