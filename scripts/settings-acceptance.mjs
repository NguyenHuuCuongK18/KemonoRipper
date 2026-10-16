import { chromium } from 'playwright';
import { BlobWriter, TextReader, ZipWriter, ZipReader, Uint8ArrayReader, Uint8ArrayWriter } from '@zip.js/zip.js';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve('.'), output = resolve(`.service-check-settings-${Date.now()}`);
assert(output.startsWith(root + sep) && output.includes('.service-check-settings-')); await mkdir(output);
const writer = new ZipWriter(new BlobWriter(), { useWebWorkers: false });
await writer.add('nested/content.custom', new TextReader('ZIP content'));
const zipBytes = new Uint8Array(await (await writer.close()).arrayBuffer());
const fixtures = [
  ['bundle.zip', zipBytes], ['bundle.7z', await readFile('tests/fixtures/archives/sample.7z')],
  ['bundle.rar', await readFile('tests/fixtures/archives/rar5-stored.rar')],
  ['legacy.rar', await readFile('tests/fixtures/archives/rar4-subblock.rar')],
  ['locked.rar', await readFile('tests/fixtures/archives/rar4-encrypted.rar')],
  ['bundle.tar.gz', await readFile('tests/fixtures/archives/sample.tar.gz')],
  ['broken.zip', new TextEncoder().encode('Invalid compressed data')],
  ['source.psd', new TextEncoder().encode('PSD fixture')], ['no-extension', new TextEncoder().encode('Unknown file fixture')],
].map(([name, bytes], i) => ({ name, bytes: [...bytes], path: '/aa/bb/' + String(i + 1).repeat(64) + (name.includes('.') ? '.' + name.split('.').at(-1) : '') }));
const profileUrl = 'https://pawchive.pw/fanbox/user/123';
const posts = [{ id: '100', user: '123', service: 'fanbox', title: 'Extraction fixture', content: 'Post text', detail_fetched: true, attachments: fixtures.map(({ name, path }) => ({ name, path })) }];
let context, diagnostic = async () => ({});
async function waitFor(work) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) { const result = await work(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 150)); }
  throw new Error('Settings acceptance timed out: ' + JSON.stringify(await diagnostic()));
}
try {
  context = await chromium.launchPersistentContext(resolve(output, 'profile'), { channel: 'chromium', headless: true, acceptDownloads: true,
    args: [`--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const page = await context.newPage(), cdp = await context.newCDPSession(page), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: output });
  await context.route('https://**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Settings fixture</title>' }));
  await worker.evaluate(posts => {
    const nativeFetch = fetch;
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input)); if (!url.pathname.startsWith('/api/v1/')) return nativeFetch(input, init);
      if (url.pathname.endsWith('/profile')) return new Response(JSON.stringify({ id: '123', name: 'Settings creator' }));
      if (url.pathname.includes('/post/')) return new Response(JSON.stringify(posts[0]));
      return new Response(JSON.stringify(Number(url.searchParams.get('o')) === 0 ? posts : []));
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
  let jobId = (await send({ type: 'SERVICE_JOBS' }))[0].id;
  diagnostic = async () => ({ view: await send({ type: 'POST_DETAIL', jobId }), notice: await frame.locator('#notice').textContent() });
  await waitFor(async () => (await send({ type: 'POST_DETAIL', jobId })).job.scan.complete);
  await frame.locator('#file-types summary').click();
  const checkbox = frame.locator('#file-type-options input');
  await waitFor(async () => await checkbox.count() === 7);
  assert.equal(await checkbox.evaluateAll(inputs => inputs.every(input => input.checked)), true);
  await frame.locator('#clear-file-types').click();
  assert.equal(await checkbox.evaluateAll(inputs => inputs.every(input => !input.checked)), true);
  await frame.locator('#all-file-types').click();
  assert.equal(await checkbox.evaluateAll(inputs => inputs.every(input => input.checked)), true);
  await frame.locator('#file-type-options input[data-file-type="psd"]').uncheck();
  await frame.locator('#extract-archives').check();
  console.log('PASS: scanned types include unknown files and compound archives; all types default to selected and can be deselected.');
  await worker.evaluate(async () => {
    if (!(await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] })).length)
      await chrome.offscreen.createDocument({ url: 'offscreen/index.html', reasons: [chrome.offscreen.Reason.BLOBS], justification: 'Verify optional archive extraction.' });
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
  await targetEvaluate(`(()=>{const fixtures=${JSON.stringify(fixtures)};const nativeFetch=fetch;globalThis.__mediaRequests=[];globalThis.fetch=async(input,init)=>{const url=new URL(String(input));if(url.protocol!=='https:')return nativeFetch(input,init);globalThis.__mediaRequests.push(url.href);const file=fixtures.find(file=>url.pathname==='/data'+file.path);return file?new Response(new Uint8Array(file.bytes),{headers:{'content-type':'application/octet-stream','content-length':String(file.bytes.length)}}):new Response('',{status:404});};return true;})()`);
  const selection = { quality: 'full res', images: true, files: true, text: true, fallbackToThumbnail: true, excludedFileTypes: ['psd'], extractArchives: true };
  await frame.locator('#destination-zip').check(); await frame.locator('#download').click();
  await waitFor(async () => (await send({ type: 'POST_DETAIL', jobId })).job.archive?.state === 'saved');
  const view = await send({ type: 'POST_DETAIL', jobId });
  assert.equal(view.totals.extractionFailures, 2); assert(view.totals.extracted >= 5);
  const [download] = await worker.evaluate(() => chrome.downloads.search({}));
  const zip = new ZipReader(new Uint8ArrayReader(new Uint8Array(await readFile(download.filename))), { useWebWorkers: false });
  const entries = await zip.getEntries();
  const json = async name => JSON.parse(new TextDecoder().decode(await entries.find(entry => entry.filename.endsWith('/' + name)).getData(new Uint8ArrayWriter())));
  assert.deepEqual((await json('settings.json')).selection, selection);
  const report = await json('failures.json'); assert.equal(report.length, 2); assert(report.every(row => row.stage === 'extraction' && row.originalKept === true));
  assert(entries.some(entry => entry.filename.endsWith('_broken.zip'))); assert(!entries.some(entry => entry.filename.endsWith('_bundle.zip') || entry.filename.endsWith('_bundle.rar') || entry.filename.endsWith('_bundle.7z') || entry.filename.endsWith('_bundle.tar.gz')));
  assert(!entries.some(entry => entry.filename.endsWith('.psd'))); assert(entries.some(entry => entry.filename.endsWith('_no-extension')));
  assert(!entries.some(entry => entry.filename.endsWith('_legacy.rar'))); assert(entries.some(entry => entry.filename.endsWith('_locked.rar')));
  assert.equal((await json('sync.json')).posts[0].files.filter(file => file.originalKept === false).length, 5);
  await zip.close();
  console.log('PASS: real extension workers unpack ZIP, 7z, RAR and compressed TAR; export contains extracted contents only on success, failed archives remain, settings and errors are recorded.');
  await targetEvaluate(`(async()=>{const directory=await(await navigator.storage.getDirectory()).getDirectoryHandle('settings-folder',{create:true});const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('kemono-archive-destinations',1);request.onupgradeneeded=()=>request.result.createObjectStore('folders');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});await new Promise((resolve,reject)=>{const tx=db.transaction('folders','readwrite');tx.objectStore('folders').put(directory,'settings-folder');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});db.close();return true;})()`);
  await send({ type: 'POST_FOLDER', jobId, directoryId: 'settings-folder', name: 'Settings folder' });
  await send({ type: 'POST_DOWNLOAD', jobId, selection, destination: 'folder' });
  await waitFor(async () => (await send({ type: 'POST_DETAIL', jobId })).job.status === 'finished');
  const snapshot = () => targetEvaluate(`(async()=>{const directory=await(await navigator.storage.getDirectory()).getDirectoryHandle('settings-folder');const paths=[];async function walk(dir,prefix=''){for await(const entry of dir.values()){if(entry.kind==='directory')await walk(entry,prefix+entry.name+'/');else paths.push(prefix+entry.name);}}await walk(directory);const settings=JSON.parse(await(await(await directory.getFileHandle('settings.json')).getFile()).text());return{paths,settings,requests:globalThis.__mediaRequests.length};})()`);
  const saved = await snapshot(); assert.deepEqual(saved.settings.selection, selection); assert.equal(saved.paths.filter(path => path.endsWith('.extracted/nested/content.custom')).length, 2);
  assert(saved.paths.some(path => path.endsWith('_broken.zip'))); assert(!saved.paths.some(path => /_bundle\.(?:zip|7z|rar|tar.gz)$/.test(path)));
  // Connect the folder as a new scan and confirm settings are restored, then sync without downloading extracted-only originals again.
  await send({ type: 'POST_START', url: profileUrl }); jobId = (await send({ type: 'SERVICE_JOBS' }))[0].id;
  await send({ type: 'POST_SYNC_CONNECT', jobId, directoryId: 'settings-folder', name: 'Settings folder' });
  await waitFor(async () => (await send({ type: 'POST_DETAIL', jobId })).job.scan.complete);
  assert.deepEqual((await send({ type: 'POST_DETAIL', jobId })).job.selection, selection);
  await send({ type: 'POST_DOWNLOAD', jobId, selection, destination: 'folder' });
  await waitFor(async () => (await send({ type: 'POST_DETAIL', jobId })).job.status === 'finished');
  assert.equal((await snapshot()).requests, saved.requests);
  await send({ type: 'POST_ACTION', jobId, action: 'retry' });
  await waitFor(async () => (await send({ type: 'POST_DETAIL', jobId })).job.status === 'finished');
  assert.equal((await snapshot()).requests, saved.requests);
  await targetEvaluate(`(async()=>{const root=await(await navigator.storage.getDirectory()).getDirectoryHandle('settings-folder');const sync=JSON.parse(await(await(await root.getFileHandle('sync.json')).getFile()).text());const entry=sync.posts[0].files.find(file=>file.path.endsWith('_bundle.zip')).extracted[0];const parts=entry.path.split('/');let directory=root;for(const part of parts.slice(0,-1))directory=await directory.getDirectoryHandle(part);await directory.removeEntry(parts.at(-1));return true;})()`);
  await send({ type: 'POST_DOWNLOAD', jobId, selection, destination: 'folder' });
  await waitFor(async () => (await send({ type: 'POST_DETAIL', jobId })).job.status === 'finished');
  assert.equal((await snapshot()).requests, saved.requests + 1);
  assert.deepEqual(errors, []);
  console.log('PASS: folder saving removes successful compressed sources, retains failures, restores settings, skips intact extracted files, retries extraction without network downloads and restores a deleted output by fetching only its source.');
} finally {
  await context?.close(); assert(output.startsWith(root + sep) && output.includes('.service-check-settings-')); await rm(output, { recursive: true, force: true });
  console.log('Removed temporary settings profile, archives and saved folder.');
}
