/**
 * MP3 frame index: finds every audio frame's byte range by scanning frame headers (no decoding)
 * and reads the Xing/Info LAME tag for the encoder delay and end padding, so playback can start
 * at the true first sample and seek to any sample exactly.
 */

/** Decoder delay of the MP3 synthesis filterbank, added to the encoder delay (as ffmpeg/LAME do). */
export const MP3_DECODER_DELAY = 529;

export interface Mp3Index {
  sampleRate: number;
  channels: number;
  samplesPerFrame: number;
  /** Byte offset and size of each audio frame (the Xing/Info frame is not included). */
  frameOffsets: Uint32Array;
  frameSizes: Uint32Array;
  /** Decoded samples to drop at the start: encoder delay + decoder delay. */
  startSkip: number;
  /** Playable samples per channel after trimming delay and padding. */
  totalSamples: number;
  /** Set when there was no usable LAME tag and the delay is a guess. */
  warning?: string;
}

const BITRATES_KBPS: Record<string, number[]> = {
  // [mpeg1 ? 'v1' : 'v2'] + layer
  v1l1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  v1l2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  v1l3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  v2l1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  v2l2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  v2l3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const SAMPLE_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] } as Record<number, number[]>;

export interface FrameHeader {
  /** 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5 */
  version: number;
  /** 1 = Layer III, 2 = Layer II, 3 = Layer I (the header's encoding) */
  layerBits: number;
  sampleRate: number;
  channels: number;
  samplesPerFrame: number;
  frameSize: number;
  hasCrc: boolean;
}

/** Parses the 4-byte frame header at `offset`, or returns null if it isn't a valid one. */
export function parseFrameHeader(buf: Uint8Array, offset: number): FrameHeader | null {
  if (offset + 4 > buf.length) return null;
  const b1 = buf[offset + 1];
  const b2 = buf[offset + 2];
  const b3 = buf[offset + 3];
  if (buf[offset] !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
  const version = (b1 >> 3) & 3;
  const layerBits = (b1 >> 1) & 3;
  const bitrateIndex = b2 >> 4;
  const rateIndex = (b2 >> 2) & 3;
  if (version === 1 || layerBits === 0 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
  const layer = 4 - layerBits;
  const kbps = BITRATES_KBPS[`${version === 3 ? 'v1' : 'v2'}l${layer}`][bitrateIndex];
  const sampleRate = SAMPLE_RATES[version][rateIndex];
  const padding = (b2 >> 1) & 1;
  let frameSize: number;
  let samplesPerFrame: number;
  if (layer === 1) {
    frameSize = (Math.floor((12 * kbps * 1000) / sampleRate) + padding) * 4;
    samplesPerFrame = 384;
  } else if (layer === 3 && version !== 3) {
    frameSize = Math.floor((72 * kbps * 1000) / sampleRate) + padding;
    samplesPerFrame = 576;
  } else {
    frameSize = Math.floor((144 * kbps * 1000) / sampleRate) + padding;
    samplesPerFrame = 1152;
  }
  return {
    version,
    layerBits,
    sampleRate,
    channels: b3 >> 6 === 3 ? 1 : 2,
    samplesPerFrame,
    frameSize,
    hasCrc: (b1 & 1) === 0,
  };
}

function sameStream(a: FrameHeader, b: FrameHeader): boolean {
  return a.version === b.version && a.layerBits === b.layerBits && a.sampleRate === b.sampleRate;
}

function ascii(buf: Uint8Array, offset: number, length: number): string {
  let s = '';
  for (let i = offset; i < offset + length && i < buf.length; i++) s += String.fromCharCode(buf[i]);
  return s;
}

function id3v2Size(buf: Uint8Array): number {
  if (ascii(buf, 0, 3) !== 'ID3' || buf.length < 10) return 0;
  const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
  const footer = buf[5] & 0x10 ? 10 : 0;
  return 10 + size + footer;
}

interface InfoTag {
  /** Encoder delay and end padding from the LAME extension, when present. */
  delay?: number;
  padding?: number;
}

/** Reads a Xing/Info (or VBRI) tag from the first frame, or null when the frame is audio. */
function readInfoTag(buf: Uint8Array, offset: number, header: FrameHeader): InfoTag | null {
  const sideInfo = header.version === 3 ? (header.channels === 1 ? 17 : 32) : header.channels === 1 ? 9 : 17;
  for (const tagOffset of [offset + 4 + sideInfo, offset + 4 + sideInfo + 2]) {
    const id = ascii(buf, tagOffset, 4);
    if (id !== 'Xing' && id !== 'Info') continue;
    const flags = (buf[tagOffset + 4] << 24) | (buf[tagOffset + 5] << 16) | (buf[tagOffset + 6] << 8) | buf[tagOffset + 7];
    let p = tagOffset + 8;
    if (flags & 1) p += 4; // frames
    if (flags & 2) p += 4; // bytes
    if (flags & 4) p += 100; // TOC
    if (flags & 8) p += 4; // quality
    const vendor = ascii(buf, p, 4);
    if (vendor === 'LAME' || vendor === 'Lavf' || vendor === 'Lavc' || vendor === 'L3.9' || vendor === 'GOGO') {
      const d = p + 21;
      if (d + 3 <= buf.length) {
        return { delay: (buf[d] << 4) | (buf[d + 1] >> 4), padding: ((buf[d + 1] & 0x0f) << 8) | buf[d + 2] };
      }
    }
    return {};
  }
  if (ascii(buf, offset + 36, 4) === 'VBRI') {
    // Fraunhofer VBRI: delay at +6 (2 bytes); no end padding.
    const p = offset + 36;
    return { delay: (buf[p + 6] << 8) | buf[p + 7] };
  }
  return null;
}

/** Scans a whole MP3 file into a frame index. Throws when no MPEG audio frames are found. */
export function indexMp3(buf: Uint8Array): Mp3Index {
  let offset = id3v2Size(buf);
  const offsets: number[] = [];
  const sizes: number[] = [];
  let first: FrameHeader | null = null;
  let tag: InfoTag | null = null;
  let firstFrameChecked = false;

  while (offset + 4 <= buf.length) {
    const header = parseFrameHeader(buf, offset);
    const valid =
      header !== null &&
      offset + header.frameSize <= buf.length &&
      (first ? sameStream(first, header) : true) &&
      // When (re)syncing, demand that the next frame lines up too, so a stray 0xFFE in junk doesn't count.
      (first !== null || offset + header.frameSize + 4 > buf.length || parseFrameHeader(buf, offset + header.frameSize) !== null);
    if (!valid || !header) {
      if (ascii(buf, offset, 3) === 'TAG' || ascii(buf, offset, 8) === 'APETAGEX') break;
      offset += 1;
      continue;
    }
    if (!first) first = header;
    if (!firstFrameChecked) {
      firstFrameChecked = true;
      tag = readInfoTag(buf, offset, header);
      if (tag) {
        offset += header.frameSize;
        continue;
      }
    }
    offsets.push(offset);
    sizes.push(header.frameSize);
    offset += header.frameSize;
  }

  if (!first || offsets.length === 0) throw new Error('No MPEG audio frames found.');

  const spf = first.samplesPerFrame;
  let warning: string | undefined;
  let delay = tag?.delay;
  const padding = tag?.padding;
  if (delay === undefined) {
    warning = 'No LAME tag: assuming the standard decoder delay only.';
    delay = 0;
  }
  const startSkip = delay + MP3_DECODER_DELAY;
  // Same arithmetic as ffmpeg: frames × spf − delay − padding (the decoder delay cancels out).
  const totalSamples = Math.max(
    0,
    padding !== undefined ? offsets.length * spf - delay - padding : offsets.length * spf - startSkip,
  );

  return {
    sampleRate: first.sampleRate,
    channels: first.channels,
    samplesPerFrame: spf,
    frameOffsets: Uint32Array.from(offsets),
    frameSizes: Uint32Array.from(sizes),
    startSkip,
    totalSamples,
    warning,
  };
}
