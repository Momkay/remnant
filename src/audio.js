import { Features } from './features.js';

const RAW = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };

// Errors are plain codes; ui.js maps them to the copy deck.
export class AudioInput {
  constructor() {
    this.features = new Features();
    this.ctx = null;
    this.stream = null;
    this.source = null;
    this.big = null;
    this.bigData = null; this.td = null;
    this.kind = null;       // 'display' | 'mic' | null
    this.onended = null;
    this.paused = false;
  }

  static get canShare() { return !!(window.isSecureContext && navigator.mediaDevices?.getDisplayMedia); }
  static get canMic() { return !!(window.isSecureContext && navigator.mediaDevices?.getUserMedia); }

  // Resolves to { ok: true } or { ok: false, code }. Must be called from a user gesture.
  async start(kind) {
    if (!window.isSecureContext) return { ok: false, code: 'insecure' };
    let stream;
    try {
      if (kind === 'display') {
        if (!AudioInput.canShare) return { ok: false, code: 'unsupported' };
        stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });   // shortcut: audio constraints (RAW) were my guess for the Windows NotReadableError; untested
        stream.getVideoTracks().forEach((t) => t.stop());   // audio only
        if (!stream.getAudioTracks().length) { return { ok: false, code: 'nosound' }; }
      } else {
        if (!AudioInput.canMic) return { ok: false, code: 'unsupported' };
        stream = await navigator.mediaDevices.getUserMedia({ audio: RAW });
      }
    } catch (e) {
      console.error('soot capture failed:', kind, e.name, e.message);
      if (e.name === 'NotFoundError' || e.name === 'OverconstrainedError') return { ok: false, code: 'nomic' };
      if (kind === 'mic' && e.name === 'NotAllowedError') return { ok: false, code: 'blocked' };
      if (e.name === 'NotAllowedError' || e.name === 'AbortError') return { ok: false, code: 'cancelled' };    // picker dismissed: not an error
      return { ok: false, code: 'failed' };
    }
    try {
      this.ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)();
      await this.ctx.resume();
    } catch (e) {
      console.error('soot audio context failed:', e);
      stream.getTracks().forEach((t) => t.stop());   // do not leave the share or mic open
      return { ok: false, code: 'failed' };
    }
    this.stop();   // only now: a cancelled picker or a failed context must not kill the running source
    this.stream = stream;
    this.kind = kind;
    // Never connect to destination: that would echo the mic or double system audio.
    this.source = this.ctx.createMediaStreamSource(stream);
    this.big = this.ctx.createAnalyser();
    this.big.fftSize = 8192; this.big.smoothingTimeConstant = 0;
    this.source.connect(this.big);
    this.bigData = new Float32Array(this.big.frequencyBinCount);
    this.td = new Float32Array(this.big.fftSize);
    this.tdTail = this.td.subarray(this.td.length - 1024);   // the newest 1024 samples (about 21 ms): loudness without lag
    this.features = new Features();
    stream.getAudioTracks()[0].addEventListener('ended', () => { const k = this.kind; this.stop(); this.onended?.(k); });
    return { ok: true };
  }

  stop() {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.source) this.source.disconnect();
    this.stream = this.source = this.big = null;
    this.kind = null;
  }

  get active() { return !!this.stream; }

  // Zero features when nothing is connected, so the idle plume takes over.
  update(dt) {
    if (!this.big || this.paused) return this.features.out;
    this.big.getFloatFrequencyData(this.bigData);
    this.big.getFloatTimeDomainData(this.td);
    return this.features.update(this.bigData, this.tdTail, this.ctx.sampleRate, dt);
  }
}
