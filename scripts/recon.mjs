import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// No existing browser profile, cookies, tokens, or user account is accessed.
const root = resolve('.probe');
await mkdir(root, { recursive: true });
await mkdir('tests/fixtures', { recursive: true });
await writeFile(resolve(root, 'manifest.json'), JSON.stringify({
  manifest_version: 3, name: 'Archive networking probe', version: '0.0.1',
  background: { service_worker: 'worker.js' }, permissions: ['downloads'],
  host_permissions: ['https://kemono.cr/*', 'https://img.kemono.cr/*'],
}));
await writeFile(resolve(root, 'worker.js'), 'chrome.runtime.onInstalled.addListener(() => {});');
const context = await chromium.launchPersistentContext('', {
  channel: 'chromium', headless: true, acceptDownloads: true,
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
});
try {
  await mkdir('artifacts/recon-downloads', { recursive: true });
  const cdp = await context.newCDPSession(await context.newPage());
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: resolve('artifacts/recon-downloads') });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const serverId = '1217290220718915654';
  const channels = ['1268995994440302725', '1218678089555640351'];
  const fetchJson = async (path) => worker.evaluate(async (path) => {
    const response = await fetch(`https://kemono.cr/api/v1${path}`, {
      headers: { Accept: 'text/css' }, credentials: 'omit', signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { status: response.status, contentType: response.headers.get('content-type'), data: JSON.parse(await response.text()) };
  }, path);
  const server = await fetchJson(`/discord/server/${serverId}`);
  const multipage = server.data.channels.filter(c => c.post_count >= 150).sort((a, b) => a.post_count - b.post_count)[0];
  if (multipage && !channels.includes(multipage.id)) channels.push(multipage.id);
  const safeServer = { id: server.data.id, name: server.data.name, channels: server.data.channels.map(c => ({
    id: c.id, server_id: c.server_id, name: c.name, parent_channel_id: c.parent_channel_id,
    type: c.type, position: c.position, post_count: c.post_count,
  })) };
  await writeFile('tests/fixtures/server.sanitized.json', JSON.stringify(safeServer, null, 2));
  const report = { serverStatus: server.status, apiMime: server.contentType, channels: [], thumbnail: null, pageContext: null };
  for (const channel of channels) {
    const pages = [];
    // Sequential and deliberately limited. The second channel provides the multi-page gate.
    for (const offset of [0, 150, 300]) {
      const result = await fetchJson(`/discord/channel/${channel}?o=${offset}`);
      if (!Array.isArray(result.data)) throw new Error('Expected message array');
      const safe = result.data.map(m => ({
        id: m.id, server: m.server, channel: m.channel, published: m.published,
        content: (m.content?.match(/https:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\/attachments\/[^\s<>"']+/g) || []).join(' '),
        attachments: (m.attachments || []).map(a => ({ name: a.name, path: a.path })),
      }));
      await writeFile(`tests/fixtures/channel-${channel}-${offset}.sanitized.json`, JSON.stringify(safe, null, 2));
      pages.push({ offset, count: safe.length, first: safe[0]?.id, last: safe.at(-1)?.id, attachments: safe.reduce((n, m) => n + m.attachments.length, 0) });
      await new Promise(r => setTimeout(r, 1100));
    }
    report.channels.push({ id: channel, pages });
  }
  const thumbnailUrl = 'https://img.kemono.cr/thumbnail/data/82/79/8279311a88d313cf25b6f1ad302ac7f82203f9712829b82785b0b3fac3e0871e.png';
  report.thumbnail = await worker.evaluate(async url => {
    const response = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`Thumbnail HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
    const bitmap = await createImageBitmap(new Blob([bytes]));
    const result = { status: response.status, bytes: bytes.byteLength, sha256: hash, width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return { ...result, base64: btoa([...new Uint8Array(bytes)].map(b => String.fromCharCode(b)).join('')) };
  }, thumbnailUrl);
  await writeFile('tests/fixtures/bird_01.thumbnail.png', Buffer.from(report.thumbnail.base64, 'base64'));
  delete report.thumbnail.base64;
  // Verify browser-managed downloads as well as byte reads.
  report.download = await worker.evaluate(async url => {
    const id = await chrome.downloads.download({ url, filename: 'KemonoRipperProbe/bird_01.png', saveAs: false });
    for (let i = 0; i < 40; i++) {
      const [item] = await chrome.downloads.search({ id });
      if (item?.state !== 'in_progress') return { id, state: item?.state, error: item?.error || null, bytes: item?.fileSize };
      await new Promise(r => setTimeout(r, 250));
    }
    return { id, state: 'timed out' };
  }, thumbnailUrl);
  const page = await context.newPage();
  await page.goto(`https://kemono.cr/discord/server/${serverId}/${channels[0]}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  report.pageContext = await page.evaluate(async channel => {
    const response = await fetch(`/api/v1/discord/channel/${channel}?o=0`, { headers: { Accept: 'text/css' }, credentials: 'same-origin' });
    return { status: response.status, count: JSON.parse(await response.text()).length };
  }, channels[0]);
  await page.waitForSelector('[id^="message-"]', { timeout: 20000 });
  // Copy only message IDs, timestamps and media links; discard author/content/navigation.
  const safeHtml = await page.evaluate(() => [...document.querySelectorAll('[id^="message-"]')].map(el => {
    const article = document.createElement('article'); article.id = el.id;
    for (const node of el.querySelectorAll('time, a[href]')) {
      if (node instanceof HTMLTimeElement) {
        const time = document.createElement('time'); time.dateTime = node.dateTime; article.append(time);
      } else if (node instanceof HTMLAnchorElement && /\/(?:data|thumbnail\/data)\/[0-9a-f]{2}\//i.test(node.href)) {
        const anchor = document.createElement('a'); anchor.href = node.href;
        const original = node.querySelector('img');
        if (original) { const img = document.createElement('img'); img.src = original.src; anchor.append(img); }
        article.append(anchor);
      }
    }
    return article.outerHTML;
  }).join('\n'));
  await writeFile('tests/fixtures/channel.sanitized.html', safeHtml);
  await writeFile('tests/fixtures/recon.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await context.close(); }
