# Kemono & Pawchive Archive Ripper

A local-first Chromium extension with two saving services: **Discord** archives and **Posts** from Patreon / Pixiv Fanbox. Click the extension on `kemono.cr` or `pawchive.pw` to open a compact overlay on the current page. It is disabled on other sites.

## Install or update

1. Open `chrome://extensions`, `edge://extensions`, or `brave://extensions` and enable Developer mode.
2. Choose **Load unpacked** and select the project's `dist` folder. For an existing installation, choose **Reload**.
3. Refresh the supported site tab and click the extension icon. No separate dashboard is needed.

`KemonoPawchiveArchiveRipper-0.5.0.zip` contains the same build; extract it before loading it. Existing jobs remain in local storage. An unpacked extension keeps using its selected directory: updating this project's `dist` will not update a separately extracted ZIP directory. Reload the extension, refresh the archive tab, and confirm version **0.5.0** on the browser's extensions page. Use **More options → Scan again** to refresh an existing job's stored media URLs.

Version 0.5.0 adds individual post checkboxes and preserves your post scope when connecting an existing creator folder, choosing `sync.json`, or importing history. A single-post page stays on that post. Selected posts from a profile stay selected. Extending an archive keeps earlier successful history without automatically downloading other posts. See [release notes](CHANGELOG.md) and the [release check](docs/RELEASE_CHECK.md).

Version 0.4.3 adjusts simultaneous downloads automatically using browser-reported CPU, approximate RAM, and connection hints. Downloads start at one or two transfers, then increase after successful media transfers, up to **8 for Posts** or **4 for Discord** on capable devices. Low-memory devices, slow connections, and Data Saver use lower limits; unavailable hardware hints retain a ceiling of two. Rate limits halve concurrency immediately and honor Retry-After; repeated network/server failures also reduce it. A cooldown prevents immediate increases, and the policy persists with the job across worker restarts. **More options** shows the current limit. More simultaneous transfers can help when latency limits throughput; server speed, bandwidth, disk speed, and image decoding still affect the result. API discovery retains its existing pacing.

Version 0.4.2 adds **Choose sync.json** directly to the creator-folder controls. Choose the archive’s history file to reconnect it. Existing folder access is reused; otherwise, **Allow archive folder** opens at the selected file’s location and verifies that the chosen folder contains that exact file. Cancellation, a different creator’s history, or a wrong folder leaves the current job unchanged. New archives still use **Choose save location**.

Version 0.4.1 fixes folder permission recovery. **Restore folder access** (or **Resume** after a permission error) opens the access tab. Click **Allow folder access** to confirm access with the download worker and resume automatically, retaining collected files. **Return to creator** brings back the original tab. Keep the access tab open until saving finishes: closing the last tab for an origin can revoke a temporary filesystem grant ([Chrome permission behavior](https://developer.chrome.com/blog/persistent-permissions-for-the-file-system-access-api)). Selecting the same folder again also preserves a paused download or pending sync.

Version 0.4 stops rapid worker polling when idle, queries browser downloads directly by ID, and uses compact job summaries for recent history and maintenance. Progress reads stay responsive while a scan request is pending. The UI polls less frequently when idle, sends smaller progress responses, and retains unchanged post rows. **Storage & history** now lists individual temporary caches and offers optional cleanup after successful ZIP saving.

## Posts

Open a creator profile, such as `https://pawchive.pw/fanbox/user/4862787`, to discover every archived post. Open a post, such as `https://pawchive.pw/fanbox/user/4862787/post/12129865`, to select that post alone. The overlay fills in the creator, platform, and scope from the current address and starts discovery. A post page also offers **Entire creator profile**.

Discovery uses one progress bar and a combined count such as **Discovered: 50/118 posts**. When no reliable total is available, it shows an animated bar until pagination finishes. Expand **Posts** to select individual posts. **Clear selection** starts with none; check the posts you want, or check **All posts** to save the entire discovered profile. The selection count and download button identify your scope. Selections persist with the job. Finish or cancel ongoing work before changing its selected posts.

Posts save full resolution by default. **Save thumbnail if unavailable** is checked initially: it saves a preview only when the archive marks an original missing or its server returns HTTP 404/410. Fallback images go in `thumbnail`, are counted in the UI, and retain thumbnail identities in `sync.json` so later syncs can still download newly available originals. Uncheck it to report missing originals instead. Images, other files, and post text can be selected separately. Post text is written to `post.txt` in `full res`; other files never use thumbnail fallback.

**Creator folder** is the default. Click **Choose save location** to open the folder chooser, then **Save to folder** (or **Save this post**). **Change folder** appears after connecting a folder. The extension creates a creator wrapper named `fanbox_CreatorId_CreatorName` or `patreon_CreatorId_CreatorName` inside that location. Quality folders and the JSON files stay inside this wrapper, with no ZIP or `ArchiveRoot` folder. Discovery and saving use the same compact progress area. Pause/resume, cancel, and retry are supported. Folder saving requires a Chromium browser with the File System Access API enabled.

```text
ChosenSaveLocation/fanbox_CreatorId_CreatorName/
  thumbnail/
    2026-01-28_PostId_PostTitle/
      001_image.jpg
  full res/
    2026-01-28_PostId_PostTitle/
      001_image.png
      002_source.psd
      post.txt
  sync.json
  failures.json
```

New post folders use `YYYY-MM-DD_PostId_PostTitle`, with publication dates normalized to UTC; absent or invalid dates use `unknown-date`. Existing saved folders keep their original names during sync, and cached jobs retain their paths until a new download is started. Missing files without a successful fallback are recorded in `failures.json`. Rate limits and server/network failures retain bounded retries and never trigger thumbnail fallback. Stored attachment bytes are preserved, and decoded image formats determine image filename extensions. External embeds are recorded in selected post text rather than fetched from other websites.

## Sync an existing creator archive

To collect only a few posts from the same creator:

1. On the creator profile, expand **Posts**, click **Clear selection**, and check the posts to save. Alternatively, open one post directly.
2. Choose **ZIP file** and save the selected posts. Extract the ZIP so its creator folder contains `sync.json`, `full res`, and any thumbnails.
3. Choose the next posts on the profile, or open another post from that creator. Choose **Creator folder → Choose sync.json**, select the extracted archive's history, and allow its folder. **Change folder** can connect that extracted creator folder directly too.
4. Use **Save selected posts** or **Save this post**. Only those posts are checked and downloaded; earlier successful files and their history remain. Choosing archive history does not switch to the whole profile or select additional posts.

For an entire creator sync, explicitly use the creator profile with **All posts** selected:

1. Open the creator's Patreon or Fanbox profile and click the extension.
2. Click **Choose sync.json**, then select the archive’s `sync.json` in the access tab. An older post `manifest.json` is also accepted. `failures.json` records failures and cannot identify successful downloads.
3. If requested, click **Allow archive folder**. The picker opens at the file’s location; approve the folder containing it. An existing connection with write access skips this step. Keep the access tab open and use **Return to creator**.
4. After discovery finishes, choose **Sync folder**. Existing successful files are checked by relative path and byte size; missing files, new posts, and newly selected quality/content types are downloaded into the same structure. Unrelated files are retained, and filename conflicts use a suffix.

Choosing a file grants access to that file; writing neighbouring media still needs folder access. The browser’s [`startIn` option](https://wicg.github.io/file-system-access/#starting-directory) lets the permission picker open in the chosen file’s parent folder. A copied JSON outside the archive cannot grant access to the original archive. Select the file inside the extracted archive; older layouts such as `ArchiveRoot/fanbox/CreatorId_CreatorName` remain supported. **More options → Import history only** remains available to import history separately before choosing a destination.

`sync.json` updates after successful writes and keeps earlier download history. Failed or unavailable files are not recorded as downloaded. You can also simply choose an existing creator folder: its `sync.json` or older `manifest.json` is detected automatically. Later **Sync folder** runs scan for new posts before saving when **All posts** is selected. Saving a subset or a single post keeps that scope. The JSON belongs to one website, creator, and platform; mismatches are rejected. Importing history does not expand the post scope. This does not sync a whole website.

ZIP remains available under **Save to → ZIP file** for separate exports. New post ZIPs use the same single `fanbox_CreatorId_CreatorName` or `patreon_CreatorId_CreatorName` wrapper without `ArchiveRoot`, and include `manifest.json`, `sync.json`, and `failures.json`. Extract before syncing into a folder. Selecting an existing creator archive reuses that directory rather than nesting another wrapper inside it; older folder layouts remain usable.

Older saved post jobs also use this single creator wrapper when their ZIP is rebuilt or saved again. A cached ZIP with the old `ArchiveRoot/fanbox` or `ArchiveRoot/patreon` layout is repackaged from the collected files before saving. Attachment bytes and successful download history are retained.

## Discord

Open a `/discord/server/{serverId}` or `/discord/server/{serverId}/{channelId}` URL. The overlay selects the server or current channel automatically. A channel page also offers **Entire Discord server**. Scanning uses the existing API pagination and visible-page recovery. Progress is summarized without channel-by-channel rows.

Thumbnails remain the default. Full resolution requires an observed original URL; **Best available** can fall back to previews. New Discord jobs save under `ArchiveRoot/discord`; existing jobs retain their previous paths. Downloading defaults to a single ZIP.

## Local storage

Jobs, imported sync history, folder handles, and scan cursors persist locally in IndexedDB. Images and arbitrary post files stream to private local extension storage. Folder downloads copy validated files to the chosen folder, then discard their temporary copies after saving the sync index. ZIP packaging reads staged files without collecting an entire archive in memory. There is no server component. Local free space limits the archive size; ZIP exports need temporary space for staged files plus the ZIP.

Temporary ZIP data expires after **5 minutes without use**, with a check every minute while the browser runs and another check when the extension starts. Change the interval to **1–10 minutes**, or disable automatic cleanup, under **Storage & history**. Opening/rebuilding a ZIP or reading/writing staged files refreshes its idle timer; viewing progress alone does not. Active jobs, ZIP saves, and paused downloads are protected. Idle orphaned caches are cleaned too. Downloaded ZIPs, creator folders, sync JSON, and job discovery history are retained. After expiry, **Save ZIP again** disappears; downloading again prepares a new temporary ZIP. Browser sleep or a closed browser can delay a check until the extension runs again.

Download ticks query indexed active jobs and pending ZIP saves. When idle, the worker stops its fast timer and relies on commands and browser alarms to wake it. Browser download events query matching jobs/files by download ID instead of scanning all saved history, and unrelated download progress events are ignored. Recent history and maintenance use a compact summary store. The UI refreshes active progress every second and idle jobs every five seconds, pauses polling while hidden, and updates post rows only when their contents change.

Open **Storage & history** in the overlay to manage local data:

- **Temporary caches** lists cached ZIPs and staged files across Posts and Discord, including unused caches without a job. Each row shows its size, file count, and last-use time. Use **Refresh** to inspect storage again. **Remove** clears only that cache after confirmation. Active and paused jobs are protected; finish or cancel a job before removing its cache.
- **Clear temporary data after a successful ZIP download** is optional and off by default. It removes staging files and the private ZIP copy only after Chrome confirms a complete download. Interrupted or cancelled saves retain their cache. Cleanup failures retain the successful download status and retry during maintenance; already completed caches are also eligible on the next check.
- **Clear this ZIP cache** removes the current ZIP job's temporary files after confirmation. Successful jobs keep their saved status, counts, and history; another export needs to download the files again. Unsaved exports return to a state where they can be downloaded again.
- **Remove this job** stops that job and removes its history and cached files. Its folder connection is forgotten when no other job uses it.
- **Clear all extension data** stops all jobs across Posts and Discord, removes their history and imported sync history, forgets saved folder connections, and removes all temporary files, including orphaned caches.

Removing a cache, removing a job, or clearing all data requires confirmation in the overlay. Downloaded ZIPs, saved archive folders, and their `sync.json` files stay on disk. Clearing all data also resets cleanup preferences. After removing a job, **Scan this page** starts a new one; existing archives can be connected again through the folder chooser or sync import. A browser restart can resume retained jobs and file collection; interrupted final saves can be retried from retained caches.

## Development

Use Node.js 22.12+, 24, or 26+ in the supported even-numbered release ranges in `package.json`. Vitest 5 replaces vulnerable older test tooling; its requirements are documented in the [migration guide](https://vitest.dev/guide/migration/).

```powershell
npm.cmd ci
npm.cmd run check
npm.cmd run test:browser
npm.cmd run test:acceptance
npm.cmd run test:selection
npm.cmd run package
npm.cmd run release:verify
```

`npm.cmd run release:check` runs the complete local release gate: unit tests, type checking, a fresh production build, all three controlled browser checks, ZIP packaging, and byte-for-byte package verification. Run `npm.cmd audit` separately when connected to the npm registry. Only the current release ZIP is retained in the repository; `dist`, dependency installs, profiles, and generated test outputs are ignored.

`check` runs the existing unit suite, TypeScript checking, and the production build. The browser checks use isolated Chromium profiles, controlled API/media responses, real ZIP downloads, and actual directory writes through an OPFS directory handle replacing the native OS picker. They check legacy imports, incremental sync, missing-file recovery, creator/path validation, folder permission recovery, and the selected-post ZIP-to-folder workflow. Profiles and downloaded test content are removed in cleanup blocks. Native OS dialogs still require a manual check. No whole live creator archive is downloaded for testing.

See [architecture](docs/ARCHITECTURE.md), [post API notes](docs/POST_API.md), and [download policy](docs/DOWNLOAD_POLICY.md).
