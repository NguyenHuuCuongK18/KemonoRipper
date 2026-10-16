import { chromium } from 'playwright';
import { ZipReader, Uint8ArrayReader, Uint8ArrayWriter } from '@zip.js/zip.js';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve('.'), output = resolve(`.service-check-tolerance-${Date.now()}`);
assert(output.startsWith(root + sep) && output.includes('.service-check-tolerance-'));
await mkdir(output);
const profileUrl = 'https://pawchive.pw/patreon/user/19875180';
const base = { user: '19875180', service: 'patreon', title: 'Available text', content: 'Saved list text', attachments: [], detail_fetched: true };
const posts = ['910', '911', '912', '913', '914'].map(id => ({ ...base, id }));
posts[0].file = { name: 'missing.psd', path: '/aa/bb/' + 'a'.repeat(64) + '.psd' };
let context, diagnostic = async () => ({});
async function waitFor(work) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) { const value = await work(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 150)); }
  throw new Error('Tolerance acceptance timed out: ' + JSON.stringify(await diagnostic()));
}
try {
  context = await chromium.launchPersistentContext(resolve(output, 'profile'), { channel: 'chromium', headless: true, acceptDownloads: true,
    args: [`--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const page = await context.newPage(), cdp = await context.newCDPSession(page), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: output });
  await context.route('https://**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Tolerance fixture</title>' }));
  await worker.evaluate(posts => {
    const nativeFetch = fetch; globalThis.__recover = false; globalThis.__repeat = false; globalThis.__apiRequests = [];
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input)); if (!url.pathname.startsWith('/api/v1/')) return nativeFetch(input, init);
      globalThis.__apiRequests.push(url.href);
      if (url.pathname.endsWith('/profile')) return new Response(JSON.stringify({ id: posts[0].user, name: 'Tolerance creator' }));
      if (url.pathname.includes('/post/')) {
        if (!globalThis.__recover) return new Response('', { status: 404 });
        return new Response(JSON.stringify(posts.find(post => post.id === url.pathname.split('/').at(-1))));
      }
      const offset = Number(url.searchParams.get('o'));
      if (globalThis.__repeat) return new Response(JSON.stringify(offset < 100 ? [posts[0]] : []));
      if (offset === 0) return new Response(JSON.stringify([posts[0], { ...posts[1], detail_fetched: false }, { ...posts[3], user: '999' }]));
      if (offset === 50) return globalThis.__recover ? new Response(JSON.stringify([posts[4]])) : new Response('', { status: 503 });
      return new Response(JSON.stringify(offset === 100 ? [posts[2]] : []));
    };
    const download = chrome.downloads.download.bind(chrome.downloads);
    chrome.downloads.download = options => download({ ...options, saveAs: false });
  }, posts);
  await page.goto(profileUrl);
  const tabId = await worker.evaluate(async url => (await chrome.tabs.query({ url }))[0].id, profileUrl);
  await worker.evaluate(tabId => chrome.tabs.sendMessage(tabId, { type: 'TOGGLE_OVERLAY' }), tabId);
  const frame = await waitFor(() => page.frames().find(frame => frame.url().includes('/overlay/index.html')));
  const send = message => frame.evaluate(async message => { const reply = await chrome.runtime.sendMessage(message); if (!reply.ok) throw new Error(reply.error); return reply.data; }, message);
  await waitFor(async () => (await send({ type: 'SERVICE_JOBS' })).length);
  const jobId = (await send({ type: 'SERVICE_JOBS' }))[0].id;
  diagnostic = async () => ({ view: await send({ type: 'POST_DETAIL', jobId }), notice: await frame.locator('#notice').textContent() });
  await waitFor(async () => (await send({ type: 'POST_DETAIL', jobId })).job.scan.complete);
  let view = await send({ type: 'POST_DETAIL', jobId });
  assert.equal(view.totals.posts, 3); assert.equal(view.totals.discoveryFailures, 3);
  await waitFor(async () => (await frame.locator('#summary').textContent()).includes('3 discovery errors'));
  assert.equal(await frame.locator('#retry').isVisible(), true);
  await worker.evaluate(async () => {
    if (!(await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] })).length)
      await chrome.offscreen.createDocument({ url: 'offscreen/index.html', reasons: [chrome.offscreen.Reason.BLOBS], justification: 'Check error-tolerant saving.' });
  });
  const offscreenUrl = new URL('/offscreen/index.html', worker.url()).href;
  async function targetEvaluate(expression) {
    const { targetInfos } = await cdp.send('Target.getTargets'), target = targetInfos.find(item => item.url === offscreenUrl); assert(target);
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
    try {
      const result = new Promise((resolve, reject) => {
        const listener = event => { if (event.sessionId !== sessionId) return; const message = JSON.parse(event.message); if (message.id !== 1) return;
          cdp.off('Target.receivedMessageFromTarget', listener); if (message.error || message.result?.exceptionDetails) reject(new Error(JSON.stringify(message))); else resolve(message.result.result?.value); };
        cdp.on('Target.receivedMessageFromTarget', listener);
      });
      await cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }) });
      return await result;
    } finally { await cdp.send('Target.detachFromTarget', { sessionId }); }
  }
  await targetEvaluate(`(()=>{const nativeFetch=fetch;globalThis.fetch=async(input,init)=>String(input).startsWith('https:')?new Response('',{status:404}):nativeFetch(input,init);return true;})()`);
  const selection = { quality: 'full res', images: true, files: true, text: true };
  await send({ type: 'POST_DOWNLOAD', jobId, selection, destination: 'zip' });
  await waitFor(async () => (await send({ type: 'POST_DETAIL', jobId })).job.archive?.state === 'saved');
  const [download] = await worker.evaluate(() => chrome.downloads.search({}));
  const zip = new ZipReader(new Uint8ArrayReader(new Uint8Array(await readFile(download.filename))), { useWebWorkers: false });
  const entries = await zip.getEntries();
  const json = async name => JSON.parse(new TextDecoder().decode(await entries.find(entry => entry.filename.endsWith('/' + name)).getData(new Uint8ArrayWriter())));
  const report = await json('failures.json');
  assert.equal(report.length, 4); assert.equal(report.filter(error => error.stage === 'discovery').length, 3);
  assert(report.some(error => error.stage === 'discovery' && error.kind === 'page' && error.offset === 50 && error.status === 503));
  assert(report.some(error => error.stage === 'discovery' && error.postId === '911' && error.status === 404));
  assert(report.some(error => error.stage === 'download' && error.error === 'File HTTP 404'));
  assert.equal(entries.filter(entry => entry.filename.endsWith('/post.txt')).length, 3);
  assert((await json('sync.json')).posts.every(post => post.files.every(file => file.kind === 'text')));
  await zip.close();
  console.log('PASS: missing details, invalid creator records and exhausted pages do not block available posts; ZIP contains saved text and complete discovery/media error reports.');
  await targetEvaluate(`(async()=>{const directory=await(await navigator.storage.getDirectory()).getDirectoryHandle('tolerance-folder',{create:true});const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('kemono-archive-destinations',1);request.onupgradeneeded=()=>request.result.createObjectStore('folders');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});await new Promise((resolve,reject)=>{const tx=db.transaction('folders','readwrite');tx.objectStore('folders').put(directory,'tolerance-folder');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});db.close();return true;})()`);
  await send({ type: 'POST_FOLDER', jobId, directoryId: 'tolerance-folder', name: 'Tolerance folder' });
  await send({ type: 'POST_DOWNLOAD', jobId, selection, destination: 'folder' });
  await waitFor(async () => (await send({ type: 'POST_DETAIL', jobId })).job.status === 'finished');
  const readFolder = name => targetEvaluate(`(async()=>{const directory=await(await navigator.storage.getDirectory()).getDirectoryHandle('tolerance-folder');return JSON.parse(await(await(await directory.getFileHandle(${JSON.stringify(name)})).getFile()).text());})()`);
  assert.equal((await readFolder('failures.json')).length, 4);
  assert.equal((await readFolder('sync.json')).posts.length, 3);
  await worker.evaluate(() => { globalThis.__recover = true; });
  await send({ type: 'POST_ACTION', jobId, action: 'retry' });
  await waitFor(async () => (await send({ type: 'POST_DETAIL', jobId })).job.status === 'finished');
  view = await send({ type: 'POST_DETAIL', jobId }); assert.equal(view.totals.discoveryFailures, 0); assert.equal(view.totals.posts, 5);
  assert.equal((await readFolder('failures.json')).length, 1); assert.equal((await readFolder('sync.json')).posts.length, 5);
  console.log('PASS: folder saving records the same errors; Retry failures revisits gaps, adds recovered posts and rewrites the error report without losing saved files.');
  await worker.evaluate(() => { globalThis.__repeat = true; });
  await send({ type: 'POST_ACTION', jobId, action: 'rescan' });
  await waitFor(async () => (await send({ type: 'POST_DETAIL', jobId })).job.status === 'paused');
  await frame.locator('#skip').waitFor(); await frame.locator('#skip').click();
  await waitFor(async () => (await send({ type: 'POST_DETAIL', jobId })).job.scan.complete);
  view = await send({ type: 'POST_DETAIL', jobId }); assert.equal(view.totals.posts, 1); assert.equal(view.totals.discoveryFailures, 1);
  assert.deepEqual(errors, []);
  console.log('PASS: Skip this error is available on a paused repeated page and continues discovery while retaining a reported gap.');
} finally {
  await context?.close();
  assert(output.startsWith(root + sep) && output.includes('.service-check-tolerance-'));
  await rm(output, { recursive: true, force: true });
  console.log('Removed temporary tolerance profile, ZIP and saved folder.');
}
