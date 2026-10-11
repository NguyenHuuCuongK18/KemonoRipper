import { parseChannelUrl } from '../core/urlParser';
import { scanDom } from './domScanner';
import { scanChannelNavigation } from './channelScanner';
import { toggleOverlay } from './overlay';
const state = globalThis as typeof globalThis & { __archiveRipperLoaded?: boolean };
if (!state.__archiveRipperLoaded) {
state.__archiveRipperLoaded = true;
let timer: ReturnType<typeof setTimeout> | undefined;
let previousUrl = '';
function collect(): void {
  previousUrl = location.href;
  const scope = parseChannelUrl(location.href);
  if (!scope) return;
  const scan = scanDom(document, scope);
  void chrome.runtime.sendMessage({ type: 'DOM', url: location.href, ...scan }).catch(() => {});
}
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message.type === 'TOGGLE_OVERLAY') { toggleOverlay(); respond({ ok: true }); return; }
  if (message.type === 'PAGE_CONTEXT') {
    const text = document.querySelector('.paginator')?.textContent || '';
    const count = /\bof\s+([\d,]+)/i.exec(text);
    respond({ url: location.href, expectedPosts: count ? Number(count[1].replaceAll(',', '')) : null }); return;
  }
  if (message.type === 'DISCOVER_CHANNELS') { respond(scanChannelNavigation(document, location.href)); return; }
  if (message.type === 'SCAN_DOM') { collect(); respond({ ok: true }); }
});
new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(collect, 1600); }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'data-src', 'srcset', 'href'] });
setInterval(() => { if (location.href !== previousUrl) collect(); }, 3000);
collect();
}
