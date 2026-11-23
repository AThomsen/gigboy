// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { indexMp3 } from './mp3Index';
import { describeDecoderStartError, openStreamDecoder, type ByteSource } from './streamDecoder';

/**
 * Fixtures: 3 s stereo 44.1 kHz test signal (440 Hz left / 660 Hz right sines) with 8-sample
 * clicks at samples 30000 and 90000, encoded by ffmpeg/LAME as 128k CBR and as VBR.
 * reference.json holds ffmpeg's own decode (LAME delay/padding trimmed) at every 211th sample.
 */
const FIXTURES = join(__dirname, '__fixtures__');
const reference = JSON.parse(readFileSync(join(FIXTURES, 'reference.json'), 'utf8')) as {
  step: number;
  files: Record<string, { totalSamples: number; left: number[]; right: number[] }>;
};

const CLICKS = [30000, 90000];
const SAMPLE_RATE = 44100;
const LENGTH = 3 * SAMPLE_RATE;

function source(bytes: Uint8Array): ByteSource {
  return { size: bytes.length, read: async (start, end) => bytes.slice(start, end) };
}

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, name)));
}

/** The test signal at sample n (what the fixtures were encoded from). */
function signal(n: number, channel: number): number {
  const click = CLICKS.some((c) => n >= c && n <= c + 7) ? 0.9 : 0;
  const t = n / SAMPLE_RATE;
  return (channel === 0 ? 0.25 * Math.sin(2 * Math.PI * 440 * t) : 0.2 * Math.sin(2 * Math.PI * 660 * t)) + click;
}

/** A 16-bit stereo WAV of the test signal. */
function testWav(): Uint8Array {
  const dataSize = LENGTH * 4;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + dataSize, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, SAMPLE_RATE, true); v.setUint32(28, SAMPLE_RATE * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, dataSize, true);
  for (let n = 0; n < LENGTH; n++) {
    for (let c = 0; c < 2; c++) v.setInt16(44 + n * 4 + c * 2, Math.max(-32768, Math.min(32767, Math.round(signal(n, c) * 32767))), true);
  }
  return new Uint8Array(buf);
}

async function decodeAll(bytes: Uint8Array, chunk: number): Promise<Float32Array[]> {
  const decoder = await openStreamDecoder(source(bytes));
  const { totalSamples, channels } = decoder.info;
  const out = Array.from({ length: channels }, () => new Float32Array(totalSamples));
  for (let from = 0; from < totalSamples; from += chunk) {
    const part = await decoder.decodeRange(from, chunk);
    part.forEach((data, c) => out[c].set(data, from));
  }
  decoder.free();
  return out;
}

/** Offset (in samples) that best lines `decoded` up with the source signal around the clicks. */
function alignmentLag(decoded: Float32Array): number {
  let best = { lag: 0, err: Infinity };
  for (let lag = -20; lag <= 20; lag++) {
    let err = 0;
    for (const c of CLICKS) {
      for (let n = c - 200; n < c + 200; n++) err += (decoded[n + lag] - signal(n, 0)) ** 2;
    }
    if (err < best.err) best = { lag, err };
  }
  return best.lag;
}

describe('indexMp3', () => {
  it.each(['click-cbr', 'click-vbr'])('reads the LAME delay/padding of %s and matches ffmpeg\'s length', (name) => {
    const index = indexMp3(fixture(`${name}.mp3`));
    expect(index.sampleRate).toBe(44100);
    expect(index.channels).toBe(2);
    expect(index.startSkip).toBe(576 + 529);
    expect(index.warning).toBeUndefined();
    expect(index.totalSamples).toBe(reference.files[name].totalSamples);
  });

  it('rejects data without MPEG frames', () => {
    expect(() => indexMp3(new Uint8Array(4096))).toThrow(/No MPEG audio frames/);
  });
});

describe('MP3 stream decoding', () => {
  it.each(['click-cbr', 'click-vbr'])('decodes %s in chunks exactly like ffmpeg (delay trimmed)', async (name) => {
    const ref = reference.files[name];
    const [left, right] = await decodeAll(fixture(`${name}.mp3`), 10000);
    expect(left.length).toBe(ref.totalSamples);
    ref.left.forEach((value, i) => {
      expect(left[i * reference.step]).toBeCloseTo(value, 4);
      expect(right[i * reference.step]).toBeCloseTo(ref.right[i], 4);
    });
  });

  it.each(['click-cbr', 'click-vbr'])('lines %s up with the source signal to the exact sample', async (name) => {
    const [left] = await decodeAll(fixture(`${name}.mp3`), 4096);
    expect(alignmentLag(left)).toBe(0);
  });

  it('returns the same samples after a seek as when decoding straight through', async () => {
    const bytes = fixture('click-vbr.mp3');
    const [full] = await decodeAll(bytes, 50000);
    const decoder = await openStreamDecoder(source(bytes));
    for (const from of [77777, 1, 29990, 120000, 5000, 64321]) {
      const [part] = await decoder.decodeRange(from, 3000);
      let maxErr = 0;
      for (let i = 0; i < part.length; i++) maxErr = Math.max(maxErr, Math.abs(part[i] - full[from + i]));
      expect(maxErr).toBeLessThan(1e-5);
    }
    decoder.free();
  });

  it('clamps ranges to the end of the stream', async () => {
    const decoder = await openStreamDecoder(source(fixture('click-cbr.mp3')));
    const total = decoder.info.totalSamples;
    expect((await decoder.decodeRange(total - 100, 1000))[0].length).toBe(100);
    expect((await decoder.decodeRange(total, 1000))[0].length).toBe(0);
    decoder.free();
  });
});

describe('WAV stream decoding', () => {
  it('decodes 16-bit PCM at the exact sample positions', async () => {
    const decoder = await openStreamDecoder(source(testWav()));
    expect(decoder.info).toMatchObject({ sampleRate: 44100, channels: 2, totalSamples: LENGTH, format: 'wav' });
    const [left, right] = await decoder.decodeRange(29995, 20);
    const clipped = (n: number, c: number) => Math.max(-1, Math.min(32767 / 32768, signal(n, c)));
    for (let i = 0; i < 20; i++) {
      expect(left[i]).toBeCloseTo(clipped(29995 + i, 0), 3);
      expect(right[i]).toBeCloseTo(clipped(29995 + i, 1), 3);
    }
  });

  it('lines up with the MP3 stems of the same song', async () => {
    const [wav] = await decodeAll(testWav(), 4096);
    expect(alignmentLag(wav)).toBe(0);
  });
});

describe('describeDecoderStartError', () => {
  it('explains a CSP block of the WebAssembly decoder', () => {
    const err = describeDecoderStartError(new Error("WebAssembly.compile(): ... violates ... because 'unsafe-eval' is not an allowed source of script"));
    expect(err.message).toMatch(/wasm-unsafe-eval/);
    expect(err.message).toMatch(/reload the app/);
  });

  it('passes other failures through', () => {
    expect(describeDecoderStartError(new Error('out of memory')).message).toBe('The MP3 decoder failed to start: out of memory');
  });
});
