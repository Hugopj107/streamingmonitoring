// Direct stream ingest (SRT / RTSP) — the replacement for screen-capture.
// Per court: one ffmpeg pulls the stream and pipes downscaled RGBA frames for detection;
// audio levels come from ffmpeg's ebur128 filter (real per-court dBFS, no manual PCM).
// This is the Electron analogue of the Python app's one-MediaPlayer-per-SRT-feed model.
const { spawn, execFile } = require('child_process');

const FRAME_W = 384;          // downscaled width for detection (cheap, plenty for block/flicker)
const FRAME_H = 216;          // fixed 16:9 output → deterministic frame size (stretch is fine for detection)
const FPS = 8;                // detection framerate — freeze/change don't need more
const PCM_RATE = 48000;       // playback sample rate (raw s16le stereo)
let FFMPEG = 'ffmpeg';        // overridden by setFfmpegPath()

function setFfmpegPath(p){ if(p) FFMPEG = p; }

// probe the binary once: does it exist, and does it speak SRT?
function probe(cb){
  execFile(FFMPEG, ['-hide_banner','-protocols'], { maxBuffer: 4<<20 }, (err, stdout) => {
    if(err) return cb({ ok:false, error:'ffmpeg not found at "'+FFMPEG+'"' });
    const protos = String(stdout);
    cb({ ok:true, srt:/(^|\s)srt(\s|$)/m.test(protos), rtsp:/(^|\s)rtsp(\s|$)/m.test(protos) });
  });
}

// common input args: low-latency, tolerant reconnect, TCP for rtsp
function inputArgs(url){
  const a = [];
  if(/^rtsp:/i.test(url)) a.push('-rtsp_transport','tcp');
  a.push('-flags','low_delay','-analyzeduration','1000000','-probesize','1000000');
  a.push('-i', url);
  return a;
}

class Feed {
  // onFrame({courtId, buf, w, h}); onAudio({courtId, momentary, shortTerm, peak}); onStatus({courtId, state, detail})
  constructor(courtId, url, { onFrame, onAudio, onStatus }){
    Object.assign(this, { courtId, url, onFrame, onAudio, onStatus });
    this.h = FRAME_H;
    this.frameBytes = FRAME_W * FRAME_H * 4;
    this.vproc = null; this.aproc = null; this.alive = false;
    this.buf = Buffer.alloc(0); this.lastFrame = 0; this.backoff = 500;
  }

  start(){
    this.alive = true;
    this._startVideo();
    this._startAudio();
    this._watch = setInterval(() => {
      if(!this.alive) return;
      const gap = Date.now() - this.lastFrame;
      if(this.lastFrame && gap > 4000) this.onStatus({ courtId:this.courtId, state:'NO FRAMES', detail:gap+'ms' });
    }, 1000);
  }

  _startVideo(){
    if(!this.alive) return;
    const args = ['-hide_banner','-loglevel','error', ...inputArgs(this.url),
      '-an','-vf',`scale=${FRAME_W}:${FRAME_H},fps=${FPS}`,'-f','rawvideo','-pix_fmt','rgba','pipe:1'];
    const p = spawn(FFMPEG, args); this.vproc = p;
    p.stdout.on('data', d => this._onVideoData(d));
    p.stderr.on('data', d => { const s=String(d); if(/Output #0.*rawvideo/.test(s)){} });
    p.on('close', () => { if(this.alive){ this.onStatus({courtId:this.courtId,state:'RECONNECT'});
      setTimeout(()=>this._startVideo(), this.backoff); this.backoff=Math.min(5000,this.backoff*1.6); } });
  }

  _onVideoData(d){
    this.backoff = 500;
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while(this.buf.length >= this.frameBytes){
      const frame = this.buf.subarray(0, this.frameBytes);
      this.buf = this.buf.subarray(this.frameBytes);
      this.lastFrame = Date.now();
      // TRUE freeze: consecutive decoded frames byte-identical → the source is repeating a
      // held frame. This is the frame-accurate signal screen-capture never had.
      let identical = false;
      if(this._prevFrame && this._prevFrame.length === frame.length){
        identical = this._prevFrame.equals(frame);
      }
      if(identical){
        if(!this._frozenSince) this._frozenSince = this.lastFrame;
      } else {
        if(this._frozenSince){ this._frozenSince = 0; this.onStatus({courtId:this.courtId, state:'LIVE'}); }
      }
      this._prevFrame = Buffer.from(frame);
      const frozenMs = this._frozenSince ? (this.lastFrame - this._frozenSince) : 0;
      const out = Buffer.from(frame);
      this.onFrame({ courtId:this.courtId, buf:out, w:FRAME_W, h:this.h, frozenMs });
    }
  }

  _startAudio(){
    if(!this.alive) return;
    // astats + ametadata=print streams per-channel RMS/Peak (dBFS) continuously on stdout.
    // dBFS matches the v8 thresholds and gives us level, clip (peak) and per-channel life.
    // Flat_factor is astats' purpose-built distortion/clipping metric — it measures runs of
    // consecutive identical (flat-topped) samples, which is the actual signature of clipping,
    // as opposed to a raw peak-loudness threshold that also fires on legitimately loud audio.
    const args = ['-hide_banner','-loglevel','error', ...inputArgs(this.url),
      '-vn','-af','astats=metadata=1:reset=6,ametadata=print:file=-','-f','null','-'];
    const p = spawn(FFMPEG, args); this.aproc = p;
    this._abuf = ''; this._ch = [];
    p.stdout.on('data', d => this._onAudioData(String(d)));
    p.on('close', () => { if(this.alive) setTimeout(()=>this._startAudio(), 800); });
  }

  _onAudioData(s){
    const num = v => (v==='-inf'||v==='inf'||v==null||v==='nan') ? -120 : parseFloat(v);
    this._abuf = (this._abuf || '') + s;
    const lines = this._abuf.split('\n'); this._abuf = lines.pop();
    for(const ln of lines){
      let m;
      // field order within astats' metadata output is fixed (...Peak_level, RMS_level,
      // RMS_peak, RMS_trough, Crest_factor, Flat_factor...) — Flat_factor prints last of the
      // fields we care about, so triggering the emit there (not at Peak_level) guarantees
      // every field below belongs to the same stats frame
      if((m = ln.match(/astats\.(\d+)\.RMS_level=(-?\d+(?:\.\d+)?|-?inf)/))) { this._ch[+m[1]-1] = num(m[2]); }
      else if((m = ln.match(/astats\.Overall\.RMS_level=(-?\d+(?:\.\d+)?|-?inf)/))) { this._ovRms = num(m[1]); }
      else if((m = ln.match(/astats\.Overall\.Peak_level=(-?\d+(?:\.\d+)?|-?inf)/))) { this._ovPeak = num(m[1]); }
      else if((m = ln.match(/astats\.Overall\.Flat_factor=(-?\d+(?:\.\d+)?|nan|-?inf)/))) {
        this.onAudio({ courtId:this.courtId,
          momentary: this._ovRms==null?-120:this._ovRms,   // dBFS RMS (kept name for UI compat)
          rms: this._ovRms==null?-120:this._ovRms,
          peak: this._ovPeak==null?-120:this._ovPeak,
          flatFactor: m[1]==='nan' ? 0 : num(m[1]),
          channels: this._ch.slice(),
          channelCount: this._ch.length });
        this._ch = [];
      }
    }
  }

  // ---- audible playback (separate ffmpeg, opt-in — the astats process above never carries audio through) ----
  startPlayback(onPCM){
    this.onPCM = onPCM; this._playWanted = true;
    this._startPlayback();
  }
  stopPlayback(){
    this._playWanted = false;
    try{ this.pproc && this.pproc.kill('SIGKILL'); }catch(e){}
    this.pproc = null;
  }
  _startPlayback(){
    if(!this.alive || !this._playWanted || this.pproc) return;
    const args = ['-hide_banner','-loglevel','error', ...inputArgs(this.url),
      '-vn','-af','aresample=async=1','-f','s16le','-ar',String(PCM_RATE),'-ac','2','pipe:1'];
    const p = spawn(FFMPEG, args); this.pproc = p;
    p.stdout.on('data', d => { if(this.onPCM) this.onPCM(d); });
    p.on('close', () => { this.pproc = null; if(this.alive && this._playWanted) setTimeout(()=>this._startPlayback(), 800); });
  }

  stop(){
    this.alive = false;
    clearInterval(this._watch);
    try{ this.vproc && this.vproc.kill('SIGKILL'); }catch(e){}
    try{ this.aproc && this.aproc.kill('SIGKILL'); }catch(e){}
    this.stopPlayback();
  }
}

module.exports = { setFfmpegPath, probe, Feed, FRAME_W, FPS, PCM_RATE };
