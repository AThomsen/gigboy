declare module 'signalsmith-stretch' {
  export interface StretchSchedule {
    output?: number;
    active?: boolean;
    semitones?: number;
    tonalityHz?: number;
    formantSemitones?: number;
    formantCompensation?: boolean;
  }

  export interface StretchNode extends AudioWorkletNode {
    schedule(change: StretchSchedule): Promise<void>;
    start(when?: number): Promise<void>;
    stop(when?: number): Promise<void>;
    /** Delay of live input through the node, in seconds. */
    latency(): Promise<number>;
  }

  interface CreateStretch {
    (context: BaseAudioContext, options?: AudioWorkletNodeOptions): Promise<StretchNode>;
    /** Worklet module to load instead of the library's own blob: URL. */
    moduleUrl?: string;
  }

  const SignalsmithStretch: CreateStretch;
  export default SignalsmithStretch;
}
