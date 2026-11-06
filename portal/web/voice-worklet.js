// The AudioWorklet that carries the microphone to voice.js: whatever rate the AudioContext runs at (48 kHz, 44.1 kHz, ...), the sound is
// low-passed, resampled to 16 kHz mono and cut into PCM16 frames of 640 samples (40 ms, 1280 bytes), posted with their loudness (RMS, 0..1).
// See docs/VOICE.md, "Browser protocol". Nothing here allocates per sample: this runs on the audio thread.

/** A 4th-order Butterworth low-pass (two biquads, transposed direct form II): what is above the new Nyquist must not fold back in. */
class LowPass {
  constructor(rate, cutoff) {
    this.a = LowPass.section(rate, cutoff, 0.5411961);
    this.b = LowPass.section(rate, cutoff, 1.3065630);
  }

  static section(rate, cutoff, q) {
    const w = (2 * Math.PI * cutoff) / rate;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    return { b0: (1 - cos) / 2 / a0, b1: (1 - cos) / a0, b2: (1 - cos) / 2 / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0, z1: 0, z2: 0 };
  }

  static run(s, x) {
    const y = s.b0 * x + s.z1;
    s.z1 = s.b1 * x - s.a1 * y + s.z2;
    s.z2 = s.b2 * x - s.a2 * y;
    // silence decays into denormals, which some CPUs handle hundreds of times slower
    if (s.z1 > -1e-20 && s.z1 < 1e-20) s.z1 = 0;
    if (s.z2 > -1e-20 && s.z2 < 1e-20) s.z2 = 0;
    return y;
  }

  next(x) {
    return LowPass.run(this.b, LowPass.run(this.a, x));
  }
}

class TaiCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.outRate = opts.rate || 16000;
    this.frameSize = opts.frame || 640;
    this.step = sampleRate / this.outRate;            // input samples per output sample (sampleRate: the context's, a worklet global)
    this.t = 0;                                         // where the next output sample falls, in input samples from this block's start
    this.prev = 0;                                      // the last (filtered) input sample of the block before
    this.filter = this.step > 1.05 ? new LowPass(sampleRate, Math.min(7200, this.outRate * 0.45)) : null;
    this.block = new Float32Array(128);
    this.frame = new Int16Array(this.frameSize);
    this.filled = 0;
    this.energy = 0;
  }

  process(inputs) {
    const input = inputs[0];
    const channel = input && input[0];
    if (!channel || !channel.length) return true;      // no microphone yet (or between devices): keep running
    let x = channel;
    if (this.filter) {
      if (this.block.length !== channel.length) this.block = new Float32Array(channel.length);
      for (let i = 0; i < channel.length; i++) this.block[i] = this.filter.next(channel[i]);
      x = this.block;
    }
    // linear interpolation at fractional positions, the position carried from block to block (t in [-1, 0) reaches back to `prev`)
    const last = x.length - 1;
    let t = this.t;
    while (t < last) {
      const i = Math.floor(t);
      const f = t - i;
      const a = i < 0 ? this.prev : x[i];
      this.push(a + (x[i + 1] - a) * f);
      t += this.step;
    }
    this.t = t - x.length;
    this.prev = x[last];
    return true;
  }

  push(sample) {
    const v = sample > 1 ? 1 : sample < -1 ? -1 : sample;
    this.frame[this.filled++] = v < 0 ? v * 0x8000 : v * 0x7fff;
    this.energy += v * v;
    if (this.filled === this.frameSize) {
      const pcm = this.frame.buffer;
      this.port.postMessage({ pcm, level: Math.sqrt(this.energy / this.frameSize) }, [pcm]);
      this.frame = new Int16Array(this.frameSize);
      this.filled = 0;
      this.energy = 0;
    }
  }
}

registerProcessor('tai-capture', TaiCapture);
