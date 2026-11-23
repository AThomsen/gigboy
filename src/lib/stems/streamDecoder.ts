import { MPEGDecoder } from 'mpg123-decoder';
import { indexMp3, type Mp3Index } from './mp3Index';

/**
 * Incremental decoders for stem files. Each one decodes any sample range of a file straight from
 * its compressed bytes, so only the range asked for exists as PCM. Sample positions are exact:
 * sample 0 is the first real sample of the song (encoder delay trimmed), and a range decoded after
 * a seek matches the same range decoded from the start.
 */

export interface StreamInfo {
  sampleRate: number;
  channels: number;
  /** Playable samples per channel. */
  totalSamples: number;
  format: 'mp3' | 'wav';
  warning?: string;
}

export interface StreamDecoder {
  readonly info: StreamInfo;
  /**
   * Decodes samples [from, from + count), clamped to the stream, as one Float32Array per channel.
   * Consecutive ranges continue the decoder; any other range seeks with pre-roll.
   */
  decodeRange(from: number, count: number): Promise<Float32Array[]>;
  free(): void;
}

/** Random-access bytes of a file (a Blob in the browser; anything with slice/arrayBuffer in tests). */
export interface ByteSource {
  readonly size: number;
  read(start: number, end: number): Promise<Uint8Array>;
}

export function blobSource(blob: Blob): ByteSource {
  return {
    size: blob.size,
    read: async (start, end) => new Uint8Array(await blob.slice(start, end).arrayBuffer()),
  };
}

/**
 * Turns a failure to start the WebAssembly MP3 decoder into an error that says why. The usual
 * cause is a Content-Security-Policy without 'wasm-unsafe-eval' — either the server's, or a stale
 * one cached together with this worker script.
 */
export function describeDecoderStartError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  if (/content security policy|wasm-unsafe-eval|unsafe-eval/i.test(message)) {
    return new Error(
      "The MP3 decoder is blocked by the Content-Security-Policy (script-src needs 'wasm-unsafe-eval'). " +
        'If the server already sends it, reload the app so the decoder worker is fetched again.',
    );
  }
  return new Error(`The MP3 decoder failed to start: ${message}`);
}

/** Frames decoded (and discarded) before a seek target, so the bit reservoir and filterbank are primed. */
const MP3_PREROLL_FRAMES = 10;

function emptyChannels(channels: number): Float32Array[] {
  return Array.from({ length: channels }, () => new Float32Array(0));
}

class Mp3StreamDecoder implements StreamDecoder {
  readonly info: StreamInfo;
  private decoder: MPEGDecoder | null = null;
  /** Next frame to feed the decoder. */
  private nextFrame = 0;
  /** Decoded samples not yet returned, starting at raw (untrimmed) sample `pendingStart`. */
  private pending: Float32Array[];
  private pendingStart = 0;

  constructor(private readonly source: ByteSource, private readonly index: Mp3Index) {
    this.info = {
      sampleRate: index.sampleRate,
      channels: index.channels,
      totalSamples: index.totalSamples,
      format: 'mp3',
      warning: index.warning,
    };
    this.pending = emptyChannels(index.channels);
  }

  private get frontier(): number {
    return this.nextFrame * this.index.samplesPerFrame;
  }

  private async readFrames(first: number, end: number): Promise<{ bytes: Uint8Array; base: number }> {
    const { frameOffsets, frameSizes } = this.index;
    const base = frameOffsets[first];
    const last = end - 1;
    const bytes = await this.source.read(base, frameOffsets[last] + frameSizes[last]);
    return { bytes, base };
  }

  /** Decodes frames [first, end) and returns exactly samplesPerFrame samples per frame. */
  private async decodeFrames(first: number, end: number): Promise<Float32Array[][]> {
    if (end <= first) return [];
    const { frameOffsets, frameSizes, samplesPerFrame: spf } = this.index;
    const { bytes, base } = await this.readFrames(first, end);
    const out: Float32Array[][] = [];
    for (let f = first; f < end; f++) {
      const start = frameOffsets[f] - base;
      const decoded = this.decoder!.decodeFrame(bytes.subarray(start, start + frameSizes[f]));
      // A frame that fails to decode still occupies its slot, so the timeline never shifts.
      out.push(
        Array.from({ length: this.info.channels }, (_, c) => {
          const data = decoded.channelData[c] ?? decoded.channelData[0];
          if (data && data.length === spf) return data;
          const fixed = new Float32Array(spf);
          if (data) fixed.set(data.subarray(0, spf));
          return fixed;
        }),
      );
    }
    return out;
  }

  private async restartAt(rawSample: number): Promise<void> {
    this.decoder?.free();
    try {
      this.decoder = new MPEGDecoder({ enableGapless: false });
      await this.decoder.ready;
    } catch (err) {
      this.decoder = null;
      throw describeDecoderStartError(err);
    }
    const target = Math.min(Math.floor(rawSample / this.index.samplesPerFrame), this.index.frameOffsets.length);
    await this.decodeFrames(Math.max(0, target - MP3_PREROLL_FRAMES), target); // pre-roll, discarded
    this.nextFrame = target;
    this.pending = emptyChannels(this.info.channels);
    this.pendingStart = this.frontier;
  }

  async decodeRange(from: number, count: number): Promise<Float32Array[]> {
    const start = Math.max(0, from);
    const end = Math.min(start + Math.max(0, count), this.info.totalSamples);
    if (end <= start) return emptyChannels(this.info.channels);
    const spf = this.index.samplesPerFrame;
    const rawStart = start + this.index.startSkip;
    const rawEnd = end + this.index.startSkip;

    const continues = this.decoder !== null && rawStart >= this.pendingStart && rawStart <= this.frontier;
    if (!continues) await this.restartAt(rawStart);

    const framesNeeded = Math.min(Math.ceil(rawEnd / spf), this.index.frameOffsets.length);
    const frames = await this.decodeFrames(this.nextFrame, framesNeeded);
    this.nextFrame = Math.max(this.nextFrame, framesNeeded);

    // Stitch pending + new frames into [pendingStart, frontier), then cut out [rawStart, rawEnd).
    const span = this.frontier - this.pendingStart;
    const result: Float32Array[] = [];
    const leftover: Float32Array[] = [];
    for (let c = 0; c < this.info.channels; c++) {
      const all = new Float32Array(Math.max(span, rawEnd - this.pendingStart));
      all.set(this.pending[c]);
      let p = this.pending[c].length;
      for (const frame of frames) {
        all.set(frame[c], p);
        p += spf;
      }
      result.push(all.slice(rawStart - this.pendingStart, rawEnd - this.pendingStart));
      leftover.push(all.slice(rawEnd - this.pendingStart, span));
    }
    this.pending = leftover;
    this.pendingStart = rawEnd;
    return result;
  }

  free(): void {
    this.decoder?.free();
    this.decoder = null;
  }
}

interface WavFormat {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  float: boolean;
  dataOffset: number;
  dataSize: number;
}

async function parseWav(source: ByteSource): Promise<WavFormat> {
  const head = await source.read(0, 12);
  const text = (b: Uint8Array, o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  if (text(head, 0) !== 'RIFF' || text(head, 8) !== 'WAVE') throw new Error('Not a WAV file.');
  let offset = 12;
  let fmt: Omit<WavFormat, 'dataOffset' | 'dataSize'> | null = null;
  while (offset + 8 <= source.size) {
    const chunk = await source.read(offset, offset + 8);
    const view = new DataView(chunk.buffer, chunk.byteOffset, 8);
    const id = text(chunk, 0);
    const size = view.getUint32(4, true);
    if (id === 'fmt ') {
      const body = await source.read(offset + 8, offset + 8 + Math.min(size, 40));
      const v = new DataView(body.buffer, body.byteOffset, body.byteLength);
      let code = v.getUint16(0, true);
      if (code === 0xfffe && body.byteLength >= 26) code = v.getUint16(24, true); // WAVE_FORMAT_EXTENSIBLE sub-format
      if (code !== 1 && code !== 3) throw new Error('Only PCM and float WAV files are supported.');
      fmt = { channels: v.getUint16(2, true), sampleRate: v.getUint32(4, true), bitsPerSample: v.getUint16(14, true), float: code === 3 };
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV data before format.');
      // Some writers leave the size at 0 / 0xFFFFFFFF when streaming; fall back to the file length.
      const dataSize = size === 0 || offset + 8 + size > source.size ? source.size - offset - 8 : size;
      return { ...fmt, dataOffset: offset + 8, dataSize };
    }
    offset += 8 + size + (size & 1);
  }
  throw new Error('WAV file has no audio data.');
}

class WavStreamDecoder implements StreamDecoder {
  readonly info: StreamInfo;
  private readonly blockAlign: number;

  constructor(private readonly source: ByteSource, private readonly fmt: WavFormat) {
    this.blockAlign = (fmt.bitsPerSample / 8) * fmt.channels;
    this.info = {
      sampleRate: fmt.sampleRate,
      channels: fmt.channels,
      totalSamples: Math.floor(fmt.dataSize / this.blockAlign),
      format: 'wav',
    };
  }

  async decodeRange(from: number, count: number): Promise<Float32Array[]> {
    const start = Math.max(0, from);
    const end = Math.min(start + Math.max(0, count), this.info.totalSamples);
    const n = Math.max(0, end - start);
    const { channels, bitsPerSample, float } = this.fmt;
    const out = Array.from({ length: channels }, () => new Float32Array(n));
    if (n === 0) return out;
    const bytes = await this.source.read(this.fmt.dataOffset + start * this.blockAlign, this.fmt.dataOffset + end * this.blockAlign);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = bitsPerSample / 8;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < channels; c++) {
        const o = i * this.blockAlign + c * width;
        let value: number;
        if (float) value = bitsPerSample === 64 ? view.getFloat64(o, true) : view.getFloat32(o, true);
        else if (bitsPerSample === 16) value = view.getInt16(o, true) / 32768;
        else if (bitsPerSample === 24) value = (((bytes[o + 2] << 24) | (bytes[o + 1] << 16) | (bytes[o] << 8)) >> 8) / 8388608;
        else if (bitsPerSample === 32) value = view.getInt32(o, true) / 2147483648;
        else value = (bytes[o] - 128) / 128; // 8-bit unsigned
        out[c][i] = value;
      }
    }
    return out;
  }

  free(): void {}
}

/** Opens a stem file (MP3 or WAV, detected from its bytes) for incremental decoding. */
export async function openStreamDecoder(source: ByteSource): Promise<StreamDecoder> {
  const head = await source.read(0, Math.min(12, source.size));
  if (String.fromCharCode(...head.subarray(0, 4)) === 'RIFF') {
    return new WavStreamDecoder(source, await parseWav(source));
  }
  // The frame scan needs the whole file once; only the index is kept afterwards.
  const index = indexMp3(await source.read(0, source.size));
  return new Mp3StreamDecoder(source, index);
}
