# Stream Sentinel — desktop app

Wraps the monitoring tool (`index.html`) into a standalone Windows `.exe` using Electron.
Screen capture is routed through Electron's `desktopCapturer`, so *Capture screen / window*
lets you pick the exact VLC window and always works.

## Build the .exe

Needs Node.js (18+) and internet access on the **build** machine (see ffmpeg note below). In
this folder:

```
npm install
npm run dist
```

Output: `dist/StreamSentinel.exe` — a single portable file. Copy it anywhere and double-click;
no install, no dependencies on the target machine — including ffmpeg, see below.

Prefer a proper installer (Start-menu entry, uninstaller)? Use:

```
npm run dist:installer
```

### Bundled ffmpeg (SRT-enabled, zero setup on the target machine)

Direct ingest (SRT/RTSP) needs an ffmpeg build with `libsrt` — a plain ffmpeg build won't open
`srt://` URLs at all. `npm run dist` / `dist:installer` automatically run
`scripts/fetch-ffmpeg.js` first, which downloads
[BtbN's "gpl full" Windows build](https://github.com/BtbN/FFmpeg-Builds) (has `libsrt`) into
`bin/win/ffmpeg.exe`, then electron-builder bundles it into the packaged app's `resources/`
folder. The result: the target machine needs nothing installed — no ffmpeg, no PATH setup.

This binary is **not committed to git** — this repo is public, and an ~90MB GPL binary doesn't
belong in a public repo's history. It's fetched fresh (skipped if already present) on whichever
machine runs the build; only the build machine needs internet access at package time, not the
machine the app ends up running on. To fetch it without doing a full build (e.g. for `npm start`
below), run `npm run fetch:ffmpeg` directly.

ffmpeg itself is GPL-licensed — fine bundled for internal tooling; worth a second look if this
app is ever distributed outside the org.

`resolveFfmpeg()` in `main.js` checks, in order: the packaged app's bundled
`resources/ffmpeg.exe` (always preferred when present), `bin/win/ffmpeg.exe` (so `npm start`
dev mode also finds it once fetched), a binary dropped directly next to the app, then finally
system PATH — so nothing regresses if the bundled binary is ever missing for some reason.

Only Windows is wired up. Bundling for macOS/Linux would mean fetching a per-platform BtbN (or
equivalent) build into `bin/mac/` or `bin/linux/` and adding a matching `extraResources` entry
per platform in `package.json` — `resolveFfmpeg()` already looks in the right per-platform
`bin/<platform>/` folder, that part doesn't need touching.

## Run without packaging (for tweaking)

```
npm install
npm start
npm run fetch:ffmpeg   # optional — only needed to test direct SRT/RTSP ingest in dev mode
```

Edit `index.html` and restart — it's the same tool, so all the sliders and detection logic
live there.

## Lighter alternatives

- **No build at all:** make a desktop shortcut to
  `msedge.exe --app="file:///C:/full/path/to/index.html"` — launches chrome-less in its own
  window. Not a real exe, but zero tooling.
- **Tiny binary (~5 MB vs Electron's ~150 MB):** port to [Tauri]. Uses the system WebView2
  instead of bundling Chromium; needs the Rust toolchain and a display-media permission handler.
