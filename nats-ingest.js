// NATS ingest for the smart-director feed. Runs in Electron's MAIN process (raw TCP).
// Supports MULTIPLE tournaments at once: one connection per NATS address. Courts are keyed
// by tId+courtId so identical court names across tournaments never collide. Each court is
// tagged with its source url + tId so the UI/export can disambiguate.
const { connect, StringCodec } = require('nats');

const sc = StringCodec();
const conns = new Map();    // url -> { nc, sub, connected }
const courts = new Map();   // `${tId}:${courtId}` -> { courtId,tId,mId,teamA,teamB,firstSeen,lastSeen,mState,url }
let onUpdate = null, timer = null;

// <Packet> is fixed-width: [0]=0xFF, [1..5)=tId, [5..10)=mId, then four 20-char surname slots.
function parsePacket(b64) {
  try {
    const raw = Buffer.from(b64, 'base64').toString('latin1');
    const f = i => raw.slice(10 + i * 20, 10 + i * 20 + 20).trim();
    const s = [f(0), f(1), f(2), f(3)];
    return { teamA: [s[0], s[2]].filter(Boolean).join(' / '), teamB: [s[1], s[3]].filter(Boolean).join(' / ') };
  } catch (e) { return { teamA: '', teamB: '' }; }
}

const attr = (xml, name) => { const m = xml.match(new RegExp(name + '="([^"]*)"')); return m ? m[1] : null; };
const roster = () => [...courts.values()].sort((a, b) =>
  String(a.url).localeCompare(String(b.url)) || String(a.courtId).localeCompare(String(b.courtId), undefined, { numeric: true }));
const servers = () => [...conns.entries()].map(([url, c]) => ({ url, connected: !!c.connected }));
const emit = () => { if (onUpdate) onUpdate(roster()); };

function handle(msg, url) {
  const xml = sc.decode(msg.data);
  const courtId = attr(xml, 'courtId'); if (!courtId) return;
  const tId = attr(xml, 'tId') || '';
  const key = tId + ':' + courtId;
  const now = Date.now();
  const pm = xml.match(/<Packet>([\s\S]*?)<\/Packet>/);
  const names = pm ? parsePacket(pm[1]) : { teamA: '', teamB: '' };
  let c = courts.get(key), structural = false;
  if (!c) {
    c = { courtId, tId, mId: attr(xml, 'mId'), teamA: names.teamA, teamB: names.teamB,
          firstSeen: now, lastSeen: now, mState: attr(xml, 'mState'), url };
    courts.set(key, c); structural = true;
  } else {
    c.lastSeen = now; c.url = url;
    const mId = attr(xml, 'mId');
    if (mId && mId !== c.mId) { c.mId = mId; c.firstSeen = now; c.teamA = names.teamA; c.teamB = names.teamB; structural = true; }
    else if (!c.teamA && names.teamA) { c.teamA = names.teamA; c.teamB = names.teamB; structural = true; }
    const ms = attr(xml, 'mState'); if (ms && ms !== c.mState) { c.mState = ms; structural = true; }
  }
  if (structural) emit();
}

async function addServer(url, cb) {
  onUpdate = cb || onUpdate;
  const key = String(url).trim();
  if (conns.has(key)) return { ok: true, already: true };
  const servers = key.replace(/^nats:\/\//, '');
  const nc = await connect({ servers, reconnect: true, maxReconnectAttempts: -1, timeout: 8000, name: 'stream-sentinel' });
  const sub = nc.subscribe('external.smart-director');
  conns.set(key, { nc, sub, connected: true });
  (async () => { for await (const m of sub) { try { handle(m, key); } catch (e) {} } })();
  if (!timer) timer = setInterval(() => { if (courts.size) emit(); }, 1500);
  emit();
  return { ok: true };
}

async function removeServer(url) {
  const key = String(url).trim();
  const c = conns.get(key); if (!c) return { ok: true };
  try { c.sub && c.sub.unsubscribe(); } catch (e) {}
  try { c.nc && await c.nc.drain(); } catch (e) {}
  conns.delete(key);
  for (const [k, ct] of courts) { if (ct.url === key) courts.delete(k); }
  if (!conns.size && timer) { clearInterval(timer); timer = null; }
  emit();
  return { ok: true };
}

async function stopAll() { for (const url of [...conns.keys()]) await removeServer(url); courts.clear(); }

module.exports = { addServer, removeServer, stopAll, roster, servers };
