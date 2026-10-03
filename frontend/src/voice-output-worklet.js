// Self-contained ES module: Vite emits this as a hashed AudioWorklet asset.
// The exported queue is also exercised with exact PCM samples in Node tests.
export class VoiceOutputQueue {
  constructor(rate, seconds = 30) {
    this.rate = rate;
    this.data = new Float32Array(Math.ceil(rate * seconds));
    this.preroll = Math.min(this.data.length, Math.ceil(rate * 0.2));
    this.mode = "discard";
    this.head = 0;
    this.size = 0;
    this.started = false;
    this.receivedFrames = 0;
    this.playedFrames = 0;
    this.playedThroughFrame = 0;
    this.discardedFrames = 0;
    this.overflows = 0;
  }
  clear() {
    this.discardedFrames += this.size;
    this.head = this.size = 0;
    this.started = false;
  }
  command(command) {
    if (
      command === "discard" ||
      (command === "discard-pending" && this.mode === "hold")
    ) {
      this.clear();
      this.mode = "discard";
    } else if (command === "hold" && this.mode === "discard") {
      this.mode = "hold";
    } else if (command === "play" && this.mode !== "overflow") {
      this.mode = "play";
    }
  }
  process(input, output = new Float32Array(input.length)) {
    output.fill(0);
    this.receivedFrames += input.length;
    if (this.mode === "discard" || this.mode === "overflow") {
      this.discardedFrames += input.length;
      return output;
    }
    for (const value of input) {
      if (Math.abs(value) > 0.0001) this.started = true;
      // Retain quiet word onsets, without queuing seconds of idle silence.
      if (this.mode === "hold" && !this.started && this.size >= this.preroll) {
        this.head = (this.head + 1) % this.data.length;
        this.size--;
        this.discardedFrames++;
      }
      if (this.size === this.data.length) {
        this.clear();
        this.mode = "overflow";
        this.overflows++;
        return output;
      }
      this.data[(this.head + this.size++) % this.data.length] = value;
    }
    if (this.mode === "play") {
      const count = Math.min(output.length, this.size);
      for (let i = 0; i < count; i++) {
        output[i] = this.data[this.head];
        this.head = (this.head + 1) % this.data.length;
      }
      this.size -= count;
      this.playedFrames += count;
      this.playedThroughFrame = this.receivedFrames - this.size;
    }
    return output;
  }
  snapshot() {
    return {
      mode: this.mode,
      bufferedFrames: this.size,
      bufferedMs: Math.round((this.size * 1000) / this.rate),
      receivedFrames: this.receivedFrames,
      playedFrames: this.playedFrames,
      playedThroughFrame: this.playedThroughFrame,
      discardedFrames: this.discardedFrames,
      overflows: this.overflows,
    };
  }
}

/** Stateful linear conversion keeps packet boundaries continuous. */
export class PcmResampler {
  constructor(from, to) {
    this.step = from / to;
    this.phase = 0;
    this.previous = undefined;
  }
  process(input) {
    const result = [];
    for (const sample of input) {
      if (this.previous !== undefined) {
        while (this.phase < 1) {
          result.push(this.previous + (sample - this.previous) * this.phase);
          this.phase += this.step;
        }
        this.phase -= 1;
      }
      this.previous = sample;
    }
    return Float32Array.from(result);
  }
}
if (typeof registerProcessor === "function") {
  registerProcessor(
    "aside-voice-input",
    class extends AudioWorkletProcessor {
      constructor() {
        super();
        this.enabled = false;
        this.packet = new Int16Array(640);
        this.offset = 0;
        this.resampler = new PcmResampler(sampleRate, 16000);
        this.port.onmessage = ({ data }) => {
          this.enabled = data.enabled;
          this.offset = 0;
          this.resampler = new PcmResampler(sampleRate, 16000);
        };
      }
      process(inputs) {
        const input = inputs[0]?.[0];
        if (!this.enabled || !input) return true;
        for (const sample of this.resampler.process(input)) {
          this.packet[this.offset++] = Math.round(
            Math.max(-1, Math.min(1, sample)) * 32767,
          );
          if (this.offset === this.packet.length) {
            this.port.postMessage(this.packet.buffer, [this.packet.buffer]);
            this.packet = new Int16Array(640);
            this.offset = 0;
          }
        }
        return true;
      }
    },
  );
  registerProcessor(
    "aside-voice-output",
    class extends AudioWorkletProcessor {
      constructor() {
        super();
        this.queue = new VoiceOutputQueue(sampleRate);
        this.resampler = new PcmResampler(24000, sampleRate);
        this.epoch = 0;
        this.active = false;
        this.quiet = 0;
        this.ticks = 0;
        this.port.onmessage = ({ data }) => {
          if (data.audio) {
            if (data.epoch !== this.epoch) return;
            const view = new DataView(data.audio),
              input = new Float32Array(view.byteLength / 2);
            for (let i = 0; i < input.length; i++)
              input[i] = view.getInt16(i * 2, true) / 32768;
            this.queue.process(
              this.resampler.process(input),
              new Float32Array(0),
            );
            this.report();
            return;
          }
          this.epoch = data.epoch;
          this.queue.command(data.command);
          if (this.queue.mode !== "play") this.active = false;
          this.report();
        };
      }
      report() {
        this.port.postMessage({
          epoch: this.epoch,
          active: this.active,
          ...this.queue.snapshot(),
        });
      }
      process(inputs, outputs) {
        const output = outputs[0][0];
        this.queue.process(inputs[0][0] ?? new Float32Array(0), output);
        let energy = 0;
        for (const x of output) energy += x * x;
        const loud = energy / output.length > 0.008 ** 2;
        this.quiet = loud ? 0 : this.quiet + output.length;
        const active =
          this.queue.mode === "play" &&
          (loud || (this.active && this.quiet < sampleRate * 0.9));
        if (active !== this.active) {
          this.active = active;
          this.report();
        } else if ((this.ticks += output.length) >= sampleRate / 10) {
          this.ticks = 0;
          this.report();
        }
        return true;
      }
    },
  );
}
