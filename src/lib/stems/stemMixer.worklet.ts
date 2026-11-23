/**
 * AudioWorklet that mixes every stem of a song in one render loop (see mixCore.ts). The main
 * thread (stemPlayer.ts) feeds it decoded chunks and transport commands over its port; it
 * reports the playhead, underruns and the end of the song back.
 */
import { createMixState, removeStem, renderBlock, setStem, type LoopRegion, type MixState } from './mixCore';

// Minimal AudioWorkletGlobalScope typings (not part of TypeScript's DOM lib).
declare const sampleRate: number;
declare const currentTime: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}
declare function registerProcessor(name: string, processor: new (options?: unknown) => AudioWorkletProcessor): void;

export type MixerCommand =
  | { type: 'config'; chunkSize: number; stemRate: number; totalSamples: number; stems: Array<{ id: string; channels: number; totalSamples: number; gain: number }> }
  | { type: 'chunk'; stemId: string; index: number; channels: Float32Array[] }
  | { type: 'drop'; stemId: string; index: number }
  | { type: 'removeStem'; stemId: string }
  | { type: 'gains'; gains: Record<string, number> }
  | { type: 'master'; value: number }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'seek'; position: number }
  | { type: 'loop'; loop: LoopRegion | null };

export interface MixerReport {
  type: 'state';
  position: number;
  /** AudioContext time of this report, for interpolating the playhead on the main thread. */
  time: number;
  playing: boolean;
  underrun: boolean;
  ended: boolean;
}

/** Report the playhead every this many render quanta (~50 ms at 44.1 kHz). */
const REPORT_EVERY = 16;

class StemMixerProcessor extends AudioWorkletProcessor {
  private state: MixState | null = null;
  private blocks = 0;
  private underrun = false;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<MixerCommand>) => this.command(event.data);
  }

  private command(cmd: MixerCommand): void {
    if (cmd.type === 'config') {
      const state = createMixState({ chunkSize: cmd.chunkSize, stemRate: cmd.stemRate, outputRate: sampleRate });
      state.totalSamples = cmd.totalSamples;
      for (const stem of cmd.stems) {
        setStem(state, stem.id, { channels: stem.channels, totalSamples: stem.totalSamples, chunks: new Map(), gain: stem.gain, targetGain: stem.gain });
      }
      this.state = state;
      return;
    }
    const state = this.state;
    if (!state) return;
    switch (cmd.type) {
      case 'chunk':
        state.stems.get(cmd.stemId)?.chunks.set(cmd.index, cmd.channels);
        return;
      case 'drop':
        state.stems.get(cmd.stemId)?.chunks.delete(cmd.index);
        return;
      case 'removeStem':
        removeStem(state, cmd.stemId);
        return;
      case 'gains':
        for (const [id, gain] of Object.entries(cmd.gains)) {
          const stem = state.stems.get(id);
          if (stem) stem.targetGain = gain;
        }
        return;
      case 'master':
        state.targetMaster = cmd.value;
        return;
      case 'play':
        if (!state.loop && state.position >= state.totalSamples) state.position = 0;
        state.playing = true;
        break;
      case 'pause':
        state.playing = false;
        break;
      case 'seek':
        state.position = Math.max(0, Math.min(Math.floor(cmd.position), state.totalSamples));
        state.frac = 0;
        break;
      case 'loop':
        state.loop = cmd.loop;
        if (cmd.loop && state.position >= cmd.loop.end) {
          state.position = cmd.loop.start;
          state.frac = 0;
        }
        break;
    }
    this.report(false);
  }

  private report(ended: boolean): void {
    const state = this.state;
    if (!state) return;
    const message: MixerReport = {
      type: 'state',
      position: state.position,
      time: currentTime,
      playing: state.playing,
      underrun: this.underrun,
      ended,
    };
    this.port.postMessage(message);
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    const left = output[0];
    const right = output[1] ?? output[0];
    if (!this.state) {
      left.fill(0);
      right.fill(0);
      return true;
    }
    const result = renderBlock(this.state, left, right);
    const underrun = result === 'underrun';
    const changed = underrun !== this.underrun;
    this.underrun = underrun;
    this.blocks += 1;
    if (result === 'ended' || changed || (this.state.playing && this.blocks % REPORT_EVERY === 0)) {
      this.report(result === 'ended');
    }
    return true;
  }
}

registerProcessor('stem-mixer', StemMixerProcessor);
