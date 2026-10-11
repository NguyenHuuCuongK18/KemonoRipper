import { chromium } from 'playwright';
import { ZipReader, Uint8ArrayReader, Uint8ArrayWriter } from '@zip.js/zip.js';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve('.'), output = resolve(`.media-check-${Date.now()}`);
assert(output.startsWith(root + sep) && output.includes('.media-check-'));
await mkdir(output);
const post = JSON.parse(await readFile('tests/fixtures/post-11312487.sanitized.json', 'utf8'));
const image = await readFile('tests/fixtures/bird_01.thumbnail.png');
const source = `https://pawchive.pw/fanbox/user/${post.user}/post/${post.id}`;
const hosts = ['kemono.cr', 'pawchive.pw'].flatMap(domain =>
  ['', 'img.', 'file.', 'n1.', 'n2.', 'n3.', 'n4.', 'n5.', 'n42.', 'cdn.', 'media.eu.'].map(prefix => prefix + domain));
const requests = [], errors = [];
let originalStatus = 200;
let diagnostic = async () => ({ requests, errors });
const waitFor = async work => {
  const until = Date.now() + 45000;
  while (Date.now() < until) { const value = await work(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 150)); }
  throw new Error('Timed out waiting for media acceptance state: ' + JSON.stringify(await diagnostic()));
};
let context;
try {
  context = await chromium.launchPersistentContext(resolve(output, 'profile'), {
    channel: 'chromium', headless: true, acceptDownloads: true,
    args: [`--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`],
  });
  // Page navigation is controlled separately from the offscreen document's media requests.
  await context.route('https://**/*', route => {
    const url = new URL(route.request().url());
    if ((hosts.includes(url.hostname) && url.pathname === `/data${post.file.path}`) ||
        (url.hostname === 'img.pawchive.pw' && url.pathname === `/thumbnail/data${post.file.path}`)) {
      requests.push(url.href);
      return route.fulfill({ contentType: 'image/jpeg', body: image,
        headers: url.hostname === 'kemono.cr' || url.hostname.endsWith('.kemono.cr') ? { 'access-control-allow-origin': '*' } : {} });
    }
    if (url.href === source) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Post with one main file and no attachments</title>' });
    return route.abort();
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  await worker.evaluate(post => {
    const nativeFetch = fetch;
    globalThis.__post = post;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/profile')) return new Response(JSON.stringify({ id: post.user, name: 'Regression creator' }));
      if (url.endsWith(`/post/${post.id}`)) return new Response(JSON.stringify(globalThis.__post));
      return nativeFetch(input, init);
    };
    const nativeDownload = chrome.downloads.download.bind(chrome.downloads);
    chrome.downloads.download = options => nativeDownload({ ...options, saveAs: false });
  }, post);
  const page = await context.newPage(), cdp = await context.newCDPSession(page);
  page.on('pageerror', error => errors.push(error.message));
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: output });
  await page.goto(source);
  const tabId = await worker.evaluate(async url => (await chrome.tabs.query({ url }))[0].id, source);
  await worker.evaluate(tabId => chrome.tabs.sendMessage(tabId, { type: 'TOGGLE_OVERLAY' }), tabId);
  const frame = await waitFor(() => page.frames().find(frame => frame.url().includes('/overlay/index.html')));
  await waitFor(async () => (await frame.locator('#count').textContent()).includes('1/1'));
  assert.equal(await frame.locator('#posts li small').textContent(), '1 files');
  assert.equal(await frame.locator('#summary').textContent(), '1 images');
  assert.equal(await frame.locator('#quality-controls').isVisible(), false);
  assert.equal(await frame.locator('#fallback').isChecked(), true);
  await frame.locator('#destination-zip').check();
  await worker.evaluate(async () => {
    if (!(await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] })).length)
      await chrome.offscreen.createDocument({ url: 'offscreen/index.html', reasons: [chrome.offscreen.Reason.BLOBS], justification: 'Verify native archive media requests.' });
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
      const accepted = (hosts.includes(url.hostname) && url.pathname === `/data${post.file.path}`) ||
        (url.hostname === 'img.pawchive.pw' && url.pathname === `/thumbnail/data${post.file.path}`);
      if (accepted) {
        requests.push(url.href);
        // Native fetch still enforces CSP, permissions, CORS, and image decoding.
        // Controlled Kemono responses allow CORS because those hosts remain optional.
        const responseHeaders = [{ name: 'Content-Type', value: 'image/jpeg' }, { name: 'Content-Length', value: String(image.length) }];
        if (url.hostname === 'kemono.cr' || url.hostname.endsWith('.kemono.cr')) responseHeaders.push({ name: 'Access-Control-Allow-Origin', value: '*' });
        const status = url.pathname.startsWith('/thumbnail/') ? 200 : originalStatus;
        command('Fetch.fulfillRequest', { requestId, responseCode: status, responseHeaders, body: status === 200 ? image.toString('base64') : '' }).catch(error => errors.push(error.message));
      } else command('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(error => errors.push(error.message));
    }
  });
  await command('Fetch.enable', { patterns: [{ urlPattern: 'https://*' }] });
  await frame.locator('#download').click();
  const send = message => frame.evaluate(async message => {
    const reply = await chrome.runtime.sendMessage(message); if (!reply.ok) throw new Error(reply.error); return reply.data;
  }, message);
  const jobId = (await send({ type: 'SERVICE_JOBS' }))[0].id;
  diagnostic = async () => ({ ...(await send({ type: 'POST_DETAIL', jobId })), notice: await frame.locator('#notice').textContent(), requests, errors });
  const detail = await waitFor(async () => {
    const value = await send({ type: 'POST_DETAIL', jobId }); return value.job.archive?.state === 'saved' && value;
  });
  assert.equal(detail.totals.saved, 2, JSON.stringify({ totals: detail.totals, requests })); assert.equal(detail.totals.failed, 0);
  assert(!requests.some(url => url.includes('/thumbnail/')));
  assert(requests.includes(`https://n2.pawchive.pw/data${post.file.path}?f=${post.file.name}`));
  const downloads = await worker.evaluate(() => chrome.downloads.search({})); assert.equal(downloads.length, 1);
  const zip = new ZipReader(new Uint8ArrayReader(new Uint8Array(await readFile(downloads[0].filename))), { useWebWorkers: false });
  try {
    const entries = await zip.getEntries();
    for (const quality of ['full res']) {
      const entry = entries.find(entry => entry.filename.includes(`/${quality}/2026-01-28_${post.id}_`) && entry.filename.endsWith('.jpg'));
      assert(entry); assert.deepEqual(Buffer.from(await entry.getData(new Uint8ArrayWriter())), image);
      assert(entries.some(entry => entry.filename.includes(`/${quality}/2026-01-28_${post.id}_`) && entry.filename.endsWith('/post.txt')));
    }
  } finally { await zip.close(); }
  console.log('PASS: empty-attachments post saves only original bytes and text by default, in dated folders, through native extension fetch.');

  async function saveCase(fallbackToThumbnail, hasFull) {
    await worker.evaluate(hasFull => { globalThis.__post.has_full = hasFull; }, hasFull);
    const { jobId } = await send({ type: 'POST_START', url: source });
    await waitFor(async () => (await send({ type: 'POST_DETAIL', jobId })).job.scan.complete);
    const start = requests.length;
    await send({ type: 'POST_DOWNLOAD', jobId, selection: { quality: 'full res', fallbackToThumbnail, images: true, files: true, text: true }, destination: 'zip' });
    const detail = await waitFor(async () => { const value = await send({ type: 'POST_DETAIL', jobId }); return value.job.archive?.state === 'saved' && value; });
    const [download] = await worker.evaluate(id => chrome.downloads.search({ id }), detail.job.archive.downloadId);
    const zip = new ZipReader(new Uint8ArrayReader(new Uint8Array(await readFile(download.filename))), { useWebWorkers: false });
    try {
      const entries = await zip.getEntries(), sync = JSON.parse(new TextDecoder().decode(await entries.find(entry => entry.filename.endsWith('/sync.json')).getData(new Uint8ArrayWriter())));
      const images = entries.filter(entry => entry.filename.endsWith('.jpg'));
      for (const entry of images) assert.deepEqual(Buffer.from(await entry.getData(new Uint8ArrayWriter())), image);
      return { detail, images: images.map(entry => entry.filename), files: sync.posts.flatMap(post => post.files), requests: requests.slice(start) };
    } finally { await zip.close(); }
  }
  originalStatus = 404;
  const missing = await saveCase(true, true);
  assert.equal(missing.detail.totals.saved, 2); assert.equal(missing.detail.totals.failed, 0); assert.equal(missing.detail.totals.thumbnails, 1);
  assert.equal(missing.requests.length, 2); assert(missing.images.every(path => path.includes(`/thumbnail/2026-01-28_${post.id}_`)));
  assert.equal(missing.files.find(file => file.kind === 'image').quality, 'thumbnail');
  assert(missing.files.find(file => file.kind === 'image').id.includes(':thumbnail:'));
  const disabled = await saveCase(false, true);
  assert.equal(disabled.detail.totals.saved, 1); assert.equal(disabled.detail.totals.failed, 1); assert.equal(disabled.images.length, 0);
  assert(!disabled.requests.some(url => url.includes('/thumbnail/')));
  const unavailable = await saveCase(true, false);
  assert.equal(unavailable.detail.totals.saved, 2); assert.equal(unavailable.detail.totals.thumbnails, 1);
  assert.equal(unavailable.requests.length, 1); assert(unavailable.requests[0].includes('/thumbnail/'));
  console.log('PASS: missing originals fall back to honestly labeled thumbnail files; disabling fallback reports failure; known missing originals skip the original request.');
  originalStatus = 200;

  try {
    const urls = hosts.map(host => `https://${host}/data${post.file.path}?f=${post.file.name}`);
    const expression = `(async () => { const results = []; for (const url of ${JSON.stringify(urls)}) {
      const response = await fetch(url, { credentials: 'omit', redirect: 'error' });
      const blob = await response.blob(), bitmap = await createImageBitmap(blob);
      results.push({ status: response.status, bytes: blob.size, width: bitmap.width, height: bitmap.height }); bitmap.close();
    } return results; })()`;
    const evaluation = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    assert(!evaluation.exceptionDetails, JSON.stringify(evaluation.exceptionDetails));
    const results = evaluation.result.value; assert.equal(results.length, hosts.length);
    assert(results.every(result => result.status === 200 && result.bytes === image.length && result.width > 0 && result.height > 0));
    assert(urls.every(url => requests.includes(url)));
  } finally { await cdp.send('Target.detachFromTarget', { sessionId }); }
  assert.deepEqual(errors, []);
  console.log(`PASS: native Chromium fetch and image decoding on ${hosts.length} controlled Kemono/Pawchive hosts, including future nodes and nested CDN subdomains.`);
} finally {
  await context?.close();
  assert(output.startsWith(root + sep) && output.includes('.media-check-'));
  await rm(output, { recursive: true, force: true });
  console.log('Removed temporary media acceptance profile and ZIP.');
}
