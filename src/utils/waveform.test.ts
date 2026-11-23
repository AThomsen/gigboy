import { describe, expect, it } from 'vitest';
import { computeWaveformPeaks, createPeakAccumulator } from './waveform';

describe('computeWaveformPeaks', () => {
  const quiet = new Float32Array([0.1, -0.2, 0.1, 0.05]);

  it('normalises each file by default, so a quiet file fills the height', () => {
    const bars = computeWaveformPeaks(quiet, 2);
    expect(Math.max(...bars)).toBeCloseTo(0.96);
  });

  it('keeps absolute amplitudes with normalize: false', () => {
    const bars = computeWaveformPeaks(quiet, 2, { normalize: false });
    expect(bars[0]).toBeCloseTo(0.2);
    expect(bars[1]).toBeCloseTo(0.1);
  });

  it('returns flat bars for empty audio', () => {
    expect(computeWaveformPeaks(new Float32Array(0), 3, { normalize: false })).toEqual([0.02, 0.02, 0.02]);
  });
});

describe('createPeakAccumulator', () => {
  it('matches computeWaveformPeaks when fed in pieces', () => {
    const data = Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i / 7) * (i / 1000));
    const acc = createPeakAccumulator(1000, 10, { normalize: false });
    acc.add([data.subarray(0, 333)], 0);
    acc.add([data.subarray(333)], 333);
    expect(acc.result()).toEqual(computeWaveformPeaks(data, 10, { normalize: false }));
  });

  it('takes the louder channel', () => {
    const acc = createPeakAccumulator(4, 2, { normalize: false });
    acc.add([Float32Array.from([0.1, 0.1, 0.1, 0.1]), Float32Array.from([0.5, 0, 0, 0.3])], 0);
    const [first, second] = acc.result();
    expect(first).toBeCloseTo(0.5);
    expect(second).toBeCloseTo(0.3);
  });
});
