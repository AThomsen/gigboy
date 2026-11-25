// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chunksAhead, createMixState, nextPosition, removeStem, renderBlock, setStem, type MixState } from './mixCore';
import { openStreamDecoder } from './streamDecoder';

const BLOCK = 128;

/** Left channel of the fixtures' source signal (see streamDecoder.test.ts). */
function source(n: number): number {
  const click = [30000, 90000].some((c) => n >= c && n <= c + 7) ? 0.9 : 0;
  return 0.25 * Math.sin((2 * Math.PI * 440 * n) / 44100) + click;
}

/** A stem whose sample n is `value(n)` on every channel, split into chunks. */
function addStem(state: MixState, id: string, total: number, value: (n: number) => number, channels = 2) {
  const chunks = new Map<number, Float32Array[]>();
  for (let k = 0; k * state.chunkSize < total; k++) {
    const len = Math.min(state.chunkSize, total - k * state.chunkSize);
    const data = Float32Array.from({ length: len }, (_, i) => value(k * state.chunkSize + i));
    chunks.set(k, Array.from({ length: channels }, () => data.slice()));
  }
  setStem(state, id, { channels, totalSamples: total, chunks, gain: 1, targetGain: 1 });
  state.totalSamples = Math.max(state.totalSamples, total);
}

function render(state: MixState, blocks: number) {
  const left: number[] = [];
  const results: string[] = [];
  const l = new Float32Array(BLOCK);
  const r = new Float32Array(BLOCK);
  for (let b = 0; b < blocks; b++) {
    results.push(renderBlock(state, l, r));
    left.push(...l);
  }
  return { left, results };
}

describe('nextPosition', () => {
  it('wraps from the loop end to the loop start', () => {
    const loop = { start: 10, end: 20 };
    expect(nextPosition(18, loop)).toBe(19);
    expect(nextPosition(19, loop)).toBe(10);
    expect(nextPosition(25, loop)).toBe(26); // already past the loop
    expect(nextPosition(19, null)).toBe(20);
  });
});

describe('renderBlock', () => {
  it('reads every stem at the same sample and sums them with their gains', () => {
    const state = createMixState({ chunkSize: 1000, stemRate: 44100, outputRate: 44100 });
    addStem(state, 'a', 5000, (n) => n / 1e6);
    addStem(state, 'b', 5000, (n) => n / 1e6);
    state.stems.get('b')!.gain = state.stems.get('b')!.targetGain = 0.5;
    state.playing = true;
    const { left } = render(state, 20);
    left.forEach((value, n) => expect(value).toBeCloseTo((n / 1e6) * 1.5, 9));
    expect(state.position).toBe(20 * BLOCK);
  });

  it('crosses chunk boundaries sample-exactly', () => {
    const state = createMixState({ chunkSize: 100, stemRate: 48000, outputRate: 48000 });
    addStem(state, 'a', 1000, (n) => n);
    state.playing = true;
    const { left } = render(state, 5);
    expect(left).toEqual(Array.from({ length: 5 * BLOCK }, (_, n) => n));
  });

  it('loops gaplessly: the sample after loop end − 1 is the loop start', () => {
    const state = createMixState({ chunkSize: 64, stemRate: 44100, outputRate: 44100 });
    addStem(state, 'a', 1000, (n) => n);
    state.loop = { start: 300, end: 350 };
    state.position = 290;
    state.playing = true;
    const { left } = render(state, 2);
    const expected: number[] = [];
    let p = 290;
    for (let i = 0; i < 2 * BLOCK; i++) {
      expected.push(p);
      p = nextPosition(p, state.loop);
    }
    expect(left).toEqual(expected);
    expect(left.slice(0, 62)).toContain(349);
    expect(left[left.indexOf(349) + 1]).toBe(300);
  });

  it('holds the playhead for all stems while any stem is missing audio', () => {
    const state = createMixState({ chunkSize: 1000, stemRate: 44100, outputRate: 44100 });
    addStem(state, 'a', 5000, () => 0.1);
    addStem(state, 'b', 5000, () => 0.1);
    state.stems.get('b')!.chunks.delete(1);
    state.position = 900;
    state.playing = true;
    const { left, results } = render(state, 3);
    expect(results).toEqual(['underrun', 'underrun', 'underrun']);
    expect(left.every((v) => v === 0)).toBe(true);
    expect(state.position).toBe(900);
  });

  it('keeps playing the other stems after one is removed', () => {
    const state = createMixState({ chunkSize: 1000, stemRate: 44100, outputRate: 44100 });
    addStem(state, 'a', 5000, () => 0.25);
    addStem(state, 'b', 5000, () => 0.5);
    state.stems.get('b')!.chunks.clear(); // b never decodes…
    state.playing = true;
    expect(render(state, 1).results).toEqual(['underrun']);
    removeStem(state, 'b'); // …so the player takes it out
    const { left, results } = render(state, 1);
    expect(results).toEqual(['played']);
    expect(left[0]).toBeCloseTo(0.25);
  });

  it('plays stems shorter than the song as silence at the end, then ends', () => {
    const state = createMixState({ chunkSize: 1000, stemRate: 44100, outputRate: 44100 });
    addStem(state, 'long', 300, () => 0.25);
    addStem(state, 'short', 100, () => 0.5);
    state.playing = true;
    const { left, results } = render(state, 3);
    expect(left[99]).toBeCloseTo(0.75);
    expect(left[100]).toBeCloseTo(0.25);
    expect(results[2]).toBe('ended');
    expect(state.playing).toBe(false);
  });

  it('stays sample-locked when the output rate differs from the stem rate', () => {
    const state = createMixState({ chunkSize: 1000, stemRate: 44100, outputRate: 48000 });
    addStem(state, 'a', 20000, (n) => n);
    addStem(state, 'b', 20000, (n) => -n);
    state.playing = true;
    const { left } = render(state, 50);
    left.forEach((value) => expect(value).toBeCloseTo(0, 6)); // a and b cancel at every frame
    expect(state.position).toBe(Math.floor(50 * BLOCK * (44100 / 48000)));
  });

  it('advances the playhead by the speed and interpolates between samples', () => {
    const state = createMixState({ chunkSize: 1000, stemRate: 44100, outputRate: 44100 });
    addStem(state, 'a', 20000, (n) => n / 20000);
    state.speed = 75;
    state.playing = true;
    const { left } = render(state, 10);
    expect(state.position).toBe(Math.floor(10 * BLOCK * 0.75));
    // Output frame i plays source sample 0.75·i (a linear ramp, so interpolation is exact).
    for (const i of [1, 2, 3, 333, 1001]) expect(left[i]).toBeCloseTo((0.75 * i) / 20000, 6);
  });

  it('plays faster than recorded', () => {
    const state = createMixState({ chunkSize: 1000, stemRate: 44100, outputRate: 48000 });
    addStem(state, 'a', 40000, () => 0.5);
    state.speed = 150;
    state.playing = true;
    render(state, 20);
    expect(state.position).toBe(Math.floor(20 * BLOCK * (44100 / 48000) * 1.5));
  });
});

describe('chunksAhead', () => {
  it('lists the chunks in play order without a loop', () => {
    expect(chunksAhead(950, 2500, 1000, 10000, null)).toEqual([0, 1, 2, 3]);
    expect(chunksAhead(9500, 5000, 1000, 10000, null)).toEqual([9]);
  });

  it('follows the loop back to its start', () => {
    // 700 samples to the loop end, then 2300 from the loop start (1200–3500).
    expect(chunksAhead(4500, 3000, 1000, 10000, { start: 1200, end: 5200 })).toEqual([4, 5, 1, 2, 3]);
  });
});

describe('real stems through the mixer', () => {
  it('plays every fixture stem at the exact source sample through the mixer, after seeks too', async () => {
    const dir = join(__dirname, '__fixtures__');
    const chunkSize = 4096;
    const state = createMixState({ chunkSize, stemRate: 44100, outputRate: 44100 });
    for (const name of ['click-cbr', 'click-vbr']) {
      const bytes = new Uint8Array(readFileSync(join(dir, `${name}.mp3`)));
      const decoder = await openStreamDecoder({ size: bytes.length, read: async (s, e) => bytes.slice(s, e) });
      const chunks = new Map<number, Float32Array[]>();
      // Decode out of order, as seeks and loops would, to prove chunks are position-exact.
      const order = [7, 3, 21, 0, 22, 8, 1, 2, 4, 5, 6, ...Array.from({ length: 30 }, (_, i) => i + 9)];
      for (const k of order) {
        if (k * chunkSize >= decoder.info.totalSamples || chunks.has(k)) continue;
        chunks.set(k, await decoder.decodeRange(k * chunkSize, chunkSize));
      }
      decoder.free();
      setStem(state, name, { channels: 2, totalSamples: decoder.info.totalSamples, chunks, gain: 0, targetGain: 0 });
      state.totalSamples = decoder.info.totalSamples;
    }
    // Solo each stem in turn: output frame i after a seek to S must be source sample S + i.
    for (const solo of ['click-cbr', 'click-vbr']) {
      for (const stem of state.stems.values()) stem.gain = stem.targetGain = 0;
      const soloed = state.stems.get(solo)!;
      soloed.gain = soloed.targetGain = 1;
      for (const [seek, click] of [[29800, 30000], [89700, 90000]]) {
        state.position = seek;
        state.playing = true;
        const { left } = render(state, 8);
        let best = { lag: 0, err: Infinity };
        for (let lag = -20; lag <= 20; lag++) {
          let err = 0;
          for (let n = click - 150; n < click + 150; n++) err += (left[n - seek + lag] - source(n)) ** 2;
          if (err < best.err) best = { lag, err };
        }
        expect(best.lag).toBe(0);
      }
    }
  });
});
