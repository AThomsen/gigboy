import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MixerCommand } from './stems/stemMixer.worklet';

const fake = vi.hoisted(() => ({
  decodes: [] as Array<{ stemId: string; from: number; count: number; resolve: (c: Float32Array[]) => void; reject: (e: Error) => void }>,
  infos: {} as Record<string, { sampleRate: number; channels: number; totalSamples: number; format: 'mp3' }>,
  sent: [] as unknown[],
  ctx: null as null | { currentTime: number },
  port: null as null | { onmessage: ((e: { data: unknown }) => void) | null },
  connectedTo: null as unknown,
}));

vi.mock('./stems/stemDecoderProtocol', () => ({
  StemDecoderClient: class {
    async open(stems: Array<{ stemId: string }>) {
      return stems.map((s) => (fake.infos[s.stemId] ? { stemId: s.stemId, info: fake.infos[s.stemId] } : { stemId: s.stemId, error: 'bad' }));
    }
    decode(stemId: string, from: number, count: number) {
      return new Promise<Float32Array[]>((resolve, reject) => fake.decodes.push({ stemId, from, count, resolve, reject }));
    }
    dispose() {}
  },
}));
vi.mock('./stems/stemMixer.worklet.ts?worker&url', () => ({ default: 'stem-mixer.js' }));
const shifter = vi.hoisted(() => ({
  created: 0,
  scheduled: [] as Array<{ active?: boolean; semitones?: number }>,
  connectedTo: [] as unknown[],
  stopped: 0,
}));
vi.mock('./stems/pitchShift', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./stems/pitchShift')>()),
  createPitchShifter: async () => {
    shifter.created += 1;
    return {
      schedule: async (change: { active?: boolean; semitones?: number }) => { shifter.scheduled.push(change); },
      stop: async () => { shifter.stopped += 1; },
      latency: async () => 0.1,
      connect: (target: unknown) => { shifter.connectedTo.push(target); },
      disconnect: () => {},
    };
  },
}));

import { effectiveGains, normalizeLoop, pickSampleRate, rewind, StemPlayer } from './stemPlayer';
import { correctionSemitones } from './stems/pitchShift';

const lane = (id: string, patch: Partial<{ volume: number; muted: boolean; solo: boolean }> = {}) => ({
  id, volume: 1, muted: false, solo: false, ...patch,
});

describe('effectiveGains', () => {
  it('plays every unmuted lane at its volume', () => {
    expect(effectiveGains([lane('a', { volume: 0.5 }), lane('b', { muted: true })])).toEqual({ a: 0.5, b: 0 });
  });

  it('plays only soloed lanes when any lane is soloed', () => {
    expect(effectiveGains([lane('a', { solo: true }), lane('b'), lane('c', { solo: true, volume: 0.3 })]))
      .toEqual({ a: 1, b: 0, c: 0.3 });
  });

  it('lets solo win over the lane\'s own mute', () => {
    expect(effectiveGains([lane('orig', { muted: true, solo: true }), lane('b')])).toEqual({ orig: 1, b: 0 });
  });
});

describe('normalizeLoop', () => {
  it('orders and clamps the markers', () => {
    expect(normalizeLoop(30, 10, 100)).toEqual({ start: 10, end: 30 });
    expect(normalizeLoop(-5, 120, 100)).toEqual({ start: 0, end: 100 });
  });

  it('rejects a loop that is too short', () => {
    expect(normalizeLoop(10, 10.01, 100)).toBeNull();
  });
});

describe('pickSampleRate', () => {
  it('picks the most common rate', () => {
    expect(pickSampleRate([44100, 48000, 44100])).toBe(44100);
    expect(pickSampleRate([])).toBeNull();
  });
});

describe('rewind', () => {
  it('steps back, stopping at the start of the song', () => {
    expect(rewind(1000, 300, null)).toBe(700);
    expect(rewind(100, 300, null)).toBe(0);
  });

  it('wraps back across the loop start to the loop end', () => {
    expect(rewind(1100, 300, { start: 1000, end: 2000 })).toBe(1800);
  });
});

describe('correctionSemitones', () => {
  it('cancels the pitch change of varispeed and adds the transpose', () => {
    expect(correctionSemitones(0, 100)).toBe(0);
    expect(correctionSemitones(0, 50)).toBeCloseTo(12);
    expect(correctionSemitones(2, 200)).toBeCloseTo(-10);
  });
});

describe('StemPlayer coordinator', () => {
  beforeEach(() => {
    fake.decodes.length = 0;
    fake.sent.length = 0;
    const ctx = {
      sampleRate: 44100,
      currentTime: 0,
      state: 'suspended',
      destination: {},
      audioWorklet: { addModule: vi.fn(async () => {}) },
      resume: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      onstatechange: null,
    };
    fake.ctx = ctx;
    vi.stubGlobal('AudioContext', function FakeAudioContext() { return ctx; });
    vi.stubGlobal('AudioWorkletNode', function FakeNode() {
      const port = { postMessage: (msg: unknown) => fake.sent.push(msg), onmessage: null, close() {} };
      fake.port = port;
      return {
        port,
        connect(target: unknown) { fake.connectedTo = target; },
        disconnect() { fake.connectedTo = null; },
      };
    });
    shifter.created = 0;
    shifter.scheduled.length = 0;
    shifter.connectedTo.length = 0;
    shifter.stopped = 0;
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });
  afterEach(() => vi.unstubAllGlobals());

  const sent = <T extends MixerCommand['type']>(type: T) =>
    fake.sent.filter((m): m is Extract<MixerCommand, { type: T }> => (m as MixerCommand).type === type);
  const last = <T,>(list: T[]) => list[list.length - 1];
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const chunk = 44100 * 4;

  it('opens the stems, configures the mixer and decodes the first chunks of every stem', async () => {
    fake.infos = {
      a: { sampleRate: 44100, channels: 2, totalSamples: chunk * 10, format: 'mp3' },
      b: { sampleRate: 44100, channels: 2, totalSamples: chunk * 10, format: 'mp3' },
      odd: { sampleRate: 48000, channels: 2, totalSamples: 48000 * 40, format: 'mp3' },
    };
    const player = new StemPlayer();
    const { failed } = await player.load([{ id: 'a', url: '/a' }, { id: 'b', url: '/b' }, { id: 'odd', url: '/odd' }, { id: 'gone', url: '/gone' }]);

    expect(failed.sort()).toEqual(['gone', 'odd']);
    expect(player.duration).toBe(40);
    expect(sent('config')[0]).toMatchObject({ chunkSize: chunk, stemRate: 44100, totalSamples: chunk * 10 });
    // Two decodes in flight per stem, starting at sample 0.
    expect(fake.decodes.map((d) => [d.stemId, d.from])).toEqual([['a', 0], ['a', chunk], ['b', 0], ['b', chunk]]);
    player.dispose();
  });

  it('forwards decoded chunks to the mixer and drops them once they are behind the playhead', async () => {
    fake.infos = { a: { sampleRate: 44100, channels: 2, totalSamples: chunk * 10, format: 'mp3' } };
    const player = new StemPlayer();
    await player.load([{ id: 'a', url: '/a' }]);
    fake.decodes.shift()!.resolve([new Float32Array(chunk), new Float32Array(chunk)]);
    await flush();
    expect(sent('chunk').map((c) => c.index)).toEqual([0]);

    player.seek(9 * 4); // seconds → chunk 9
    expect(sent('seek')[0].position).toBe(9 * chunk);
    expect(sent('drop').map((d) => d.index)).toEqual([0]);
    // Chunk 1 was still decoding; when it arrives it isn't needed any more and is discarded.
    fake.decodes.shift()!.resolve([new Float32Array(chunk), new Float32Array(chunk)]);
    await flush();
    expect(sent('chunk').map((c) => c.index)).toEqual([0]);
    expect(fake.decodes.some((d) => d.from === 9 * chunk)).toBe(true);
    player.dispose();
  });

  it('keeps the loop start decoded while an A–B loop is on', async () => {
    fake.infos = { a: { sampleRate: 44100, channels: 2, totalSamples: chunk * 10, format: 'mp3' } };
    const player = new StemPlayer();
    await player.load([{ id: 'a', url: '/a' }]);
    for (const d of fake.decodes.splice(0)) d.resolve([new Float32Array(chunk), new Float32Array(chunk)]);
    await flush();
    for (const d of fake.decodes.splice(0)) d.resolve([new Float32Array(chunk), new Float32Array(chunk)]);
    await flush();
    player.seek(30); // chunks 0–2 are dropped
    expect(sent('drop').map((d) => d.index)).toContain(0);
    expect(fake.decodes.map((d) => d.from / chunk)).toContain(7); // chunk holding 30 s
    fake.decodes.length = 0;
    player.setLoop({ start: 2, end: 31 });
    expect(sent('loop')[0].loop).toEqual({ start: 2 * 44100, end: 31 * 44100 });
    // The loop jumps back to 2 s, so the chunk holding the loop start is decoded again.
    expect(fake.decodes.map((d) => d.from / chunk)).toEqual([0]);
    player.dispose();
  });

  it('puts the pitch shifter in the path on the first speed or pitch change and keeps it there', async () => {
    fake.infos = { a: { sampleRate: 44100, channels: 2, totalSamples: chunk * 10, format: 'mp3' } };
    const player = new StemPlayer();
    await player.load([{ id: 'a', url: '/a' }]);
    const destination = (fake.ctx as unknown as { destination: unknown }).destination;
    expect(sent('speed')).toEqual([{ type: 'speed', percent: 100 }]);
    expect(shifter.created).toBe(0);

    player.setTranspose(3);
    await flush();
    expect(shifter.created).toBe(1);
    expect(last(shifter.scheduled)).toEqual({ active: true, semitones: 3 });
    expect(fake.connectedTo).not.toBe(destination);
    expect(shifter.connectedTo).toEqual([destination]);

    player.setSpeed(0.5);
    await flush();
    expect(last(sent('speed'))).toEqual({ type: 'speed', percent: 50 });
    expect(last(shifter.scheduled)?.semitones).toBeCloseTo(15);

    player.setSpeed(1);
    player.setTranspose(0);
    await flush();
    // Back at normal speed and pitch it stays in (no skip or gap), shifting by nothing.
    expect(last(shifter.scheduled)?.semitones).toBeCloseTo(0);
    expect(fake.connectedTo).not.toBe(destination);
    expect(shifter.connectedTo).toEqual([destination]);
    expect(shifter.stopped).toBe(0);
    expect(shifter.created).toBe(1);
    player.dispose();
  });

  it('decodes further ahead when playing faster', async () => {
    fake.infos = { a: { sampleRate: 44100, channels: 2, totalSamples: chunk * 20, format: 'mp3' } };
    const player = new StemPlayer();
    await player.load([{ id: 'a', url: '/a' }]);
    player.setSpeed(1.5);
    for (let round = 0; round < 6; round++) {
      for (const d of fake.decodes.splice(0)) d.resolve([new Float32Array(chunk), new Float32Array(chunk)]);
      await flush();
    }
    // 12 s of real time at 1.5× is 18 s of song (plus the keep-behind margin): chunks 0–4.
    expect(sent('chunk').map((c) => c.index).sort()).toEqual([0, 1, 2, 3, 4]);
    player.dispose();
  });

  it('drops a stem that keeps failing to decode, so the others keep playing', async () => {
    vi.useFakeTimers();
    fake.infos = {
      a: { sampleRate: 44100, channels: 2, totalSamples: chunk * 10, format: 'mp3' },
      bad: { sampleRate: 44100, channels: 2, totalSamples: chunk * 10, format: 'mp3' },
    };
    const failedStems: string[] = [];
    const player = new StemPlayer({ onStemFailed: (id) => failedStems.push(id) });
    await player.load([{ id: 'a', url: '/a' }, { id: 'bad', url: '/bad' }]);
    for (let attempt = 0; attempt < 5 && failedStems.length === 0; attempt++) {
      for (const d of fake.decodes.splice(0)) {
        if (d.stemId === 'bad') d.reject(new Error('CompileError'));
      }
      await vi.advanceTimersByTimeAsync(1100); // retry timer
    }
    expect(failedStems).toEqual(['bad']);
    expect(sent('removeStem')).toEqual([{ type: 'removeStem', stemId: 'bad' }]);
    vi.useRealTimers();
    player.dispose();
  });

  it('never drops the chunk the mixer is still playing, even when the estimated playhead is past it', async () => {
    fake.infos = { a: { sampleRate: 44100, channels: 2, totalSamples: chunk * 10, format: 'mp3' } };
    const player = new StemPlayer();
    await player.load([{ id: 'a', url: '/a' }]);
    for (let round = 0; round < 3; round++) {
      for (const d of fake.decodes.splice(0)) d.resolve([new Float32Array(chunk), new Float32Array(chunk)]);
      await flush();
    }
    // The mixer reports it is 10 samples before the end of chunk 0. By the time the main thread
    // handles the report, its clock says 0.1 s later, so the interpolated playhead is in chunk 1.
    fake.ctx!.currentTime = 0.1;
    fake.port!.onmessage!({ data: { type: 'state', position: chunk - 10, time: 0, playing: true, underrun: false, ended: false } });
    expect(sent('drop').map((d) => d.index)).not.toContain(0);
    player.dispose();
  });
});
