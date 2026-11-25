/**
 * The stem mixer's arithmetic, kept free of Web Audio so it can be tested in node. The
 * AudioWorklet (stemMixer.worklet.ts) runs `renderBlock` for every render quantum: all stems are
 * read at the same integer sample position, so they can never drift apart. Missing audio for any
 * stem holds the playhead for all of them (an underrun), never for one stem alone.
 */

export interface LoopRegion {
  /** First sample of the loop. */
  start: number;
  /** Sample after the last one played before jumping back to `start`. */
  end: number;
}

export interface MixStem {
  channels: number;
  totalSamples: number;
  /** Decoded chunks by index; chunk k holds samples [k·chunkSize, (k+1)·chunkSize). */
  chunks: Map<number, Float32Array[]>;
  gain: number;
  targetGain: number;
}

export interface MixState {
  chunkSize: number;
  /** Length of the song: the longest stem. */
  totalSamples: number;
  /** Playhead in stem samples. */
  position: number;
  /**
   * Fraction of a stem sample, as a whole number of 1/(outputRate·100) steps, when the output
   * runs at a different rate than the stems or at another speed. Integer arithmetic keeps the
   * playhead exact over hours.
   */
  frac: number;
  stemRate: number;
  outputRate: number;
  /**
   * Playback speed in whole percent (100 = as recorded). This is varispeed: it changes the pitch
   * too, which the player corrects after the mixer (see stemPlayer.ts).
   */
  speed: number;
  playing: boolean;
  loop: LoopRegion | null;
  master: number;
  targetMaster: number;
  /** Per-output-frame smoothing factor for gain changes (~5 ms). */
  smoothing: number;
  /** Stems by id. Add and remove them with setStem/removeStem so `stemList` stays in step. */
  stems: Map<string, MixStem>;
  /** The same stems as a plain array: the render loop iterates it without allocating. */
  stemList: MixStem[];
}

export type BlockResult = 'idle' | 'played' | 'underrun' | 'ended';

export function createMixState(options: { chunkSize: number; stemRate: number; outputRate: number }): MixState {
  return {
    chunkSize: options.chunkSize,
    totalSamples: 0,
    position: 0,
    frac: 0,
    stemRate: options.stemRate,
    outputRate: options.outputRate,
    speed: 100,
    playing: false,
    loop: null,
    master: 1,
    targetMaster: 1,
    smoothing: 1 - Math.exp(-1 / (0.005 * options.outputRate)),
    stems: new Map(),
    stemList: [],
  };
}

export function setStem(state: MixState, id: string, stem: MixStem): void {
  state.stems.set(id, stem);
  state.stemList = [...state.stems.values()];
}

export function removeStem(state: MixState, id: string): void {
  state.stems.delete(id);
  state.stemList = [...state.stems.values()];
}

/** The sample played after `position`, honouring the loop. */
export function nextPosition(position: number, loop: LoopRegion | null): number {
  const next = position + 1;
  return loop && position < loop.end && next >= loop.end ? loop.start : next;
}

function chunkPresentForAll(state: MixState, index: number): boolean {
  const list = state.stemList;
  for (let s = 0; s < list.length; s++) {
    const stem = list[s];
    if (index * state.chunkSize < stem.totalSamples && !stem.chunks.has(index)) return false;
  }
  return true;
}

/**
 * True when every stem has the chunks needed to play `frames` output frames from the playhead.
 * Runs on the audio thread every render quantum, so it allocates nothing.
 */
export function hasAudioFor(state: MixState, frames: number): boolean {
  const needed = Math.ceil((state.frac + frames * state.stemRate * state.speed) / (state.outputRate * 100)) + 1;
  let lastIndex = -1;
  let p = state.position;
  for (let i = 0; i <= needed; i++) {
    if (p < state.totalSamples) {
      const index = Math.floor(p / state.chunkSize);
      if (index !== lastIndex) {
        if (!chunkPresentForAll(state, index)) return false;
        lastIndex = index;
      }
    }
    p = nextPosition(p, state.loop);
  }
  return true;
}

function sampleAt(stem: MixStem, chunkSize: number, position: number, channel: number): number {
  if (position >= stem.totalSamples) return 0;
  const chunk = stem.chunks.get(Math.floor(position / chunkSize));
  if (!chunk) return 0;
  const data = chunk[Math.min(channel, chunk.length - 1)];
  return data[position % chunkSize] ?? 0;
}

/** Mixes one render quantum into `left`/`right` and advances the playhead. */
export function renderBlock(state: MixState, left: Float32Array, right: Float32Array): BlockResult {
  left.fill(0);
  right.fill(0);
  if (!state.playing) return 'idle';
  if (!state.loop && state.position >= state.totalSamples) {
    state.playing = false;
    return 'ended';
  }
  if (!hasAudioFor(state, left.length)) return 'underrun';

  const { chunkSize, smoothing } = state;
  const step = state.stemRate * state.speed;
  const unit = state.outputRate * 100;
  const stems = state.stemList;
  const interpolate = step !== unit;
  for (let i = 0; i < left.length; i++) {
    const p = state.position;
    const p1 = interpolate ? nextPosition(p, state.loop) : p;
    const t = state.frac / unit;
    let l = 0;
    let r = 0;
    for (let s = 0; s < stems.length; s++) {
      const stem = stems[s];
      stem.gain += (stem.targetGain - stem.gain) * smoothing;
      if (stem.gain === 0 && stem.targetGain === 0) continue;
      let sl = sampleAt(stem, chunkSize, p, 0);
      let sr = stem.channels > 1 ? sampleAt(stem, chunkSize, p, 1) : sl;
      if (interpolate && t > 0) {
        const nl = sampleAt(stem, chunkSize, p1, 0);
        const nr = stem.channels > 1 ? sampleAt(stem, chunkSize, p1, 1) : nl;
        sl += (nl - sl) * t;
        sr += (nr - sr) * t;
      }
      l += sl * stem.gain;
      r += sr * stem.gain;
    }
    state.master += (state.targetMaster - state.master) * smoothing;
    left[i] = l * state.master;
    right[i] = r * state.master;

    state.frac += step;
    while (state.frac >= unit) {
      state.frac -= unit;
      state.position = nextPosition(state.position, state.loop);
    }
    if (!state.loop && state.position >= state.totalSamples) {
      state.playing = false;
      return 'ended';
    }
  }
  return 'played';
}

/**
 * Chunk indices needed to play `lookahead` samples from `position`, in the order they'll be
 * played (with a loop, the chunks at the loop start follow the ones before its end).
 */
export function chunksAhead(
  position: number,
  lookahead: number,
  chunkSize: number,
  totalSamples: number,
  loop: LoopRegion | null,
): number[] {
  const order: number[] = [];
  const add = (from: number, to: number) => {
    for (let k = Math.floor(from / chunkSize); k * chunkSize < to; k++) if (!order.includes(k)) order.push(k);
  };
  let remaining = lookahead;
  let from = Math.min(position, totalSamples);
  if (loop && from < loop.end) {
    while (remaining > 0) {
      const to = Math.min(loop.end, from + remaining);
      add(from, to);
      remaining -= to - from;
      from = loop.start;
      if (loop.end - loop.start <= 0) break;
    }
  } else {
    add(from, Math.min(totalSamples, from + remaining));
  }
  return order;
}
