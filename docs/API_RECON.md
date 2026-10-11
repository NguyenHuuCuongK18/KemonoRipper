# API reconnaissance

Baseline: the supplied blueprint's verified findings from 2026-10-09. This repository started with only that document; the original user's HTML/JSON evidence was not present.

Initial public network probe on 2026-10-09 reproduced `GET /api/v1/discord/channel/1268995994440302725?o=0` with `Accept: text/css`: HTTP 200, response MIME `text/css; charset=utf-8`, 32 messages. First ID `1268995994440302725`, last ID `1379593494393258125`. No credentials were provided.

`npm run recon` creates a temporary unpacked MV3 probe and runs it in an isolated Chromium profile. It tests server discovery, offsets 0/150/300 on two channels, thumbnail byte reads and decoding, a browser-managed thumbnail download, and the same API call from a site page. It writes field-projected sanitized fixtures; author objects, mentions, arbitrary message text, navigation, and request headers are excluded.

## Measured in an isolated Chromium MV3 extension on 2026-10-09

The extension service worker and a same-origin site page both successfully fetched the reference channel with the required header. No credentials were supplied; no authenticated account was needed for these public samples. An authenticated-page comparison was therefore unnecessary and was not performed.

| Channel | Offset 0 | Offset 150 | Offset 300 | Unique messages |
| --- | ---: | ---: | ---: | ---: |
| `1268995994440302725` | 32 | 0 | 0 | 32 |
| `1218678089555640351` | 0 | 0 | 0 | 0 |
| `1268993704975274117` | 150 | 59 | 0 | 209 |

Messages were ascending by snowflake in these samples. The larger channel's first page ended at `1368797470666260553`; offset 150 began at `1368824019964530738`. The implementation advances offsets by 150 and continues after short pages until a successful empty array. Repeated pages are treated as incompatible pagination, never as completion. Omitted offsets and arbitrary non-multiple offsets were not tested and are not used.

The reference channel contains 57 attachments. Rendered media extraction recovered the same 32 messages and 57 image pairs. Server `post_count` values of 31 and 208 differ from actual API counts of 32 and 209. Counts are informational, never termination conditions.

The reference thumbnail fetched and decoded from the service worker: HTTP 200, **55,959 bytes**, **800 × 593**, SHA-256 `eb1d7a6022f5772f1e7b8cf8d94223b271601c43dc15b29ef6899d5f7aadab43`. Browser downloads reported completion. The actual bytes are **JPEG**, despite the storage/thumbnail URL ending in `.png`; the downloader detects this and uses `.jpg`. The original hash identifies a different byte sequence and is not compared against thumbnail bytes.

The complete application subsequently passed a live reference-channel scan and **57/57 validated thumbnail downloads**, automatic manifests, JSON/CSV export, pause/resume, a forced service-worker stop and restart, and the 209-message multi-page scan. The final live run additionally exercised the installed DOM content script and checked that all completed files existed at the expected archive paths with normal browser download behavior. A fixture-based browser run intentionally returned an HTTP 200 HTML body for one image: **56 downloaded / 1 failed** with incomplete results exported honestly. These tests do not establish availability of every channel or original node.

`tests/fixtures/recon.json` holds the compact probe results. JSON fixtures are field projections of actual responses, not invented message arrays. HTML fixtures contain only message containers and observed media links; author text, content, account navigation, and request headers are removed.

## Server-root navigation verified on 2026-10-09

Opening `https://kemono.cr/discord/server/1217290220718915654` redirects to channel `1218665430776807525`. The rendered page contains **65 unique channel anchors**, matching the 65 API channel IDs. Channel anchors use normal `/discord/server/{serverId}/{channelId}` hrefs; CSS classes are generated and are not stable selectors. `server-navigation.sanitized.html` preserves only those public hrefs and channel labels. The extension scans validated anchor URLs, merges them with API channel metadata and retains source provenance. The server-root input defaults to all channels; an explicit Entire server scope handles the redirect. Metadata zero counts never exclude a channel from scanning. No live whole-server image transfer was performed during this navigation check.

Primary references consulted for behavior (no extractor implementation copied):

- [Kemono API](https://kemono.cr/documentation/api)
- [gallery-dl's Kemono extractor](https://github.com/mikf/gallery-dl/blob/master/gallery_dl/extractor/kemono.py) currently identifies Discord batches as 150.
- [Chrome worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
- [Chrome offscreen documents](https://developer.chrome.com/docs/extensions/reference/api/offscreen)
- [Playwright extension testing](https://playwright.dev/docs/chrome-extensions)
