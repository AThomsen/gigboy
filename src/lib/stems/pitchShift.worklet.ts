/**
 * AudioWorklet module for the stem player's pitch shifter. Importing Signalsmith Stretch inside
 * the AudioWorkletGlobalScope registers its processor ("signalsmith-stretch"). The library would
 * otherwise load itself from a blob: URL, which the app's CSP (script-src 'self') blocks, so it's
 * bundled as a same-origin worklet file instead (see pitchShift.ts).
 */
import 'signalsmith-stretch';
