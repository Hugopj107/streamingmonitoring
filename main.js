const { app, BrowserWindow, ipcMain, desktopCapturer, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const nats = require('./nats-ingest');
const sheets = require('./sheets');
const ingest = require('./ingest');
let mainWin = null;

// ffmpeg for direct ingest: prefer a binary shipped next to the app (drop an SRT-enabled
// build here — e.g. BtbN), else fall back to system PATH.
function resolveFfmpeg(){
  const names = process.platform === 'win32' ? ['ffmpeg.exe'] : ['ffmpeg'];
  for (const d of [process.resourcesPath || __dirname, __dirname])
    for (const n of names) { const p = path.join(d, n); try { if (fs.existsSync(p)) return p; } catch (e) {} }
  return names[0];   // system PATH
}
ingest.setFfmpegPath(resolveFfmpeg());
const feeds = new Map();

// keep timers, rAF, and screen-capture running full-rate even when occluded or in the background
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

const cfgPath = () => path.join(app.getPath('userData'), 'config.json');
const readCfg = () => { try { return JSON.parse(fs.readFileSync(cfgPath(), 'utf8')); } catch (e) { return {}; } };
const writeCfg = c => { try { fs.writeFileSync(cfgPath(), JSON.stringify(c)); } catch (e) {} };
ipcMain.handle('config-get', () => readCfg());
ipcMain.handle('config-set', (e, c) => { writeCfg({ ...readCfg(), ...c }); return { ok: true }; });

// ---- Google Sheets ----
ipcMain.handle('choose-key', async () => {
  const r = await dialog.showOpenDialog(mainWin, { title: 'Service-account JSON key',
    filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['openFile'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('sheets-configure', async (e, cfg) => {
  try { const res = await sheets.configure(cfg); writeCfg({ ...readCfg(), sheets: cfg }); return res; }
  catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
});
ipcMain.handle('sheets-append', async (e, row) => {
  try { return await sheets.append(row); }
  catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
});
ipcMain.handle('sheets-update', async (e, { rowNum, row }) => {
  try { return await sheets.updateRow(rowNum, row); }
  catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
});
ipcMain.handle('sheets-status', () => sheets.status());

// ---- direct ingest (ffmpeg per court) ----
ipcMain.handle('ingest-probe', () => new Promise(res => ingest.probe(res)));
ipcMain.handle('ingest-start', (e, { courtId, url }) => {
  const wc = e.sender;
  if (feeds.has(courtId)) feeds.get(courtId).stop();
  const f = new ingest.Feed(courtId, url, {
    onFrame:  d => { try { wc.send('ingest-frame',  d); } catch (_) {} },
    onAudio:  d => { try { wc.send('ingest-audio',  d); } catch (_) {} },
    onStatus: d => { try { wc.send('ingest-status', d); } catch (_) {} },
  });
  f.ownerId = wc.id;   // so the owning window's 'closed' handler can stop only its own feeds
  feeds.set(courtId, f); f.start();
  return { ok: true };
});
ipcMain.handle('ingest-stop', (e, { courtId }) => { const f = feeds.get(courtId); if (f) { f.stop(); feeds.delete(courtId); } return { ok: true }; });
// stop and drop any feeds a since-closed ingest window (single-stream beta or multi-court grid) left running
function stopFeedsOwnedBy(webContentsId) {
  for (const [id, f] of feeds) { if (f.ownerId === webContentsId) { f.stop(); feeds.delete(id); } }
}
ipcMain.handle('open-ingest-test', () => {
  const w = new BrowserWindow({ width: 1000, height: 780, backgroundColor: '#0b0e12', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: false, nodeIntegration: false, backgroundThrottling: false } });
  w.setMenuBarVisibility(false); w.loadFile('ingest-test.html');
  const ownerId = w.webContents.id;
  w.on('closed', () => stopFeedsOwnedBy(ownerId));
  return { ok: true };
});
ipcMain.handle('open-ingest-grid', () => {
  const w = new BrowserWindow({ width: 1440, height: 900, backgroundColor: '#0b0e12', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: false, nodeIntegration: false, backgroundThrottling: false } });
  w.setMenuBarVisibility(false); w.loadFile('ingest-grid.html');
  const ownerId = w.webContents.id;
  w.on('closed', () => stopFeedsOwnedBy(ownerId));
  return { ok: true };
});

const logPath = () => path.join(app.getPath('userData'), 'uptime-log.jsonl');

ipcMain.handle('uptime-append', (e, line) => {
  try { fs.appendFileSync(logPath(), line + '\n'); } catch (err) { /* best-effort */ }
});
ipcMain.handle('uptime-readall', () => {
  try { return fs.readFileSync(logPath(), 'utf8'); } catch (err) { return ''; }
});
// ---- NATS (smart-director) ingest — multiple tournaments ----
ipcMain.handle('nats-connect', async (e, url) => {
  try {
    await nats.addServer(url, roster => { if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('nats-update', roster); });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});
ipcMain.handle('nats-disconnect', async (e, url) => { await nats.removeServer(url); return { ok: true }; });
ipcMain.handle('nats-servers', () => nats.servers());
ipcMain.handle('nats-roster', () => nats.roster());

ipcMain.handle('report-save', async (e, { html, csv }) => {
  const dir = path.join(app.getPath('userData'), 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const hp = path.join(dir, `uptime-${stamp}.html`);
  const pp = path.join(dir, `uptime-${stamp}.pdf`);
  fs.writeFileSync(hp, html);
  fs.writeFileSync(path.join(dir, `uptime-${stamp}.csv`), csv);
  // render the report to a proper PDF (uses the report's print stylesheet)
  try {
    const w = new BrowserWindow({ show: false });
    await w.loadFile(hp);
    const pdf = await w.webContents.printToPDF({ printBackground: true, landscape: true, margins: { marginType: 'default' } });
    fs.writeFileSync(pp, pdf);
    w.destroy();
    shell.openPath(pp);
    return pp;
  } catch (err) {
    shell.openPath(hp);
    return hp;
  }
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    backgroundColor: '#0b0e12',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false,   // local trusted app: let preload patch getDisplayMedia
      nodeIntegration: false,
      backgroundThrottling: false,   // keep capture + detection running when window isn't focused
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile('index.html');
  mainWin = win;
  win.on('closed', () => { mainWin = null; nats.stopAll(); feeds.forEach(f => f.stop()); feeds.clear(); });
}

// renderer asks for the list of capturable windows/screens, with preview thumbnails
ipcMain.handle('get-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['window', 'screen'],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: false,
  });
  return sources.map(s => ({
    id: s.id,
    name: s.name,
    type: s.id.startsWith('screen:') ? 'screen' : 'window',
    thumbnail: s.thumbnail.toDataURL(),
  }));
});

app.whenReady().then(() => {
  createWindow();
  // Zero-touch: load a service-account key bundled with the app, if present.
  // Looks for service-account.json next to the app resources or in userData.
  const candidates = [
    path.join(process.resourcesPath || __dirname, 'service-account.json'),
    path.join(__dirname, 'service-account.json'),
    path.join(app.getPath('userData'), 'service-account.json'),
  ];
  const keyPath = candidates.find(p => { try { return fs.existsSync(p); } catch (e) { return false; } });
  if (keyPath) sheets.configure({ keyPath }).catch(() => {});
  else { const cfg = readCfg(); if (cfg.sheets && cfg.sheets.keyPath) sheets.configure(cfg.sheets).catch(() => {}); }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
