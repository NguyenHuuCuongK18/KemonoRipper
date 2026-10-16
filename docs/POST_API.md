# Post API notes

Version 0.7.0 discovers file types from attachment names or stored-path extensions rather than maintaining a file-type allowlist. Unknown extensions remain downloadable. The type checklist describes advertised attachments and generated text, not yet-unread archive contents. Optional ZIP/7z/RAR/TAR extraction happens only after the source has been fully saved. It adds extracted-output identities to sync history without changing the original API attachment identity, allowing later syncs to verify contents even after successful source removal. Extraction failures retain the source and appear separately from network/discovery failures.

The Fanbox creator `19544233` was inspected on 2026-10-15 after a report of freezing at 71/788 collected files. Its 162 posts reproduce exactly 460 images, 166 other files and 162 text tasks. Around queue positions 71–73, `Com6_2026.zip` and two PSDs advertise 230,389,515, 243,387,914 and 246,234,704 bytes, with HTTP 200 and byte-range support. Sixty source attachments with readable size headers total at least 6.18 GiB; the other header results do not establish their sizes or absence. Small bounded range samples confirmed file data was available, but timing from the diagnostic machine does not measure the user's connection. The user's Pause control remained responsive. These observations support slow large-file transfers rather than an unresponsive overlay; they do not identify the exact active task in the user's browser. The old overall five-minute deadline could abort healthy slow transfers, and completed-file counts concealed their byte progress. Version 0.6.1 addresses both issues.

Reference: [Pawchive API schema](https://pawchive.pw/api/schema), whose Swagger UI is served at `/api/swagger_schema`. Public schema and sample metadata were inspected on 2026-10-10. No artwork or downloaded creator content was retained from these reads.

Confirmed endpoints under `/api/v1`:

- `/{service}/user/{creatorId}/profile` returns creator identity and name.
- `/{service}/user/{creatorId}?o={offset}` returns a post array, in steps of 50.
- `/{service}/user/{creatorId}/post/{postId}` returns a single post.

The sample Fanbox creator `4862787` returned 50 posts on its first page; the public profile paginator showed 118 posts. Single post `12129865` returned its title, HTML content, main `file`, `attachments`, timestamps, and `has_full` flag. Newer post records also included numeric storage `node` values and `detail_fetched`.

On 2026-10-15, the Patreon creator `19875180` returned post `p-1237087` at list offset 450. Both list endpoints and the single-post endpoint returned this ID with the correct creator and `patreon` service. Post IDs can therefore be numeric or use the `p-` prefix; they must remain strings throughout discovery, direct post URLs, filenames, and sync history. Creator IDs remain numeric. Previously the numeric-only post check incorrectly reported this as a creator/service mismatch, so Resume and Retry repeatedly failed on the same page.

The same creator later paused at 1150/3349 with invalid JSON. During diagnosis, one list request timed out; subsequent reads of both list routes at offset 1150 returned valid arrays of 50 posts. Malformed successful JSON responses and interrupted body reads are retried with bounded backoff. Creator lists can try the alternate route at the same offset before the retry delay. Neither malformed responses nor schema/identity validation failures count as an empty terminal page. Rate limits keep their cooldown.

From version 0.6.0, discovery records and skips an isolated page after its retry budget is exhausted, or skips missing post details while retaining available list metadata. Individual invalid records are excluded and reported while good records from that page remain available. The raw page count determines whether a validated page is empty. Missing pages advance by the normal 50-post step and keep the original expected total; the overlay and `failures.json` disclose the gaps. Access failures and rate limits pause instead of skipping, as do three consecutive failed or wholly invalid pages. A paused discovery error can be skipped manually. After traversal, Retry failures revisits the stored page offsets/post IDs and clears only recovered errors; it preserves earlier posts, scope and successful sync history.

The patched client subsequently validated all 2,199 remaining posts from offset 1150, across 44 nonempty pages and a terminal empty page at offset 3350. This matches the reported total of 3,349 posts when added to the earlier 1,150. Only API metadata was read; no media was downloaded during this live continuation check.

Observed media routing on public post pages:

- Thumbnails: `https://img.pawchive.pw/thumbnail/data{path}`.
- Originals with `node: 2`: `https://n2.pawchive.pw/data{path}?f={filename}`.
- Originals without a node: `https://file.pawchive.pw/data{path}?f={filename}`.

The implementation uses `has_full: false` to avoid promising originals for thumbnail-only imports. Missing flags mean availability must be determined by the actual transfer. API attachment paths are validated before forming these documented/observed storage URLs. Failed originals remain failures instead of silently becoming thumbnails.

The reported [Fanbox post 11312487](https://pawchive.pw/fanbox/user/24738214/post/11312487) was checked on 2026-10-10. Its API response has `attachments: []`, but its separate main `file` contains a JPEG path and `node: 2`, with `has_full: true`. The rendered page links that file on `n2.pawchive.pw`. Attachment count alone therefore cannot determine whether a post has images. A sanitized metadata fixture retains the main file and empty attachment list; it contains no artwork.

Media hosts are not limited to `n1` through `n4`. HTTPS storage URLs on the two archive domains and their subdomains are accepted with validated hashed attachment paths. Numeric API nodes can exceed four. Explicit attachment `server` metadata (hostname, origin, or full URL for that file) takes precedence over node/default routing. Inline full-resolution links update matching main-file/attachment records rather than being discarded as duplicates. Original query strings are preserved. A hostname containing the word Kemono or Pawchive elsewhere does not establish an archive domain.

The permanent acceptance suite covers the reported metadata and 22 controlled host variants, including roots, image/file hosts, current and future numeric nodes, and nested CDN subdomains. The browser check uses fixture image bytes and native extension fetch; these are compatibility checks, not evidence that each synthetic host exists or holds the reported image. Kemono test responses allow CORS so its optional host permission does not require an automated consent prompt.

Kemono uses the same post service interface, with `/user/{creatorId}/posts` support, fallback between list paths on 404 or unreadable/interrupted responses, and wrapped `post`/`posts` response handling. Pawchive was the live reference for this implementation; equivalent Kemono post endpoints were not live-downloaded during development.
