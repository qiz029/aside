export type OutputCommand = "hold" | "play" | "discard" | "discard-pending";
export interface OutputBufferState {
  mode: "hold" | "play" | "discard" | "overflow";
  bufferedFrames: number;
  bufferedMs: number;
  receivedFrames: number;
  playedFrames: number;
  playedThroughFrame: number;
  discardedFrames: number;
  overflows: number;
}
export class VoiceOutputQueue {
  constructor(rate: number, seconds?: number);
  command(command: OutputCommand): void;
  process(input: Float32Array, output?: Float32Array): Float32Array;
  snapshot(): OutputBufferState;
}
