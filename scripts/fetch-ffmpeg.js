// Downloads a libsrt-enabled ffmpeg (BtbN's "gpl full" Windows build) and extracts ffmpeg.exe
// into bin/win/, for electron-builder's extraResources to bundle into the packaged app.
//
// Not committed to git: this repo is public, and an ~90MB GPL binary doesn't belong in a public
// repo's history. This script re-fetches it fresh on whichever machine runs `npm run dist`, so
// the packaged app still ships ffmpeg with zero setup on the target machine - only the *build*
// machine needs internet access at package time.
//
// Uses only Node's built-in https module plus PowerShell's Expand-Archive for unzipping -
// no new npm dependency for a one-time build step.
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const DEST_DIR = path.join(__dirname, '..', 'bin', 'win');
const DEST = path.join(DEST_DIR, 'ffmpeg.exe');
// "latest" (not a pinned dated tag) deliberately: BtbN prunes older autobuild releases over
// time, so a hard-pinned tag can eventually 404. This always resolves to whatever build is
// currently published - fine for an internal tool where exact ffmpeg-version reproducibility
// across time isn't a requirement, and it never breaks the fetch.
const ZIP_URL = 'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip';

function download(url, dest, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const cleanup = () => { try { fs.unlinkSync(dest); } catch (e) {} };
    https.get(url, { headers: { 'User-Agent': 'stream-monitor-build' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close(); cleanup();
        if (redirectsLeft <= 0) return reject(new Error('too many redirects fetching ' + url));
        return resolve(download(res.headers.location, dest, redirectsLeft - 1));
      }
      if (res.statusCode !== 200) {
        file.close(); cleanup();
        return reject(new Error('download failed: HTTP ' + res.statusCode + ' for ' + url));
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
      file.on('error', err => { cleanup(); reject(err); });
    }).on('error', err => { cleanup(); reject(err); });
  });
}

async function main() {
  if (fs.existsSync(DEST)) {
    console.log('[fetch-ffmpeg] already present at ' + DEST + ' - skipping download.');
    return;
  }
  if (process.platform !== 'win32') {
    console.log('[fetch-ffmpeg] no bundling configured for platform "' + process.platform + '" yet (Windows only for now) - skipping.');
    return;
  }

  fs.mkdirSync(DEST_DIR, { recursive: true });
  const stamp = Date.now();
  const tmpZip = path.join(os.tmpdir(), 'ffmpeg-btbn-' + stamp + '.zip');
  const tmpExtract = path.join(os.tmpdir(), 'ffmpeg-btbn-extract-' + stamp);

  console.log('[fetch-ffmpeg] downloading SRT-enabled ffmpeg (BtbN gpl full build)...');
  console.log('  ' + ZIP_URL);
  await download(ZIP_URL, tmpZip);

  console.log('[fetch-ffmpeg] extracting...');
  execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Expand-Archive -Path '${tmpZip}' -DestinationPath '${tmpExtract}' -Force`,
  ], { stdio: 'inherit' });

  // BtbN zips contain one top-level folder, e.g. ffmpeg-master-latest-win64-gpl/bin/ffmpeg.exe
  const top = fs.readdirSync(tmpExtract).find(n => fs.statSync(path.join(tmpExtract, n)).isDirectory());
  if (!top) throw new Error('unexpected archive layout - no top-level folder found in ' + tmpExtract);
  const src = path.join(tmpExtract, top, 'bin', 'ffmpeg.exe');
  if (!fs.existsSync(src)) throw new Error('ffmpeg.exe not found in extracted archive at ' + src);

  fs.copyFileSync(src, DEST);
  fs.unlinkSync(tmpZip);
  fs.rmSync(tmpExtract, { recursive: true, force: true });

  const sizeMB = (fs.statSync(DEST).size / (1024 * 1024)).toFixed(1);
  console.log('[fetch-ffmpeg] done - ' + DEST + ' (' + sizeMB + ' MB)');
}

main().catch(err => {
  console.error('[fetch-ffmpeg] failed:', err.message);
  process.exit(1);
});
