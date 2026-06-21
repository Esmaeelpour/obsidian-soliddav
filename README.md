# SolidDAV

Reliable WebDAV sync for Obsidian.

SolidDAV is a standalone fork of [WebDAV Sync](https://github.com/hesprs/obsidian-webdav-sync)
by Hēsperus (AGPL‑3.0), focused on robustness and a friendlier setup. It keeps
the original's strong foundation — three‑way merge, decision‑matrix sync, chunked
resumable transfer, and encryption — and adds the changes below.

## What SolidDAV adds over upstream

- **Content‑aware change detection** — uses the remote ETag and file size instead
  of modification time alone (mtime is unreliable across devices and on mobile).
- **Atomic uploads** — upload to a temp file then `MOVE` it over the target, so an
  interrupted upload can never leave a corrupt file.
- **Advisory remote lock** — prevents two devices writing to the same remote at
  once and interleaving into an inconsistent state.
- **Log in with Nextcloud** — browser authorization (SSO supported) that fills the
  server URL, account and credential automatically, no manual app password.
- **Connection‑type selector** — Nextcloud (credential fully managed) or generic
  WebDAV (manual), so there are never duplicate/conflicting connection fields.
- **Monitor‑only mode** — a read‑only device (e.g. a PC where the Nextcloud
  desktop client already syncs) that never writes and just shows in‑sync status
  in the status bar.
- **Cleaner setup & status** — progressive‑disclosure settings, a one‑time quick
  start, a single sync button, non‑intrusive mobile status, and notices only when
  the server actually updates your vault (no "up to date" spam).

## Install (beta, via BRAT)

1. Install the **BRAT** community plugin.
2. BRAT → **Add beta plugin** → `Esmaeelpour/obsidian-soliddav`.
3. Enable **SolidDAV**, open its settings, pick a connection type, and connect.

## Build

This project uses [Bun](https://bun.sh).

```bash
bun install
bun run build   # outputs main.js
```

## License & attribution

SolidDAV is licensed under **AGPL‑3.0**, the same license as the upstream project
it derives from. It is a modified version of **WebDAV Sync**
([hesprs/obsidian-webdav-sync](https://github.com/hesprs/obsidian-webdav-sync))
© its contributors. The full license text is in [`LICENSE`](LICENSE), the source
is available in this repository, and the changes from upstream are listed above
and recorded in the commit history.

SolidDAV is an independent fork and is **not affiliated with or endorsed by** the
upstream authors.
