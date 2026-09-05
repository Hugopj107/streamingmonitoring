const { ipcRenderer } = require('electron');

// disk-backed uptime log + report saving (survives restarts)
window.uptimeStore = {
  append: line => ipcRenderer.invoke('uptime-append', line),
  readAll: () => ipcRenderer.invoke('uptime-readall'),
  saveReport: payload => ipcRenderer.invoke('report-save', payload),
};

// NATS smart-director ingest (runs in main; roster pushed here)
window.natsAPI = {
  connect: url => ipcRenderer.invoke('nats-connect', url),
  disconnect: url => ipcRenderer.invoke('nats-disconnect', url),
  servers: () => ipcRenderer.invoke('nats-servers'),
  roster: () => ipcRenderer.invoke('nats-roster'),
  onUpdate: cb => ipcRenderer.on('nats-update', (e, r) => cb(r)),
};

// Google Sheets (service account) + persisted config
window.sheetsAPI = {
  chooseKey: () => ipcRenderer.invoke('choose-key'),
  configure: cfg => ipcRenderer.invoke('sheets-configure', cfg),
  append: row => ipcRenderer.invoke('sheets-append', row),
  update: (rowNum, row) => ipcRenderer.invoke('sheets-update', { rowNum, row }),
  status: () => ipcRenderer.invoke('sheets-status'),
};
window.configStore = {
  get: () => ipcRenderer.invoke('config-get'),
  set: c => ipcRenderer.invoke('config-set', c),
};

// direct ingest (ffmpeg per court) — frames + per-court audio pushed here
window.ingestAPI = {
  probe: () => ipcRenderer.invoke('ingest-probe'),
  start: (courtId, url) => ipcRenderer.invoke('ingest-start', { courtId, url }),
  stop: courtId => ipcRenderer.invoke('ingest-stop', { courtId }),
  openTest: () => ipcRenderer.invoke('open-ingest-test'),
  openGrid: () => ipcRenderer.invoke('open-ingest-grid'),
  onFrame: cb => ipcRenderer.on('ingest-frame', (e, d) => cb(d)),
  onAudio: cb => ipcRenderer.on('ingest-audio', (e, d) => cb(d)),
  onStatus: cb => ipcRenderer.on('ingest-status', (e, d) => cb(d)),
};

// The tool calls navigator.mediaDevices.getDisplayMedia(). In a browser that pops the OS
// picker; in Electron we route it through desktopCapturer + our own Chrome-style picker
// (thumbnail previews, refreshed ~1/s) so you can see what you're sharing before choosing.
window.addEventListener('DOMContentLoaded', () => {
  navigator.mediaDevices.getDisplayMedia = async () => {
    const id = await pickSource();
    if (!id) throw new DOMException('No source selected', 'NotAllowedError');
    const video = { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: id, maxFrameRate: 20 } };
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'desktop' } }, video });
    } catch (e) {
      return navigator.mediaDevices.getUserMedia({ audio: false, video });   // audio not available → video only
    }
  };
});

function pickSource() {
  return new Promise(async resolve => {
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(6,9,12,.88);z-index:99999;'
      + 'display:flex;align-items:center;justify-content:center;font-family:monospace';
    const box = document.createElement('div');
    box.style.cssText = 'background:#12161c;border:1px solid #20272f;border-radius:12px;'
      + 'padding:20px;width:min(920px,92vw);max-height:86vh;overflow:auto;display:flex;flex-direction:column';
    box.innerHTML = '<div style="color:#dfe6ee;letter-spacing:.14em;text-transform:uppercase;'
      + 'font-size:12px;margin-bottom:4px">Choose what to share</div>'
      + '<div style="color:#7d8a99;font-size:11px;margin-bottom:16px">Previews update live — click a tile to start monitoring it</div>';
    ov.appendChild(box);
    document.body.appendChild(ov);

    const tiles = new Map();   // id -> <img>
    let selected = null;

    function section(title) {
      const h = document.createElement('div');
      h.textContent = title;
      h.style.cssText = 'color:#7d8a99;letter-spacing:.1em;text-transform:uppercase;font-size:10px;'
        + 'margin:14px 2px 8px';
      box.appendChild(h);
      const grid = document.createElement('div');
      grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:12px';
      box.appendChild(grid);
      return grid;
    }

    function tile(grid, s) {
      const card = document.createElement('div');
      card.style.cssText = 'border:2px solid #20272f;border-radius:8px;overflow:hidden;cursor:pointer;'
        + 'background:#0b0e12;transition:border-color .1s';
      const img = document.createElement('img');
      img.src = s.thumbnail;
      img.style.cssText = 'width:100%;aspect-ratio:16/9;object-fit:cover;display:block;background:#000';
      const cap = document.createElement('div');
      cap.textContent = s.name;
      cap.title = s.name;
      cap.style.cssText = 'padding:8px 10px;font-size:11px;color:#dfe6ee;white-space:nowrap;'
        + 'overflow:hidden;text-overflow:ellipsis';
      card.append(img, cap);
      const highlight = on => card.style.borderColor = on ? '#4ec9b0' : (selected === s.id ? '#4ec9b0' : '#20272f');
      card.onmouseenter = () => highlight(true);
      card.onmouseleave = () => highlight(false);
      card.onclick = () => { selected = s.id; done(s.id); };
      grid.appendChild(card);
      tiles.set(s.id, img);
    }

    function done(id) { clearInterval(timer); document.body.removeChild(ov); resolve(id); }

    // initial render
    const sources = await ipcRenderer.invoke('get-sources');
    const screens = sources.filter(s => s.type === 'screen');
    const windows = sources.filter(s => s.type === 'window');
    if (screens.length) { const g = section('Screens'); screens.forEach(s => tile(g, s)); }
    if (windows.length) { const g = section('Windows'); windows.forEach(s => tile(g, s)); }

    // footer / cancel
    const foot = document.createElement('div');
    foot.style.cssText = 'margin-top:18px;text-align:right';
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.style.cssText = 'padding:9px 16px;background:#0b0e12;border:1px solid #20272f;color:#dfe6ee;'
      + 'border-radius:6px;cursor:pointer;font-family:monospace;font-size:12px';
    cancel.onmouseenter = () => cancel.style.borderColor = '#4ec9b0';
    cancel.onmouseleave = () => cancel.style.borderColor = '#20272f';
    cancel.onclick = () => done(null);
    foot.appendChild(cancel);
    box.appendChild(foot);

    // refresh thumbnails ~1/s so the previews look live
    const timer = setInterval(async () => {
      const fresh = await ipcRenderer.invoke('get-sources');
      fresh.forEach(s => { const img = tiles.get(s.id); if (img) img.src = s.thumbnail; });
    }, 1000);
  });
}
