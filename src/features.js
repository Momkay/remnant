// Pure audio-feature maths: no Web Audio objects, so Node can import and test it.
// Input per frame: the dB spectrum of one analyser and a time-domain window. Output: 48 band levels and loudness.

// Spectrum: NB log-spaced bands from F0 to F1, one shared gain so the bands keep their relative heights.
export const NB = 48, F0 = 40, F1 = 16000;
const TILT_DB_OCT = 2.5;   // music falls about 3 dB per octave: lift the highs so they can show
const BAND_RANGE_DB = 50;  // dB below the loudest band that still shows
const BAND_MS = [10, 150]; // attack, release
const RMS_MS = [60, 400];

export class Features {
  constructor(opts = {}) {
    this.gateDb = opts.gateDb ?? -60;
    this.minDb = opts.minDb ?? -100;
    this.sensitivity = 1;
    this.bands = new Float32Array(NB);
    this.out = { rms: 0, silent: true, silentFor: 0, bands: this.bands };
    this.rawBands = new Float32Array(NB);
    this.bandHi = -100;      // loudest band so far: rises at once, relaxes over about 8 s
    this.rmsEnv = 0; this.rmsLo = 1; this.rmsHi = 0;
  }

  _db(v) { return Number.isFinite(v) ? Math.max(v, this.minDb) : this.minDb; }

  // Slow rolling min/max (about 8 s) so loudness is relative to the track, not to the volume knob.
  _normRms(x, dt) {
    const a = 1 - Math.exp(-dt / 8);
    if (x > this.rmsHi) this.rmsHi = x; else this.rmsHi += (x - this.rmsHi) * a;
    if (x < this.rmsLo) this.rmsLo = x; else this.rmsLo += (x - this.rmsLo) * a;
    const span = this.rmsHi - this.rmsLo;
    return span > 1e-4 ? (x - this.rmsLo) / span : 0;
  }

  // Mean dB per log band, relative to the loudest band, smoothed with one attack and release.
  _bands(big, binBig, gated, dt) {
    const rb = this.rawBands;
    if (!gated) {
      let top = -Infinity;
      for (let b = 0; b < NB; b++) {
        const f0 = F0 * (F1 / F0) ** (b / NB), f1 = F0 * (F1 / F0) ** ((b + 1) / NB);
        const lo = Math.max(1, Math.floor(f0 / binBig));
        const hi = Math.min(big.length, Math.max(lo + 1, Math.ceil(f1 / binBig)));
        let s = 0;
        for (let i = lo; i < hi; i++) s += 10 ** (this._db(big[i]) / 20);
        rb[b] = 20 * Math.log10(s / (hi - lo) + 1e-9) + TILT_DB_OCT * Math.log2(Math.sqrt(f0 * f1) / F0);
        if (rb[b] > top) top = rb[b];
      }
      if (top > this.bandHi) this.bandHi = top; else this.bandHi += (top - this.bandHi) * (1 - Math.exp(-dt / 8));
    }
    for (let b = 0; b < NB; b++) {
      const x = gated ? 0 : Math.min(1, Math.max(0, (rb[b] - (this.bandHi - BAND_RANGE_DB)) / BAND_RANGE_DB));
      const tau = (x > this.bands[b] ? BAND_MS[0] : BAND_MS[1]) / 1000;
      this.bands[b] += (x - this.bands[b]) * (1 - Math.exp(-dt / tau));
    }
  }

  update(big, td, sr, dt) {
    const o = this.out;
    let sum2 = 0;
    for (let i = 0; i < td.length; i++) sum2 += td[i] * td[i];
    const rmsLin = Math.sqrt(sum2 / td.length);
    const gated = !(20 * Math.log10(rmsLin + 1e-12) > this.gateDb);

    this._bands(big, sr / 2 / big.length, gated, dt);

    const raw = gated ? 0 : this._normRms(Math.max(0, (20 * Math.log10(rmsLin + 1e-9) + 80) / 80), dt);
    this.rmsEnv += (raw - this.rmsEnv) * (1 - Math.exp(-dt / ((raw > this.rmsEnv ? RMS_MS[0] : RMS_MS[1]) / 1000)));
    o.rms = Math.min(1, this.rmsEnv * this.sensitivity);
    o.silent = gated;
    o.silentFor = gated ? o.silentFor + dt : 0;
    return o;
  }
}

// A kick: bass is high, just jumped, the music is on, and the last kick is over.
export const isKick = (bass, prevBass, live, cooldown, c) => live > 0.3 && bass > c.kickAt && bass - prevBass > c.kickRise && cooldown <= 0;

// Tension 0..1 from the seconds since the last kick: a gap in the beat (a breakdown or a build) winds the cloud up over about 4 s.
// If no kick ever comes (ambient music) it lets go again after 12 to 20 s.
const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
export const tension = (sinceKick) => ss(1, 5, sinceKick) * (1 - ss(12, 20, sinceKick));
