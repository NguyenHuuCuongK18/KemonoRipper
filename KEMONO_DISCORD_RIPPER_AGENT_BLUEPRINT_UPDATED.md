# Kemono Discord Archive Ripper — Agent Build Blueprint

**Document type:** Portable implementation specification for coding agents  
**Target:** Chromium browsers (Chrome, Edge, Brave), Manifest V3  
**Language:** TypeScript  
**Status:** Updated with browser-verified reconnaissance from 2026-10-09; pagination, MV3 cross-origin requests, and whole-server downloads still require integration testing.
**Primary objective:** preserve and download surviving *thumbnails*, not recover inaccessible full-resolution Discord attachments.

## 1. Mission and scope

Build a local-first browser extension that indexes and downloads *available* image media from archived Discord channels on `kemono.cr`. Full-resolution media may be unavailable while thumbnails remain accessible. The extension must be useful even without downloading: it must support collecting, previewing, and exporting discovered image links and their metadata.

Primary **verified test channel**:

```text
https://kemono.cr/discord/server/1217290220718915654/1268995994440302725
```

- Server ID: `1217290220718915654` (`Dangpa's Art`)
- Channel/thread ID: `1268995994440302725` (`Original Characters (Miscellaneous)`)
- Another intended target, **not equivalently tested**: channel `1218678089555640351` (`s⭐-art-gallery`).
- Treat Discord IDs as **strings**, never JavaScript numbers.
- Support current channel, selected channels, and eventually whole-server extraction.
- Scope includes publicly accessible or otherwise legitimately accessible archived content. Respect site access controls and rate limits; do not implement authentication bypass or anti-bot evasion.

### Required output

```text
ArchiveRoot/
└── 1217290220718915654_ServerName/
    ├── 1218678089555640351_ChannelName/
    │   ├── 2024-03-20_153045Z_1234567890123456789_001.png
    │   ├── 2024-03-20_153045Z_1234567890123456789_002.jpg
    │   └── channel-manifest.json
    ├── AnotherChannelId_ChannelName/
    │   └── ...
    └── manifest.json
```

The dates and message IDs in this example are placeholders. The directory structure must preserve server/channel separation. Filenames should include UTC timestamp, message ID, and attachment index, and use the extension derived from downloaded media content.

## 2. Non-negotiable requirements

1. **Metadata-first extraction:** scanning links must be possible without downloading images.
2. **Reliable thumbnail fallback:** provide Thumbnail Only, Best Available, and Original Only modes; implement Thumbnail Only first.
3. **Channel hierarchy:** use server ID/name and channel ID/name; numeric IDs are authoritative.
4. **Timestamp preservation:** use each archived message's publication time, not download time. Store raw and normalized values.
5. **Full pagination:** scan past the first visible page; request failures never imply end-of-channel.
6. **Deduplication:** stable identities based on server, channel, message, and attachment identity; avoid duplicate downloads.
7. **Explicit partial results:** track unavailable originals, failed thumbnails, skipped pages, and incomplete scans in manifests.
8. **Resume:** persist progress and queue state across service-worker/browser restarts.
9. **Local-first:** no external backend, Docker, paid API, or cloud storage is required.
10. **Constrained network access:** minimum necessary host permissions, rate limiting, capped retries, and no unrelated third-party cookie forwarding.

## 3. Confirmed reconnaissance and unanswered questions (2026-10-09)

This section supersedes earlier speculative endpoint/header advice. Findings came from the user's **actual Brave/Chromium DevTools console, exported channel JSON, and saved rendered HTML**. Revalidate before deployment; the site may change. Do not mistake a website `200` status for validated JSON, or an archival URL for a working file download.

### 3.1 Working API calls and crucial `Accept` header

The tested API expects the unusual `Accept: text/css` request header. Sending `Accept: application/json` to the channel API returned HTTP **403** with the server's explanatory text: `If you want to scrape, use "Accept: text/css" ...`. With `Accept: text/css`, the user successfully obtained JSON arrays for channel messages, despite the response being reported as `Content-Type: text/css; charset=utf-8` on other tested endpoints. **Parse the response body as JSON conditionally; never rely solely on Content-Type.** This is a site-specific, explicitly indicated request format, not permission to bypass authentication, rate limits, or access controls.

| Endpoint | Observed result | Role |
|---|---|---|
| `GET /api/v1/discord/server/1217290220718915654` | 200 and parseable metadata with `Accept: text/css` | Discover server name, channels, parent relationships, types, `post_count` |
| `GET /api/v1/discord/channel/1268995994440302725?o=0` | 200 and message array with `Accept: text/css` | Main metadata source for tested channel |
| Same channel URL with `Accept: application/json` | 403 `application/octet-stream` response | Known failure mode; avoid mistaking for outage |
| `GET /api/v1/search_hash/{sha256}` | 200 and JSON file metadata with `Accept: text/css` | Optional verification of MIME, bytes, post cross-links |
| `GET /api/v1/file/{sha256}` | 404 for tested hash | Not a usable media/metadata path in our test |
| `GET /api/v1/file/235855035` | 400 `Invalid SHA256 hash` | Numeric file IDs not supported there |
| `/api/v2/file/{hash-or-id}` and `/api/v1/files/{id}`, `/api/v2/files/{id}` | 404 in tests | Do not use |

Minimal console reproduction **from a Kemono page**:

```js
(async () => {
  const response = await fetch(
    '/api/v1/discord/channel/1268995994440302725?o=0',
    { credentials: 'same-origin', headers: { Accept: 'text/css' } }
  );
  const body = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 160)}`);
  const posts = JSON.parse(body); // Content-Type may misleadingly say text/css
  if (!Array.isArray(posts)) throw new Error('Unexpected channel response shape');
  console.log('messages', posts.length, 'first message', posts[0]);
})();
```

**Extension networking gate:** validate that the same request works from the MV3 service worker with appropriate `host_permissions`, and determine whether cookie/caching/origin behavior differs from a same-origin page. Keep a content-script/page-context API adapter as a fallback only when legitimate browser security boundaries permit it. Never copy cookies or session tokens into log files, fixtures or exports. Never inject page scripts to circumvent anti-abuse controls.

### 3.2 Verified server response and message schema

The server endpoint returned `id`, `name`, `indexed`, `updated` and `channels[]`. Channel objects included `id`, `server_id`, `name`, `parent_channel_id`, `topic`, `type`, `is_nsfw`, `position`, and `post_count`. The tested metadata showed `updated: 2026-03-21T11:49:55.636050`. The channel `1268995994440302725` had `post_count: 31` in server metadata, while the independent exported rendered page showed **32 message containers**. Therefore, **do not assume `post_count` equals rendered message count or attachment count**; record discrepancies without fabricating a resolution.

The live channel API response was a **top-level array**. A message had these 13 keys:

```text
id, author, server, channel, content, added, published, edited,
embeds, mentions, attachments, seq, revisions
```

Each inspected image attachment exposed **only** `name` and `path`:

```json
{
  "id": "1268995994440302725",
  "server": "1217290220718915654",
  "channel": "1268995994440302725",
  "published": "2024-08-02T18:17:01.88",
  "attachments": [
    {
      "name": "bird_01.png",
      "path": "/82/79/8279311a88d313cf25b6f1ad302ac7f82203f9712829b82785b0b3fac3e0871e.png"
    }
  ]
}
```

The example is a **field-level excerpt** from real responses, not a claim that the original message had no other fields or attachments. The archived forum/thread starter's message ID happens to equal its thread/channel ID; do not confuse them generally. **All Discord snowflakes remain strings.**

The exported DOM scan recovered **32 message elements and 57 media attachments** for this test page. Its only discovered `cdn.discordapp.com` references were an avatar and an emoji, not media attachments. The user checked `embeds` and `revisions` in the channel response and found no populated examples. **Original Discord attachment IDs and CDN URLs were not exposed.** Do not guess, manufacture or brute-force attachment IDs. No Discord-server authentication is assumed or required by the thumbnail tool.

### 3.3 Thumbnail URL mapping and cross-origin limitation

For the tested attachment, the API storage path can be mapped as follows:

```text
API attachment.path:
/82/79/8279311a88d313cf25b6f1ad302ac7f82203f9712829b82785b0b3fac3e0871e.png

Observed thumbnail URL:
https://img.kemono.cr/thumbnail/data/82/79/8279311a88d313cf25b6f1ad302ac7f82203f9712829b82785b0b3fac3e0871e.png

Rendered original storage URL (currently unavailable; do not mistake for Discord CDN):
https://n3.kemono.cr/data/82/79/8279311a88d313cf25b6f1ad302ac7f82203f9712829b82785b0b3fac3e0871e.png
```

Canonical construction for **valid `/xx/yy/{64hex}.{extension}` image paths**:

```ts
const makeThumbnailUrl = (path: string): string | null => {
  if (!/^\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}\.(png|jpe?g|webp|gif|avif)$/i.test(path)) return null;
  return `https://img.kemono.cr/thumbnail/data${path}`;
};
```

That allowlist is intentionally conservative and may require extending after testing other real formats; for unsupported paths use observed DOM URLs or mark unresolved. Accept only HTTPS and the expected hostname. Avoid unsafe URL concatenation, relative traversal and arbitrary download hosts.

**CORS finding:** JavaScript `fetch()` on origin `https://kemono.cr` fetching `https://img.kemono.cr/...` failed because the thumbnail server did not return `Access-Control-Allow-Origin`. The same image URL was successfully fetched **from an `img.kemono.cr` tab**. Extension architecture must test cross-origin fetches under MV3 host permissions or use `chrome.downloads.download()` where permissible; do not disable browser CORS/security. Rendering `<img>` may work even where JavaScript cannot inspect its bytes.

The tested `bird_01.png` thumbnail was **55,959 bytes**, SHA-256 `eb1d7a6022f5772f1e7b8cf8d94223b271601c43dc15b29ef6899d5f7aadab43`. Kemono's hash index reported the distinct original as **1,236,275 bytes**, hash `8279311a88d313cf25b6f1ad302ac7f82203f9712829b82785b0b3fac3e0871e`. Therefore **never reject a valid thumbnail because its checksum differs from the original-file hash**; original and preview are different byte sequences. A content hash alone cannot be decrypted into a Discord attachment URL.

### 3.4 Hash lookup: optional metadata enrichment only

`GET /api/v1/search_hash/8279311a88d313cf25b6f1ad302ac7f82203f9712829b82785b0b3fac3e0871e` returned fields:

```text
id, hash, mtime, ctime, mime, ext, added, size, ihash,
flags, posts, discord_posts
```

Example: `id: 235855035`, `mime: image/png`, `size: 1236275`, `posts: null`; `discord_posts` referenced the matching archived message and its `name`/`path` attachments. It did **not** reveal a Discord attachment ID or original CDN URL. Hash lookups should be **optional, bounded, and cached**, not 57 extra requests for every channel by default; only use to enrich selected files, investigate discrepancies, or validate known-size recovery candidates.

### 3.5 Things not yet verified; Phase 0 follow-up checklist

- Actual API offset/pagination semantics, page size, ordering, empty-page terminal behavior, and whether `?o=0` is equivalent to an omitted offset.
- Whether the MV3 service worker can retrieve JSON and thumbnail bytes with minimally scoped permissions; the browser-console evidence does **not** prove extension integration.
- All supported image extensions, content types and lazy-loading variants across **multiple** channels.
- Whether each forum/thread channel has a reliable `post_count` and how replies are indexed.
- Whether multiple thumbnail hostnames or URL patterns are needed for legacy archives.
- Download filenames and browser behaviors for `Content-Type: text/css` API JSON and cross-origin media URLs.
- Stable deduplication across overlapping pages, edited posts, and different channels linking the same file.

**Phase 0 exit gate:** keep this proven sample as the baseline; collect a sanitized real channel-API response and HTML fixture, then validate the **MV3 networking and multi-page pagination**. Do not claim a complete channel/server rip until the paging and download tests pass.

## 4. Architecture

```text
Popup / Full Dashboard
         |
Extraction Controller (background orchestration)
         |
  +------+------+
  |             |
API Adapter   Content-script DOM Adapter
  |             |
  +------+------+
         |
Media Normalizer + Deduplicator
         |
Media Resolver (original / thumbnail / observed candidates)
         |
Persistent Queue (IndexedDB) + Checkpoints
         |
Downloads API / Exporter / Manifest
         |
Server/Channel/UTC-timestamped files
```

The adapters must independently output normalized records. The controller merges them. Do not couple API parsing to DOM selectors or download mechanics.

### Technology choices

- Manifest V3, TypeScript, Vite.
- Vanilla HTML/CSS/TypeScript UI initially, avoiding unnecessary frameworks.
- IndexedDB for jobs, media records, and checkpoints.
- `chrome.downloads` for browser-managed file downloads.
- `fetch`, `DOMParser`, `MutationObserver` where appropriate and permission-compliant.
- Vitest for unit tests; Playwright for browser/integration scenarios.
- A dedicated dashboard for long-running job monitoring.

Manifest V3 background service workers may be suspended. Persist state before relying on it, reconstruct queue progress on startup, and do not assume a popup remains open during downloads.

## 5. Functional design

### 5.1 URL recognition and scope

Parse `/discord/server/{serverId}/{channelId}`. Display detected IDs and permit the user to scan current channel. If server metadata is available, enumerate channel names and IDs for per-channel selection or an entire-server job. When server metadata is unavailable, preserve current-channel mode.

Sanitize displayed channel names before forming filesystem paths. Preserve raw names in manifests.

### 5.2 Message extraction and pagination

1. Initialize cursor/offset for the chosen channel.
2. Fetch the next API page using verified parameters.
3. Validate response shape; retain timestamp, message ID, attachments, and message content as needed.
4. Extract attachments and supported Discord CDN image URLs from content.
5. Normalize and upsert identified media records.
6. Persist cursor and page status only after successful processing.
7. Advance according to observed pagination semantics.
8. End only after a verified terminal condition, not after a request error.

For failures, persist the failed page and retry with bounded exponential backoff. Distinguish rate limiting, server errors, permission failures, and actual end-of-channel.

### 5.3 DOM fallback

Identify archived message containers; associate image elements and anchor targets with message IDs/timestamps whenever possible. Inspect `src`, `srcset`, validated lazy-load attributes, and media anchors. Optionally inspect CSS backgrounds inside verified media containers. Avoid blanket grabbing all site images: exclude avatars, reactions, emoji, navigation icons, and logos.

DOM results may be incomplete when only part of a channel is rendered. Label coverage accurately. A DOM-only record with no verified message ID uses a temporary source-based identity and flags its provenance.

### 5.4 Normalize and merge media

Recommended TypeScript representation:

```ts
interface MediaRecord {
  serverId: string;
  serverName: string | null;
  channelId: string;
  channelName: string | null;
  messageId: string | null;
  publishedRaw: string | null;
  publishedAtUtc: string | null;
  attachmentIndex: number;
  attachmentId: string | null; // unavailable in tested Kemono API; do not fabricate
  originalFilename: string | null;
  kemonoPath: string | null; // API attachments[].path
  kemonoFileHash: string | null; // extract only from verified hash-format paths
  originalUrl: string | null; // Kemono full-res storage, if observed; NOT Discord CDN
  discordCdnUrl: string | null; // only when explicitly present in genuine source content
  thumbnailUrl: string | null;
  resolvedUrl: string | null;
  mediaType: "image" | "video" | "unknown";
  sourceType: "api" | "dom" | "merged";
  status: "discovered" | "queued" | "downloaded" | "failed" | "skipped";
  savedPath: string | null;
  errorMessage: string | null;
}
```

Canonical identity should use server ID + channel ID + message ID + attachment ordinal and/or verified attachment path hash, since the tested API has no attachment ID. Keep an ordinal even when two attachments share the same filename. Preserve individual candidate URLs and provenance where records merge. For uncertain DOM-only matches, do not overwrite high-confidence API identity.

### 5.5 Source resolution and image validation

Modes:

- **Thumbnail Only:** try confirmed thumbnail URLs and directly observed page previews; don't repeatedly hit broken original hosts.
- **Best Available:** attempt original only if explicitly enabled (default OFF because Kemono full-resolution nodes are down); otherwise prefer confirmed thumbnail. Do not generate repetitive requests to dead nodes.
- **Original Only:** optional experimental mode; warn that Kemono original nodes have been observed unavailable, attempt only at user request, and record failures without silently substituting previews.

Candidate priority must be informed by observed behavior, not invented domain transformations. For fetch-capable contexts, a successful transfer requires actual image content: non-empty body, appropriate content type or detected image signature, and successful image decoding with valid dimensions if feasible. When using `chrome.downloads`, rely on browser download state first, and optionally verify bytes separately where permitted; do not claim byte validation if the extension could not read bytes. Reject HTML errors and placeholder bodies delivered with HTTP 200. Use actual media format for filename extension.

Do not transform unsupported formats into JPEG/PNG implicitly. Preserve originals unless the user expressly requests conversion.

### 5.6 Filenames and timestamps

Prefer `YYYY-MM-DD_HHMMSSZ_{messageId}_{attachmentIndex}.{ext}` with deterministic fallbacks for missing timestamps or IDs. Use UTC and keep original published timestamp in the manifest. If two attachments still collide, append a stable unique token; do not silently overwrite files.

Store image source URL, saved path, chosen quality, success/failure, and a content hash when feasible. Never use today's date as a fake post timestamp.

### 5.7 Exports

Support:

- JSON metadata manifest (include `publishedRaw`, `kemonoPath`, `kemonoFileHash`, thumbnail URL, status and source provenance).
- CSV of media links, dates, channel IDs, message IDs, original and thumbnail URLs, statuses.
- Downloaded images organized by server and channel.

Track job totals: channels scanned, message pages scanned, media discovered, downloaded, failed, skipped, and incomplete. Support link-only export without downloading.

### 5.8 Downloads and resume

Queue should have conservative concurrency defaults (e.g. one metadata API request per channel and two parallel image downloads, subject to site behavior). Back off on 429 and honor `Retry-After`. Cap retries/timeouts; record permanent failure without blocking the rest.

Use IndexedDB checkpoints for completed message pages and download events. The `chrome.downloads` API writes relative paths within the browser's configured downloads location; arbitrary filesystem folder selection is a separate optional feature requiring explicit permission and compatible browser APIs. Do not claim that a simple `chrome.downloads` call can select any local destination.

For whole-server jobs, process channels independently so one bad channel does not corrupt others. When resuming, avoid re-downloading completed media but permit manual re-verification of files removed externally.

## 6. UI specification

### Popup

- Detect server/channel from active tab.
- Choose current channel vs selected/whole server (when discovery works).
- Choose Thumbnail Only / Best Available / Original Only.
- Actions: **Scan Links**, **Export Links**, **Download Images**, **Open Dashboard**.
- Clear warnings for inaccessible APIs, partial coverage, and missing originals.

### Dashboard

- Channel selection and per-channel progress.
- Counters for page scans, discovered media, completed/failed downloads.
- Filterable thumbnail preview gallery (later enhancement).
- Pause/resume/cancel and export manifest/failures.
- Source provenance and helpful errors for each failed item.

The **Scan Links** function is core functionality, not an optional enhancement.

## 7. Implementation phases and exit gates

### Phase 0 — Reconnaissance and extension-context proof

**Build:** Seed `docs/API_RECON.md` from Section 3; inspect live page/API/DOM, capture sanitized fixtures, verify network calls from a real MV3 service worker, and test at least two offsets and one second channel.  
**Done when:** known-good sample is reproducible, thumbnail downloading succeeds in-extension, and pagination behavior is measured; unverified assumptions are labeled.

### Phase 1 — Extension scaffold

**Build:** Manifest V3, TypeScript/Vite, popup, service worker, content script, supported-host permissions, URL parser.  
**Done when:** loadable unpacked extension correctly displays the example server and channel IDs.

### Phase 2 — Single-channel metadata scanner

**Build:** API adapter with `Accept: text/css` and robust JSON body parsing, verified pagination, message normalization, timestamp parsing, media enumeration, IndexedDB storage.  
**Done when:** one multi-page channel can be indexed without downloading and without duplicate records.

### Phase 3 — Thumbnail/DOM recovery and link export

**Build:** DOM scanner for `[id^="message-"]`, media anchor/`img` pairs (not avatars), verified thumbnail URL mapping from `attachments[].path`, API/DOM merge, CSV/JSON export, optional link previews.  
**Done when:** users can collect and export available thumbnail links even if originals are unavailable. Mark partial scans honestly.

### Phase 4 — Single-channel downloads

**Build:** thumbnail-only queue, content validation, output filenames, download events, manifests, failure tracking.  
**Done when:** a selected channel saves usable images into a dedicated directory without overwrites or false success.

### Phase 5 — Whole-server mode

**Build:** channel discovery, selection, per-channel checkpoints, server directory, multi-channel orchestration.  
**Done when:** accessible channels save into separate folders with complete manifests and per-channel failures.

### Phase 6 — Resilience

**Build:** pause/resume/cancel, service-worker restart recovery, retries, timeouts, 403/404/429/5xx handling, partial-run export.  
**Done when:** a browser/worker interruption does not silently lose the archive job.

### Phase 7 — Optional extras

**Build:** best-available mode, original-only mode, date filtering, gallery, explicit directory picker/ZIP export.  
**Done when:** each extra is independently tested and does not regress thumbnail-only mode.

## 8. Repository layout

```text
kemono-discord-ripper/
├── README.md
├── AGENTS.md
├── package.json
├── tsconfig.json
├── vite.config.ts
├── docs/
│   ├── ARCHITECTURE.md
│   ├── API_RECON.md
│   ├── DATA_MODEL.md
│   ├── DOWNLOAD_POLICY.md
│   └── TEST_PLAN.md
├── src/
│   ├── manifest.json
│   ├── background/
│   │   ├── index.ts
│   │   ├── controller.ts
│   │   └── downloadQueue.ts
│   ├── content/
│   │   ├── index.ts
│   │   ├── domScanner.ts
│   │   └── pageObserver.ts
│   ├── api/
│   │   ├── kemonoClient.ts
│   │   ├── serverAdapter.ts
│   │   └── channelAdapter.ts
│   ├── core/
│   │   ├── urlParser.ts
│   │   ├── mediaNormalizer.ts
│   │   ├── mediaResolver.ts
│   │   ├── deduplicator.ts
│   │   ├── filenameBuilder.ts
│   │   └── types.ts
│   ├── storage/
│   │   ├── database.ts
│   │   ├── checkpointStore.ts
│   │   └── manifestExporter.ts
│   ├── popup/
│   │   ├── index.html
│   │   ├── popup.ts
│   │   └── popup.css
│   └── dashboard/
│       ├── index.html
│       ├── dashboard.ts
│       └── dashboard.css
└── tests/
    ├── fixtures/
    ├── urlParser.test.ts
    ├── pagination.test.ts
    ├── mediaNormalizer.test.ts
    ├── filenameBuilder.test.ts
    └── downloadQueue.test.ts
```

## 9. Acceptance tests

- [ ] Parses verified sample URL IDs as exact strings.
- [ ] Sends `Accept: text/css` on Kemono API requests; handles JSON even if response declares `text/css`.
- [ ] Handles the documented `403` result for `Accept: application/json` as an API header failure, not an empty channel.
- [ ] Normalizes `{ name, path }` attachment records without inventing Discord attachment IDs.
- [ ] Constructs thumbnail URL for `bird_01.png` exactly as documented in Section 3.
- [ ] Handles unavailable cross-origin `fetch` without disabling browser security.
- [ ] Does not compare the thumbnail SHA-256 to the original Kemono file hash as a validity test.
- [ ] Works on single channel if server metadata endpoint fails.
- [ ] Scans beyond first message page without duplicate/missed records.
- [ ] Does not mark a failed API page as end-of-archive.
- [ ] Preserves raw and UTC-normalized message timestamps.
- [ ] Extracts API attachments plus inline image links.
- [ ] Recovers image links from visible DOM thumbnails.
- [ ] Excludes avatars, UI imagery, logos and emoji.
- [ ] Exports links and metadata without any download.
- [ ] Saves working thumbnails when originals fail.
- [ ] Rejects HTML error responses disguised as images.
- [ ] Creates correctly grouped server/channel directories.
- [ ] Avoids overwriting attachments posted in the same second.
- [ ] Supports rate limits, retries and explicitly logged failures.
- [ ] Resumes a job after Manifest V3 worker suspension/restart.
- [ ] Scans multiple channels independently.
- [ ] Marks partial runs and unresolved media as incomplete.
- [ ] Passes unit tests, type checks, build and manual browser smoke test.

## 10. Coding agent working protocol

At each phase:

1. Read this document, `AGENTS.md`, and any phase-specific docs.
2. Restate current phase, assumptions and narrow acceptance targets.
3. Implement the smallest independently testable slice.
4. Add tests using real sanitized fixtures wherever possible.
5. Run TypeScript type checking, unit tests and build.
6. Document actual results, remaining risks, and manual browser test instructions.
7. Do **not** claim completion unless its phase exit gate is met.
8. Do not move to the next phase until the present phase is validated.

Never invent site responses, silently hardcode an assumed HTML structure, or claim a fixture-based test proves current server behavior. Favor adapter modules and documented compatibility changes.

### First instruction for a fresh agent

> Read `KEMONO_DISCORD_RIPPER_AGENT_BLUEPRINT.md` in full, especially the **verified 2026-10-09 findings in Section 3**. Begin with **Phase 0 only**: implement and test the Kemono API adapter using `Accept: text/css`, compare an authenticated browser-page request with an MV3 service-worker request, verify thumbnail downloads, and measure channel pagination. Create `docs/API_RECON.md` with confirmed results and unknowns, using sanitized fixtures if the site is inaccessible. Do not attempt to reconstruct private Discord attachment IDs or start whole-server downloads before this phase passes.

## 11. Reference material

These are research starting points; confirm current behavior independently and respect source licenses:

- Kemono API documentation: <https://kemono.cr/documentation/api>
- gallery-dl Kemono extractor: <https://github.com/mikf/gallery-dl/blob/master/gallery_dl/extractor/kemono.py>
- KemonoDownloader: <https://github.com/VoxDroid/KemonoDownloader>
- Discord-image fix userscript (potential historical clues): <https://sleazyfork.org/en/scripts/570090-fix-kemono-discord-images/code>

## 12. MVP priority

**MVP 1:** from the verified channel API, collect every discoverable thumbnail URL using `attachments[].path`, with timestamp, message ID, original filename, and JSON/CSV export.  
**MVP 2:** download those thumbnails to a deterministic channel folder with a manifest.  
**MVP 3:** iterate all accessible channels in one server, with durable checkpoints.

**Core architectural constraint:** metadata discovery and downloads must stay separate. This lets the extension remain useful as an archive indexer during media-server outages.

## 13. Verified test fixture and known limitations (agent handoff)

The user has real local evidence that can seed tests. Prefer sanitized fixture copies, not screenshots or manually invented API responses:

- Saved rendered HTML: `Original Characters (Miscellaneous) — Dangpa's Art _ Kemono.html` (may contain account/navigation information; sanitize first).
- DOM-derived JSON: `kemono-1268995994440302725-recovery.json` (32 rendered message records; 57 media URLs).
- Server metadata JSON/text: `Pasted text(3).txt` (channel names, IDs, hierarchy, `post_count`).
- Console-proven channel API messages: exact top-level array and attachment `name` / `path` schema described in Section 3 (obtain a **sanitized actual API response** for the repository test fixture; the DOM-derived JSON is not a replacement for raw API JSON).

### Deterministic fixture assertions

1. URL input `https://kemono.cr/discord/server/1217290220718915654/1268995994440302725` yields two exact string IDs.
2. The known `bird_01.png` attachment belongs to message ID `1268995994440302725` and maps `/82/79/...png` to `https://img.kemono.cr/thumbnail/data/82/79/...png` without changing the hash.
3. A channel response must be an array of messages, each supporting `published`, `id`, `attachments`; handle missing or empty optional fields gracefully.
4. No `attachment.id`, `attachment.url` or source Discord `cdn.discordapp.com/attachments/` URL may be synthesized.
5. A matching file-hash metadata `size` of 1,236,275 bytes must not cause rejection of the independently fetched 55,959-byte thumbnail.
6. Successful API JSON under a misleading `text/css` response MIME is correctly parsed; 403/404/429 and malformed data are not treated as end-of-pagination.
7. The user's **32 DOM messages / 57 image attachments** are reference counts for that saved page, **not** a guaranteed count for all future pages or a promise that every download succeeds.

### Security and correctness guardrails

- Do not include login cookies, `session` values, anti-bot tokens, IP addresses, or private request headers in logs, screenshots, repository fixtures, exports or bug reports. A previous raw request included a session cookie; do not reuse it.
- Only retrieve archived material already available to the requesting browser and explicitly selected by the user; respect authorization requirements and site restrictions. No credential harvesting, Discord self-bot scraping, attachment-ID brute force, or rate-limit circumvention.
- Use safe relative `chrome.downloads` filenames; sanitize Windows-reserved names and path separators; maintain stable index and UTC timestamps.
- Respect sources of uncertainty: `search_hash` is an index, not a file restoration service; `n1`–`n4` URLs are Kemono storage pointers and may be dead; a CDN avatar/emoji hit is not an image attachment.
- Treat downloaded filenames, message text and channel names as untrusted data: escape UI insertion, prevent path traversal, and keep logs free of secrets.

**Project success criterion:** users can reproducibly index a selected Kemono Discord channel, export complete available metadata, and download its *surviving thumbnails* into deterministic server/channel folders. Recovery of lost original-resolution media or inaccessible private Discord attachments is **outside the MVP** and must never be promised.
