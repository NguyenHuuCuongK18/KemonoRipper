import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
const root = 'https://kemono.cr/discord/server/1217290220718915654';
const browser = await chromium.launch({ channel: 'chromium', headless: true });
try {
  const page = await browser.newPage();
  await page.goto(root, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('a[href*="/discord/server/1217290220718915654/"]');
  const result = await page.evaluate(() => {
    const links = [...document.querySelectorAll('a[href]')].filter(a => /^https:\/\/kemono\.cr\/discord\/server\/1217290220718915654\/\d+\/?$/.test(a.href));
    // Keep only public channel navigation; no arbitrary page HTML or account controls.
    const safe = document.createElement('nav');
    for (const link of links) {
      const copy = document.createElement('a'); copy.href = link.href; copy.textContent = link.textContent;
      for (const attr of ['title', 'aria-label']) if (link.hasAttribute(attr)) copy.setAttribute(attr, link.getAttribute(attr));
      safe.append(copy);
    }
    return { url: location.href, title: document.title, count: links.length, unique: new Set(links.map(a => a.href)).size, sample: links.slice(0, 3).map(a => ({ href: a.href, text: a.textContent, classes: a.className, parentTag: a.parentElement?.tagName, parentClass: a.parentElement?.className })), html: safe.outerHTML };
  });
  await writeFile('tests/fixtures/server-navigation.sanitized.html', result.html);
  delete result.html;
  console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
