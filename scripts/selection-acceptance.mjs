import { chromium } from 'playwright';
import { ZipReader, Uint8ArrayReader, Uint8ArrayWriter } from '@zip.js/zip.js';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve('.'), output = resolve(`.selection-check-${Date.now()}`);
assert(output.startsWith(root + sep) && output.includes('.selection-check-'));
await mkdir(output);
const fixture = JSON.parse(await readFile('tests/fixtures/post-11312487.sanitized.json', 'utf8'));
const image = await readFile('tests/fixtures/bird_01.thumbnail.png');
const profileUrl = `https://pawchive.pw/fanbox/user/${fixture.user}`;
const posts = ['1', '2', '3'].map((id, i) => ({ ...fixture, id, title: `Selected post ${id}`, content: `<p>Text for post ${id}</p>`,
  file: { name: `image-${id}.png`, path: `/${'abc'[i].repeat(2)}/${'abc'[i].repeat(2)}/${'abc'[i].repeat(64)}.png` } }));
const mediaRequests = [], errors = [];
let diagnostic = async () => ({ mediaRequests, errors });
const waitFor = async work => {
  const until = Date.now() + 45000;
  while (Date.now() < until) { const result = await work(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Timed out waiting for selected-post archive state: ' + JSON.stringify(await diagnostic()));
};
let context;
try {
  context = await chromium.launchPersistentContext(resolve(output, 'profile'), { channel: 'chromium', headless: true, acceptDownloads: true,
    args: [`--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  await worker.evaluate(posts => {
    const nativeFetch = fetch; globalThis.__apiRequests = [];
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (!url.pathname.startsWith('/api/v1/')) return nativeFetch(input, init);
      globalThis.__apiRequests.push(url.href);
      if (url.pathname.endsWith('/profile')) return new Response(JSON.stringify({ id: posts[0].user, name: 'Selection creator' }));
      if (url.pathname.includes('/post/')) return new Response(JSON.stringify(posts.find(post => post.id === url.pathname.split('/').at(-1))));
      return new Response(JSON.stringify(Number(url.searchParams.get('o')) === 0 ? posts : []));
    };
    const download = chrome.downloads.download.bind(chrome.downloads);
    chrome.downloads.download = options => download({ ...options, saveAs: false });
  }, posts);
  await context.route('https://**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'file.pawchive.pw' && url.pathname.startsWith('/data/')) {
      mediaRequests.push(url.href); return route.fulfill({ contentType: 'image/png', body: image });
    }
    if (url.href.startsWith(profileUrl)) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Selected posts</title><p>Showing 1 - 3 of 3</p>' });
    return route.abort();
  });
  const page = await context.newPage(), cdp = await context.newCDPSession(page);
  page.on('pageerror', error => errors.push(error.message));
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: output });
  let frame;
  const send = message => frame.evaluate(async message => {
    const reply = await chrome.runtime.sendMessage(message); if (!reply.ok) throw new Error(reply.error); return reply.data;
  }, message);
  async function open(url) {
    await page.goto(url);
    await worker.evaluate(async url => { const [tab] = await chrome.tabs.query({ url }); await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_OVERLAY' }); }, url);
    frame = await waitFor(() => page.frames().find(frame => frame.url().includes('/overlay/index.html')));
    await frame.locator('#title').waitFor();
    const job = await waitFor(async () => (await send({ type: 'SERVICE_JOBS' })).find(job => job.sourceUrl === url));
    await waitFor(async () => (await send({ type: 'POST_DETAIL', jobId: job.id })).job.scan.complete);
    return job.id;
  }
  async function selectOnly(id) {
    if (await frame.locator('#post-list').getAttribute('open') === null) await frame.locator('#post-list > summary').click();
    await frame.locator('#clear-post-selection').click();
    await waitFor(async () => await frame.locator('#download').isDisabled() && !await frame.locator('#post-picker').isDisabled());
    await frame.locator(`input[data-post-id="${id}"]`).check();
    await waitFor(async () => !await frame.locator('#post-picker').isDisabled() && (await frame.locator('#post-selection-count').textContent()).startsWith('1/3'));
  }
  let jobId = await open(profileUrl);
  diagnostic = async () => ({ ...(await send({ type: 'POST_DETAIL', jobId })), notice: await frame.locator('#notice').textContent(), mediaRequests, errors });
  await worker.evaluate(async () => {
    if (!(await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] })).length)
      await chrome.offscreen.createDocument({ url: 'offscreen/index.html', reasons: [chrome.offscreen.Reason.BLOBS], justification: 'Verify selected-post media requests.' });
  });
  const target = await waitFor(async () => (await cdp.send('Target.getTargets')).targetInfos.find(target => target.url.endsWith('/offscreen/index.html')));
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
  let commandId = 0;
  const pending = new Map();
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++commandId; pending.set(id, { resolve, reject });
    cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) }).catch(reject);
  });
  cdp.on('Target.receivedMessageFromTarget', event => {
    if (event.sessionId !== sessionId) return;
    const message = JSON.parse(event.message);
    if (message.id) {
      const promise = pending.get(message.id); if (!promise) return;
      pending.delete(message.id);
      if (message.error) promise.reject(new Error(JSON.stringify(message.error))); else promise.resolve(message.result);
    } else if (message.method === 'Fetch.requestPaused') {
      const { requestId, request } = message.params, url = new URL(request.url);
      if (url.hostname === 'file.pawchive.pw' && posts.some(post => url.pathname === '/data' + post.file.path)) {
        mediaRequests.push(url.href);
        command('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'image/png' }, { name: 'Content-Length', value: String(image.length) }], body: image.toString('base64') }).catch(error => errors.push(error.message));
      } else command('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(error => errors.push(error.message));
    }
  });
  await command('Fetch.enable', { patterns: [{ urlPattern: 'https://*' }] });
  await selectOnly('1'); await frame.locator('#destination-zip').check();
  assert.equal(await frame.locator('#download').textContent(), 'Download selected posts as ZIP');
  await frame.locator('#download').click();
  await waitFor(async () => (await send({ type: 'POST_DETAIL', jobId })).job.archive?.state === 'saved');
  const [download] = await worker.evaluate(() => chrome.downloads.search({}));
  const reader = new ZipReader(new Uint8ArrayReader(await readFile(download.filename)), { useWebWorkers: false });
  const entries = await reader.getEntries(), extracted = [];
  for (const entry of entries) extracted.push({ path: entry.filename.split('/').slice(1).join('/'), bytes: [...await entry.getData(new Uint8ArrayWriter())] });
  await reader.close();
  const json = name => JSON.parse(new TextDecoder().decode(new Uint8Array(extracted.find(entry => entry.path === name).bytes)));
  assert.deepEqual(json('sync.json').posts.map(post => post.id), ['1']);
  assert.deepEqual(json('manifest.json').posts.map(post => post.id), ['1']);
  assert.equal(mediaRequests.length, 1);
  assert(mediaRequests[0].includes('/data' + posts[0].file.path));
  const savedImage = json('sync.json').posts[0].files.find(file => file.kind === 'image');
  assert.deepEqual(extracted.find(entry => entry.path === savedImage.path).bytes, [...image]);
  console.log('PASS: UI selection downloads only the chosen post; ZIP files and manifest exclude other posts.');

  async function connectArchive(extract = false) {
    await frame.locator('#destination-folder').check(); await frame.locator('#choose-sync').click();
    const picker = await waitFor(() => context.pages().find(page => page.url().includes('/folder/index.html')));
    await picker.locator('#open-sync').waitFor();
    await picker.evaluate(async extracted => {
      const root = await navigator.storage.getDirectory(), directory = await root.getDirectoryHandle('selected-creator', { create: true });
      for (const entry of extracted) {
        const parts = entry.path.split('/'); let parent = directory;
        for (const part of parts.slice(0, -1)) parent = await parent.getDirectoryHandle(part, { create: true });
        const stream = await (await parent.getFileHandle(parts.at(-1), { create: true })).createWritable();
        await stream.write(new Uint8Array(entry.bytes)); await stream.close();
      }
      window.showOpenFilePicker = async () => [await directory.getFileHandle('sync.json')];
      window.showDirectoryPicker = async options => { globalThis.__startFile = options.startIn?.name; return directory; };
    }, extract ? extracted : []);
    await picker.locator('#open-sync').click(); await picker.locator('#grant-sync').waitFor();
    await picker.locator('#grant-sync').click();
    await waitFor(async () => (await picker.locator('#status').textContent()).startsWith('Sync connected.'));
    assert.equal(await picker.evaluate(() => globalThis.__startFile), 'sync.json');
    await picker.locator('#return').click();
    await waitFor(async () => (await send({ type: 'POST_DETAIL', jobId })).job.scan.complete);
    await waitFor(async () => (await frame.locator('#folder-note').textContent()).startsWith('selected-creator') && !await frame.locator('#download').isDisabled());
    return picker;
  }
  let picker = await connectArchive(true);
  let detail = await send({ type: 'POST_DETAIL', jobId });
  assert.equal(detail.allPostsSelected, false); assert.equal(detail.totals.selectedPosts, 1);
  assert.deepEqual(detail.posts.filter(post => post.selected).map(post => post.id), ['1']);
  await selectOnly('2');
  const beforeFolderRequests = mediaRequests.length;
  await frame.locator('#download').click();
  await waitFor(async () => (await send({ type: 'POST_DETAIL', jobId })).job.status === 'finished');
  assert.equal(mediaRequests.length, beforeFolderRequests + 1);
  assert(mediaRequests.at(-1).includes('/data' + posts[1].file.path));
  const readIndex = () => picker.evaluate(async () => {
    const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('selected-creator');
    const file = await (await directory.getFileHandle('sync.json')).getFile();
    return JSON.parse(await file.text());
  });
  let index = await readIndex();
  assert.deepEqual(index.posts.map(post => post.id).sort(), ['1', '2']);
  assert(index.posts.every(post => post.files.length === 2));
  await frame.locator('#download').click();
  await waitFor(async () => (await send({ type: 'POST_DETAIL', jobId })).job.status === 'finished');
  assert.equal(mediaRequests.length, beforeFolderRequests + 1);
  console.log('PASS: extracted ZIP reconnects through sync.json, retains the subset, and adds only a new selected post without duplicates.');
  await picker.close();

  jobId = await open(profileUrl + '/post/3');
  const beforeSingleApi = await worker.evaluate(() => globalThis.__apiRequests.length);
  picker = await connectArchive(); detail = await send({ type: 'POST_DETAIL', jobId });
  assert.equal(detail.job.source.postId, '3'); assert.equal(detail.job.sourceUrl, profileUrl + '/post/3');
  assert.equal(detail.totals.posts, 1); assert.equal(await frame.locator('#scope').inputValue(), 'post');
  const apiRequests = await worker.evaluate(start => globalThis.__apiRequests.slice(start), beforeSingleApi);
  assert.equal(apiRequests.length, 1); assert(apiRequests[0].endsWith('/post/3'));
  const beforeSingleMedia = mediaRequests.length;
  await frame.locator('#download').click();
  await waitFor(async () => (await send({ type: 'POST_DETAIL', jobId })).job.status === 'finished');
  assert.equal(mediaRequests.length, beforeSingleMedia + 1);
  assert(mediaRequests.at(-1).includes('/data' + posts[2].file.path));
  index = await readIndex(); assert.deepEqual(index.posts.map(post => post.id).sort(), ['1', '2', '3']);
  assert(index.posts.every(post => post.files.length === 2)); assert.deepEqual(errors, []);
  assert.equal((await worker.evaluate(() => chrome.downloads.search({}))).length, 1);
  console.log('PASS: connecting the same archive on another post page keeps single-post scope, fetches only that post, and retains earlier history.');
} finally {
  if (context) await context.close();
  await rm(output, { recursive: true, force: true });
  console.log('Removed temporary selected-post profile, extracted archive, and ZIP.');
}
