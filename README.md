# Stream Sentinel — desktop app

Wraps the monitoring tool (`index.html`) into a standalone Windows `.exe` using Electron.
Screen capture is routed through Electron's `desktopCapturer`, so *Capture screen / window*
lets you pick the exact VLC window and always works.

## Build the .exe

Needs Node.js (18+). In this folder:

```
npm install
npm run dist
```

Output: `dist/StreamSentinel.exe` — a single portable file. Copy it anywhere and double-click;
no install, no dependencies on the target machine.

Prefer a proper installer (Start-menu entry, uninstaller)? Use:

```
npm run dist:installer
```

## Run without packaging (for tweaking)

```
npm install
npm start
```

Edit `index.html` and restart — it's the same tool, so all the sliders and detection logic
live there.

## Lighter alternatives

- **No build at all:** make a desktop shortcut to
  `msedge.exe --app="file:///C:/full/path/to/index.html"` — launches chrome-less in its own
  window. Not a real exe, but zero tooling.
- **Tiny binary (~5 MB vs Electron's ~150 MB):** port to [Tauri]. Uses the system WebView2
  instead of bundling Chromium; needs the Rust toolchain and a display-media permission handler.
