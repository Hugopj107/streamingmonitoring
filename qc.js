// Broadcast QC — ports the TDI False Color QC Pro (exposure) and RGB Balance QC Pro
// (white balance) OBS shaders into measured distributions + a PASS/CHECK/FAIL verdict.
// Works on raw RGBA frame bytes (from direct ingest — real pixels, not a screen-grab).
// Pure JS, no DOM, so it runs anywhere (renderer or, later, main).

// luma weights = Rec.709, matching the shader's dot(c.rgb, float3(0.2126,0.7152,0.0722))
const LR = 0.2126, LG = 0.7152, LB = 0.0722;

// tunable verdict thresholds (calibrate against known-good/bad feeds)
const QC_DEFAULTS = {
  passCorrect: 55,   // % correct-exposure to PASS
  failCorrect: 35,   // below this on correct-exposure → FAIL
  clipWarn: 2,       // % clipping to CHECK
  clipFail: 6,       // % clipping to FAIL
  crushWarn: 3,      // % black-crush to CHECK
  neutralPass: 60,   // % neutral (of judged pixels) to PASS white balance
  neutralFail: 40,   // below → FAIL
  castWarn: 15,      // % of neutral-area pixels showing one cast → CHECK
  castFail: 30,      // → FAIL
  sampleStride: 2,   // analyse every Nth pixel (speed; 1 = all)
};

// Analyse one RGBA frame → distributions. data: Uint8/Uint8ClampedArray length w*h*4.
function analyseQC(data, w, h, opt) {
  const P = Object.assign({}, QC_DEFAULTS, opt || {});
  const stride = Math.max(1, P.sampleStride | 0);
  const band = new Float64Array(10);   // 0=crush … 9=clip (false-colour bands)
  let total = 0, neutralJudged = 0, white = 0, warm = 0, cool = 0, green = 0;
  const step = 4 * stride;
  for (let i = 0; i + 2 < data.length; i += step) {
    const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
    const luma = LR * r + LG * g + LB * b;
    total++;
    // ---- False Color bands (exact shader cutoffs) ----
    let bi;
    if (luma < 0.03) bi = 0; else if (luma < 0.10) bi = 1; else if (luma < 0.20) bi = 2;
    else if (luma < 0.35) bi = 3; else if (luma < 0.55) bi = 4; else if (luma < 0.70) bi = 5;
    else if (luma < 0.80) bi = 6; else if (luma < 0.92) bi = 7; else if (luma < 0.99) bi = 8; else bi = 9;
    band[bi]++;
    // ---- RGB Balance (neutral pixels only: skip dark <0.10 and saturated >0.10) ----
    if (luma >= 0.10) {
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (mx - mn <= 0.10) {
        neutralJudged++;
        if (r > g * 1.12 && r > b * 1.12) warm++;
        else if (b > r * 1.12 && b > g * 1.12) cool++;
        else if (g > r * 1.12 && g > b * 1.12) green++;
        else white++;
      }
    }
  }
  const pct = n => total ? 100 * n / total : 0;
  const npct = n => neutralJudged ? 100 * n / neutralJudged : 0;
  const exp = {
    crush: pct(band[0]), tooDark: pct(band[1] + band[2]),
    correct: pct(band[3] + band[4] + band[5]),
    bright: pct(band[6] + band[7]), nearClip: pct(band[8]), clip: pct(band[9]),
    clipping: pct(band[8] + band[9]),
  };
  const wb = {
    neutral: npct(white), warm: npct(warm), cool: npct(cool), green: npct(green),
    judged: neutralJudged,
    dominantCast: (() => { const m = Math.max(warm, cool, green); if (!m) return 'none';
      return m === warm ? 'warm' : m === cool ? 'cool' : 'green'; })(),
    castPct: npct(Math.max(warm, cool, green)),
  };
  return { exp, wb, verdict: verdictOf(exp, wb, P), thresholds: P };
}

function verdictOf(exp, wb, P) {
  let e = 'PASS';
  if (exp.correct < P.failCorrect || exp.clipping >= P.clipFail) e = 'FAIL';
  else if (exp.correct < P.passCorrect || exp.clipping >= P.clipWarn || exp.crush >= P.crushWarn) e = 'CHECK';
  let w = 'PASS';
  if (wb.judged < 50) w = 'N/A';                       // too few neutral pixels to judge
  else if (wb.neutral < P.neutralFail || wb.castPct >= P.castFail) w = 'FAIL';
  else if (wb.neutral < P.neutralPass || wb.castPct >= P.castWarn) w = 'CHECK';
  const rank = { PASS: 0, 'N/A': 0, CHECK: 1, FAIL: 2 };
  const overall = (rank[e] >= rank[w]) ? (e === 'PASS' && w === 'N/A' ? 'PASS' : e) : w;
  return { exposure: e, whiteBalance: w, overall };
}

// Cross-court consistency: given [{court, exp, wb}], flag outliers vs the group median.
function consistency(items) {
  if (items.length < 2) return {};
  const med = arr => { const a = [...arr].sort((x, y) => x - y); return a[a.length >> 1]; };
  const mCorrect = med(items.map(i => i.exp.correct));
  const mNeutral = med(items.map(i => i.wb.neutral));
  const out = {};
  for (const it of items) {
    const dExp = it.exp.correct - mCorrect, dWb = it.wb.neutral - mNeutral;
    out[it.court] = {
      expDelta: dExp, wbDelta: dWb,
      outlier: Math.abs(dExp) > 20 || Math.abs(dWb) > 20,   // >20pp from the group median
    };
  }
  return out;
}

// The False Color view (recolour a frame for display) — straight port of the shader palette.
const FC_PALETTE = [
  [255, 0, 255], [0, 0, 128], [0, 0, 255], [0, 204, 0], [0, 255, 0],
  [128, 255, 0], [255, 255, 0], [255, 128, 0], [255, 0, 0], [255, 255, 255],
];
function falseColorInto(src, dst, w, h) {   // src RGBA → dst RGBA
  for (let i = 0; i + 3 < src.length; i += 4) {
    const luma = (LR * src[i] + LG * src[i + 1] + LB * src[i + 2]) / 255;
    let bi;
    if (luma < 0.03) bi = 0; else if (luma < 0.10) bi = 1; else if (luma < 0.20) bi = 2;
    else if (luma < 0.35) bi = 3; else if (luma < 0.55) bi = 4; else if (luma < 0.70) bi = 5;
    else if (luma < 0.80) bi = 6; else if (luma < 0.92) bi = 7; else if (luma < 0.99) bi = 8; else bi = 9;
    const c = FC_PALETTE[bi]; dst[i] = c[0]; dst[i + 1] = c[1]; dst[i + 2] = c[2]; dst[i + 3] = 255;
  }
}
// The RGB Balance view — neutral→white, casts→their colour, ignored→dark grey.
function rgbBalanceInto(src, dst, w, h) {
  for (let i = 0; i + 3 < src.length; i += 4) {
    const r = src[i] / 255, g = src[i + 1] / 255, b = src[i + 2] / 255;
    const luma = LR * r + LG * g + LB * b;
    let o;
    if (luma < 0.10) o = [51, 51, 51];
    else if (Math.max(r, g, b) - Math.min(r, g, b) > 0.10) o = [20, 20, 20];
    else if (r > g * 1.12 && r > b * 1.12) o = [255, 0, 0];
    else if (g > r * 1.12 && g > b * 1.12) o = [0, 255, 0];
    else if (b > r * 1.12 && b > g * 1.12) o = [0, 255, 255];
    else o = [255, 255, 255];
    dst[i] = o[0]; dst[i + 1] = o[1]; dst[i + 2] = o[2]; dst[i + 3] = 255;
  }
}

// Temporal QC — smooths per-frame measurements over a window and only changes the
// verdict when a new state persists, so a single flash-frame can't flip PASS↔FAIL.
class QCStabilizer {
  constructor(opt) {
    this.P = Object.assign({}, QC_DEFAULTS, opt || {});
    this.a = 0.15;            // EMA weight per frame (~1–2 s at a few Hz)
    this.enterMs = 1500;      // a worse verdict must persist this long to commit
    this.exitMs = 2500;       // a better verdict must persist this long to release
    this.avg = null;
    this.committed = null;
    this.cand = null; this.candSince = 0; this._cast = 'none';
  }
  push(q, now) {
    now = now || Date.now();
    const e = q.exp, w = q.wb, A = this.avg || {};
    const mix = (k, v) => (A[k] = (A[k] == null ? v : A[k] + this.a * (v - A[k])));
    mix('correct', e.correct); mix('clipping', e.clipping); mix('crush', e.crush);
    mix('tooDark', e.tooDark); mix('bright', e.bright);
    mix('neutral', w.neutral); mix('castPct', w.castPct); mix('judged', w.judged);
    this.avg = A; this._cast = w.dominantCast;
    const sExp = { correct: A.correct, clipping: A.clipping, crush: A.crush, bright: A.bright, tooDark: A.tooDark };
    const sWb = { neutral: A.neutral, castPct: A.castPct, judged: A.judged, dominantCast: w.dominantCast };
    const raw = verdictOf(sExp, sWb, this.P);
    const rank = { PASS: 0, 'N/A': 0, CHECK: 1, FAIL: 2 };
    if (!this.committed) { this.committed = raw; this.cand = raw; this.candSince = now; }
    else {
      if (raw.overall !== this.cand.overall) { this.cand = raw; this.candSince = now; }
      const worse = rank[raw.overall] > rank[this.committed.overall];
      const need = worse ? this.enterMs : this.exitMs;
      if (now - this.candSince >= need && raw.overall !== this.committed.overall) this.committed = raw;
    }
    return { verdict: this.committed, exp: sExp, wb: Object.assign({ dominantCast: this._cast }, sWb) };
  }
}

// Camera-action guidance — ported from the kit's False Colour / RGB Balance action guides.
// Turns a verdict into the specific adjustment an operator should make.
function qcAdvice(q) {
  const e = q.exp, wb = q.wb, v = q.verdict;
  let exposure = 'Exposure correct — no change';
  if (v.exposure !== 'PASS') {
    if (e.clipping >= 2 || e.bright > 25) exposure = 'Too bright — reduce exposure: close iris or reduce gain';
    else if (e.correct < 55 || e.tooDark > 25 || e.crush > 3) exposure = 'Too dark — increase exposure: open iris or add gain';
    else exposure = 'Check exposure on a waveform';
  }
  let whiteBalance = 'White balance correct — no change';
  if (v.whiteBalance === 'N/A') whiteBalance = 'Not enough neutral area to judge white balance';
  else if (v.whiteBalance !== 'PASS') {
    if (wb.dominantCast === 'warm') whiteBalance = 'Warm cast — cool the white balance or reduce red';
    else if (wb.dominantCast === 'cool') whiteBalance = 'Cool cast — warm the white balance or reduce blue';
    else if (wb.dominantCast === 'green') whiteBalance = 'Green cast — move tint toward magenta or reduce green';
    else whiteBalance = 'Check white balance on a vectorscope';
  }
  return { exposure, whiteBalance, note: 'Confirm on waveform/vectorscope before changing camera settings.' };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { analyseQC, consistency, falseColorInto, rgbBalanceInto, qcAdvice, QCStabilizer, QC_DEFAULTS };
}
