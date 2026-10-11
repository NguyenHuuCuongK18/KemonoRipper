# Release check: 0.5.0

Checked on 2026-10-11 using Windows, Node.js 26.7.0, and controlled Chromium browser scenarios.

- `npm.cmd run release:check` passed: 222 unit tests in 23 files, TypeScript checking, production build, browser regression scenarios, native media acceptance, selected-post archive continuation, packaging, and package verification.
- The selected-post browser check saved one selected post as a ZIP, extracted it, connected its `sync.json`, and added only another selected post. Repeating the save transferred no duplicate media. Connecting the same archive from a separate post page preserved that single-post scope and cumulative history.
- Native media acceptance covered 22 controlled Kemono/Pawchive hosts. These are fixture-based checks rather than a live throughput benchmark.
- `npm.cmd audit --json` reported zero vulnerabilities after upgrading Vitest to 5.0.3.
- Package, lockfile, source manifest, and built manifest all identify version 0.5.0. The release ZIP contains exactly the 18 production build files, with matching bytes and valid ZIP CRC checks.
- Removed 16 obsolete release ZIPs and temporary probe/test output. Rebuilt `dist`; temporary browser profiles and extracted acceptance archives were removed after testing.

Release artifact: `KemonoPawchiveArchiveRipper-0.5.0.zip` (175,209 bytes).

SHA-256:

```text
729398aeeb0bd21c7e67b7b1b759f9214ffcb005816813b841f78d71668240cc
```

Native operating-system file/folder dialogs and permission prompts remain a manual smoke check. Automated folder tests use real OPFS handles with picker dialogs replaced for headless execution. Reload the extension, save a small selected ZIP, extract it, connect its `sync.json` through the native chooser, and save one additional post before distributing it as a public release.
