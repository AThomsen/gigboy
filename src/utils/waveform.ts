/** Default number of bars a waveform is reduced to. */
export const WAVEFORM_SAMPLES = 100;

export interface WaveformOptions {
  /**
   * Scale each file so its loudest bar is full height (default). Pass `false` to keep absolute
   * amplitudes, so files shown side by side stay comparable — a quiet piano stem looks quiet
   * next to the drums.
   */
  normalize?: boolean;
}

/** Absolute peak per block of `samples` equal blocks, taken over every given channel. */
function blockPeaks(channels: Float32Array[], samples: number): number[] {
  const length = channels[0]?.length ?? 0;
  const blockSize = Math.max(1, Math.floor(length / samples));
  return Array.from({ length: samples }, (_, index) => {
    const start = index * blockSize;
    const end = Math.min(length, start + blockSize);
    let peak = 0;
    for (const data of channels) {
      for (let cursor = start; cursor < end; cursor += 1) {
        const amplitude = Math.abs(data[cursor]);
        if (amplitude > peak) peak = amplitude;
      }
    }
    return peak;
  });
}

function shapePeaks(peaks: number[], options: WaveformOptions): number[] {
  if (options.normalize === false) {
    return peaks.map((peak) => Math.max(0.02, Math.min(1, peak)));
  }
  const maxPeak = Math.max(...peaks, 0.01);
  return peaks.map((peak) => {
    const normalized = peak / maxPeak;
    // Power > 1 keeps loud peaks tall and shrinks quiet parts toward the floor.
    const exaggerated = Math.pow(normalized, 1.8);
    return Math.max(0.04, exaggerated * 0.96);
  });
}

/** Reduces one channel of samples to `samples` bar heights in 0..1. */
export function computeWaveformPeaks(
  channelData: Float32Array,
  samples = WAVEFORM_SAMPLES,
  options: WaveformOptions = {},
): number[] {
  if (channelData.length === 0) {
    return Array.from({ length: samples }, () => (options.normalize === false ? 0.02 : 0.12));
  }
  return shapePeaks(blockPeaks([channelData], samples), options);
}

/** Decodes a blob with a throwaway AudioContext and returns its waveform bars. */
export async function computeWaveformPeaksFromBlob(
  blob: Blob,
  samples = WAVEFORM_SAMPLES,
  options: WaveformOptions = {},
): Promise<number[]> {
  const arrayBuffer = await blob.arrayBuffer();
  const audioContext = new AudioContext();
  try {
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    return computeWaveformPeaks(audioBuffer.getChannelData(0), samples, options);
  } finally {
    void audioContext.close();
  }
}

/**
 * Builds waveform bars from audio decoded piece by piece, so a whole file never has to be in
 * memory. Feed consecutive blocks with `add`; `result` shapes the bars like the functions above.
 */
export function createPeakAccumulator(totalSamples: number, bars = WAVEFORM_SAMPLES, options: WaveformOptions = {}) {
  const peaks = new Array<number>(bars).fill(0);
  const total = Math.max(1, totalSamples);
  return {
    add(channels: Float32Array[], startSample: number): void {
      const length = channels[0]?.length ?? 0;
      for (let i = 0; i < length; i++) {
        const bar = Math.min(bars - 1, Math.floor(((startSample + i) * bars) / total));
        let peak = peaks[bar];
        for (const data of channels) {
          const amplitude = Math.abs(data[i]);
          if (amplitude > peak) peak = amplitude;
        }
        peaks[bar] = peak;
      }
    },
    result(): number[] {
      return totalSamples > 0 ? shapePeaks(peaks, options) : computeWaveformPeaks(new Float32Array(0), bars, options);
    },
  };
}
