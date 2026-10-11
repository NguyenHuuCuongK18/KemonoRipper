# Post API notes

Reference: [Pawchive API schema](https://pawchive.pw/api/schema), whose Swagger UI is served at `/api/swagger_schema`. Public schema and sample metadata were inspected on 2026-10-10. No artwork or downloaded creator content was retained from these reads.

Confirmed endpoints under `/api/v1`:

- `/{service}/user/{creatorId}/profile` returns creator identity and name.
- `/{service}/user/{creatorId}?o={offset}` returns a post array, in steps of 50.
- `/{service}/user/{creatorId}/post/{postId}` returns a single post.

The sample Fanbox creator `4862787` returned 50 posts on its first page; the public profile paginator showed 118 posts. Single post `12129865` returned its title, HTML content, main `file`, `attachments`, timestamps, and `has_full` flag. Newer post records also included numeric storage `node` values and `detail_fetched`.

Observed media routing on public post pages:

- Thumbnails: `https://img.pawchive.pw/thumbnail/data{path}`.
- Originals with `node: 2`: `https://n2.pawchive.pw/data{path}?f={filename}`.
- Originals without a node: `https://file.pawchive.pw/data{path}?f={filename}`.

The implementation uses `has_full: false` to avoid promising originals for thumbnail-only imports. Missing flags mean availability must be determined by the actual transfer. API attachment paths are validated before forming these documented/observed storage URLs. Failed originals remain failures instead of silently becoming thumbnails.

The reported [Fanbox post 11312487](https://pawchive.pw/fanbox/user/24738214/post/11312487) was checked on 2026-10-10. Its API response has `attachments: []`, but its separate main `file` contains a JPEG path and `node: 2`, with `has_full: true`. The rendered page links that file on `n2.pawchive.pw`. Attachment count alone therefore cannot determine whether a post has images. A sanitized metadata fixture retains the main file and empty attachment list; it contains no artwork.

Media hosts are not limited to `n1` through `n4`. HTTPS storage URLs on the two archive domains and their subdomains are accepted with validated hashed attachment paths. Numeric API nodes can exceed four. Explicit attachment `server` metadata (hostname, origin, or full URL for that file) takes precedence over node/default routing. Inline full-resolution links update matching main-file/attachment records rather than being discarded as duplicates. Original query strings are preserved. A hostname containing the word Kemono or Pawchive elsewhere does not establish an archive domain.

The permanent acceptance suite covers the reported metadata and 22 controlled host variants, including roots, image/file hosts, current and future numeric nodes, and nested CDN subdomains. The browser check uses fixture image bytes and native extension fetch; these are compatibility checks, not evidence that each synthetic host exists or holds the reported image. Kemono test responses allow CORS so its optional host permission does not require an automated consent prompt.

Kemono uses the same post service interface, with `/user/{creatorId}/posts` support, a 404-only fallback to the older list path, and wrapped `post`/`posts` response handling. Pawchive was the live reference for this implementation; equivalent Kemono post endpoints were not live-downloaded during development.
