# Changelog

## 0.7.0 — 2026-10-16

- List detected file extensions after scanning, including custom extensions, compound TAR formats and unknown files. Select or deselect each type; all are selected initially and new types stay selected during sync.
- Add optional ZIP, 7z, RAR4/RAR5 and compressed TAR extraction in a dedicated worker. Keep only extracted contents after success; retain compressed files and report errors after failed, encrypted or unsupported extraction. Retry extraction without downloading an existing source again.
- Save content/type/extraction choices in `settings.json` in ZIPs and creator folders. Restore them on folder connection. Older archives default to all file types with extraction off and receive settings on their next sync.
- Record extracted outputs in sync history. Verify their existence/size before skipping transfers, recover missing outputs, and persist recovery metadata before removing a successfully extracted compressed source.
- Preserve uncommon image originals served as binary and explicitly named HTML/JSON attachments. Include bundled decoder assets and license notices in the release.
- Add tests for settings migration, filtering, safe decoding, original retention/removal, and extracted-only sync, plus a controlled browser extraction and settings check.

## 0.6.1 — 2026-10-15

- Replace the five-minute overall media timeout with a 90-second inactivity deadline so healthy large ZIP/PSD downloads can finish. Bound image validation separately and close late bitmap results after cancellation.
- Show current filenames, received bytes, advertised sizes, validation and retry waits while completed-file counts remain unchanged.
- Prioritize text/images before source archives fill the pool. Batch transfer status reads, durable completion writes and queue starts to reduce database/message overhead, preserving results before releasing them.
- Reproduce the reported Fanbox creator's exact 788-task workload (460 images, 166 files, 162 texts). Nearby ZIP/PSD files are approximately 230–246 MB and currently return HTTP 200; the saved-file count alone cannot establish a frozen queue.
- Add healthy transfers longer than five minutes, stalled streams, cancellation, late image decoding, byte progress and scheduling regression tests, plus browser coverage for visible partial-transfer progress.

## 0.6.0 — 2026-10-15

- Continue discovery past missing post details and isolated pages that fail after retries. Keep useful list metadata and good records on partly invalid pages; never include records from a different creator/service.
- Persist skipped post/page errors with source, reason, status, attempts and time. Include discovery errors alongside media errors in ZIP and folder `failures.json`; show the error count in the overlay and retain expected totals when gaps remain.
- Add **Skip this error** for paused discovery and let **Retry failures** revisit completed scan gaps without restarting pagination. Existing saved folder files and successful sync history remain reusable; recovered posts can then be saved automatically.
- Keep access failures and rate limits paused, and stop automatic skipping after three consecutive bad pages. Support report-only exports when a missing single post has no available content.
- Add scan-tolerance unit coverage and a browser acceptance check for mixed failures, ZIP/folder reports, recovered gaps and manual skip.

## 0.5.2 — 2026-10-15

- Retry malformed successful API responses and interrupted response bodies with the existing bounded backoff instead of immediately pausing discovery. Keep the scan cursor and earlier posts until a complete response validates.
- Try the alternate post-list endpoint at the same offset when JSON is unreadable or a request is interrupted. HTTP rate limits and structured validation errors retain their normal handling.
- Add regression coverage for recovery at 1150/3349 posts, repeated failures, cooldowns, retained progress, manual retry, and browser recovery when both list endpoints initially return truncated JSON.

## 0.5.1 — 2026-10-15

- Accept Pawchive post IDs with the `p-` prefix in creator scans, single-post links, detail requests, and native/legacy sync history. Creator and service matching still apply.
- Fix the reported Patreon creator scan stopping at offset 450 on `p-1237087`. Existing paused jobs can Resume or Retry failures from their saved page without losing earlier posts.
- Report invalid post IDs separately from creator/service mismatches. Add scan recovery tests and browser coverage for prefixed IDs in ZIPs and folder sync.

## 0.5.0 — 2026-10-11

- Select individual posts on creator profiles with checkboxes, Clear selection, and All posts. Selections persist across progress refreshes and job reloads.
- Keep the current single-post scope or selected creator subset when connecting a creator folder, choosing sync.json, or importing history. Previously sync-file connection and history import silently expanded single-post jobs to the entire creator.
- Extend an extracted ZIP with only newly selected posts while retaining earlier files and cumulative sync history. Repeat saves verify existing files and avoid duplicate media downloads. Whole-creator rescans remain available through All posts and Sync folder.
- Include only chosen posts in ZIP media and manifest metadata. Shared sync history keeps its creator-wide identity; it does not carry a job's post filter into other jobs.
- Add permanent scope regression tests, a controlled browser check for ZIP extraction and selective folder continuation, and a release gate that verifies packaged bytes and version agreement.
- Upgrade Vitest to 5.0.3 to resolve the dependency audit findings. Development requires a compatible Node 22.12+, 24, or 26+ release.
- Remove obsolete release ZIPs and temporary probe/test output. Keep the current production build and release ZIP.

## 0.4.3

- Add device-aware media concurrency with gradual growth, rate-limit and transient-failure backoff, persisted cooldowns, and a current-limit indicator.

## 0.4.2

- Connect an existing creator archive by choosing sync.json or a legacy manifest.json, with direct-folder identity checks and permission recovery.
