# Changelog

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
