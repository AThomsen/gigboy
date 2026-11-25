import type { StretchNode } from 'signalsmith-stretch';

/** Semitones the player has to shift to hear `transpose` at `speedPercent` varispeed. */
export function correctionSemitones(transpose: number, speedPercent: number): number {
  return transpose - 12 * Math.log2(speedPercent / 100);
}

/**
 * Creates a Signalsmith Stretch node processing live input. The library and its WebAssembly are
 * loaded on first use only, so players that never change pitch or speed don't download them.
 */
export async function createPitchShifter(ctx: BaseAudioContext): Promise<StretchNode> {
  const [{ default: SignalsmithStretch }, { default: workletUrl }] = await Promise.all([
    import('signalsmith-stretch'),
    import('./pitchShift.worklet.ts?worker&url'),
  ]);
  SignalsmithStretch.moduleUrl = workletUrl;
  return SignalsmithStretch(ctx, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
}
