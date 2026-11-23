import { setAudioSessionType } from './webAudio';
import { chunksAhead, type LoopRegion as SampleLoop } from './stems/mixCore';
import { StemDecoderClient } from './stems/stemDecoderProtocol';
import { requestPersistentStorage } from './stems/stemCache';
import type { MixerCommand, MixerReport } from './stems/stemMixer.worklet';
import type { StreamInfo } from './stems/streamDecoder';

/**
 * Multitrack player for a song's stems, built to play long songs with many stems on phones:
 *
 * - Stem files stay compressed in the Cache API (stems/stemCache.ts).
 * - A worker decodes only the next few seconds of each stem (stems/streamDecoder.ts), with the
 *   encoder delay trimmed so sample 0 is the true start of every stem.
 * - One AudioWorklet mixes all stems at the same integer sample position (stems/mixCore.ts), so
 *   they're sample-locked; a stem that isn't decoded yet holds the playhead for all of them.
 *
 * Only ~16 s of PCM per stem is in memory at once, instead of the whole song.
 */

export interface LaneMix {
  id: string;
  volume: number;
  muted: boolean;
  solo: boolean;
}

/** An A–B loop in seconds. */
export interface LoopRegion {
  start: number;
  end: number;
}

/** Shortest loop the player accepts, in seconds. */
export const MIN_LOOP_SECONDS = 0.05;

/** Seconds of audio per decoded chunk. */
const CHUNK_SECONDS = 4;
/** Seconds of audio kept decoded ahead of the playhead (in play order, following the loop). */
const LOOKAHEAD_SECONDS = 12;
/** Chunk decodes in flight per stem. */
const MAX_IN_FLIGHT = 2;
/** An underrun shorter than this (a seek, a loop jump) isn't shown as buffering. */
const BUFFERING_GRACE_MS = 250;
/** Seconds of decoded audio kept behind the mixer's reported position, as a safety margin. */
const KEEP_BEHIND_SECONDS = 0.5;
/** Decode failures in a row after which a stem is dropped, so the others keep playing. */
const MAX_DECODE_FAILURES = 3;

/** Gain per lane: when any lane is soloed only soloed lanes play (solo beats a lane's own mute); otherwise muted lanes are silent. */
export function effectiveGains(lanes: LaneMix[]): Record<string, number> {
  const anySolo = lanes.some((lane) => lane.solo);
  const gains: Record<string, number> = {};
  for (const lane of lanes) {
    const audible = anySolo ? lane.solo : !lane.muted;
    gains[lane.id] = audible ? Math.max(0, lane.volume) : 0;
  }
  return gains;
}

/** Orders and clamps two marker times into a loop region, or null when it would be too short. */
export function normalizeLoop(a: number, b: number, duration: number): LoopRegion | null {
  const clamp = (t: number) => Math.min(Math.max(0, t), duration);
  const start = clamp(Math.min(a, b));
  const end = clamp(Math.max(a, b));
  return end - start >= MIN_LOOP_SECONDS ? { start, end } : null;
}

/** The most common sample rate among the stems (stems at another rate can't be sample-locked). */
export function pickSampleRate(rates: number[]): number | null {
  const counts = new Map<number, number>();
  for (const rate of rates) counts.set(rate, (counts.get(rate) ?? 0) + 1);
  let best: number | null = null;
  for (const [rate, count] of counts) if (best === null || count > (counts.get(best) ?? 0)) best = rate;
  return best;
}

export interface StemSource {
  id: string;
  url: string;
}

export interface StemPlayerCallbacks {
  /** Called every animation frame while playing, and after seeks/pauses. */
  onPosition?: (seconds: number) => void;
  /** Called when playback starts or stops (including reaching the end). */
  onPlayingChange?: (playing: boolean) => void;
  /** Called when playback is waiting for audio to be decoded (or stops waiting). */
  onBuffering?: (buffering: boolean) => void;
  /** Called when a stem keeps failing to decode and has been taken out of the mix. */
  onStemFailed?: (stemId: string) => void;
}

interface Lane {
  info: StreamInfo;
  /** Chunks the worklet holds. */
  resident: Set<number>;
  inFlight: Set<number>;
  failures: number;
}

function createAudioContext(sampleRate: number): AudioContext {
  try {
    // At the stems' own rate the mixer needs no resampling; the browser converts the final mix.
    return new AudioContext({ sampleRate, latencyHint: 'playback' });
  } catch {
    return new AudioContext({ latencyHint: 'playback' });
  }
}

export class StemPlayer {
  private client: StemDecoderClient | null = null;
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private lanes = new Map<string, Lane>();
  private stemRate = 44100;
  private chunkSize = 44100 * CHUNK_SECONDS;
  private totalSamples = 0;
  private loop: SampleLoop | null = null;
  private mix: LaneMix[] = [];
  private playing = false;
  private lastReport: MixerReport | null = null;
  private frame: number | null = null;
  private bufferingTimer: ReturnType<typeof setTimeout> | null = null;
  private buffering = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  duration = 0;

  constructor(private readonly callbacks: StemPlayerCallbacks = {}) {}

  /**
   * Opens every stem (downloading and caching it on first use) and prepares the mixer. Returns
   * the ids of stems that couldn't be opened or don't share the other stems' sample rate.
   */
  async load(stems: StemSource[], onProgress?: (loaded: number, total: number) => void): Promise<{ failed: string[] }> {
    try {
      return await this.open(stems, onProgress);
    } catch (err) {
      // dispose() during loading (the card closed, the song changed) isn't an error.
      if (this.disposed) return { failed: [] };
      throw err;
    }
  }

  private async open(stems: StemSource[], onProgress?: (loaded: number, total: number) => void): Promise<{ failed: string[] }> {
    requestPersistentStorage();
    const client = new StemDecoderClient();
    this.client = client;
    onProgress?.(0, stems.length);
    const results = await client.open(stems.map((s) => ({ stemId: s.id, url: s.url })), onProgress);
    if (this.disposed) return { failed: [] };

    const failed = results.filter((r) => !r.info).map((r) => r.stemId);
    for (const r of results) if (r.error) console.error(`[StemPlayer] Failed to open stem ${r.stemId}: ${r.error}`);
    const opened = results.filter((r): r is { stemId: string; info: StreamInfo } => Boolean(r.info));
    const rate = pickSampleRate(opened.map((r) => r.info.sampleRate));
    if (rate === null) return { failed };
    for (const r of opened) {
      if (r.info.sampleRate !== rate) {
        console.error(`[StemPlayer] Stem ${r.stemId} is ${r.info.sampleRate} Hz; the others are ${rate} Hz.`);
        failed.push(r.stemId);
      } else {
        this.lanes.set(r.stemId, { info: r.info, resident: new Set(), inFlight: new Set(), failures: 0 });
      }
    }

    this.stemRate = rate;
    this.chunkSize = rate * CHUNK_SECONDS;
    this.totalSamples = Math.max(0, ...[...this.lanes.values()].map((l) => l.info.totalSamples));
    this.duration = this.totalSamples / rate;

    const ctx = createAudioContext(rate);
    this.ctx = ctx;
    const { default: workletUrl } = await import('./stems/stemMixer.worklet.ts?worker&url');
    await ctx.audioWorklet.addModule(workletUrl);
    if (this.disposed) return { failed };
    const node = new AudioWorkletNode(ctx, 'stem-mixer', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    node.connect(ctx.destination);
    node.port.onmessage = (event: MessageEvent<MixerReport>) => this.onReport(event.data);
    this.node = node;

    let lastState = ctx.state;
    ctx.onstatechange = () => {
      // iOS interrupts audio for calls, Siri, other apps: show it as paused.
      if (lastState === 'running' && ctx.state !== 'running' && this.playing) this.pause();
      lastState = ctx.state;
    };

    const gains = effectiveGains(this.mix);
    this.send({
      type: 'config',
      chunkSize: this.chunkSize,
      stemRate: rate,
      totalSamples: this.totalSamples,
      stems: [...this.lanes].map(([id, lane]) => ({ id, channels: lane.info.channels, totalSamples: lane.info.totalSamples, gain: gains[id] ?? 1 })),
    });
    this.refill();
    return { failed };
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  /** Playhead in stem samples, interpolated between the mixer's reports. */
  private get positionSamples(): number {
    const report = this.lastReport;
    if (!report) return 0;
    if (!report.playing || report.underrun || !this.ctx) return report.position;
    let p = report.position + Math.max(0, this.ctx.currentTime - report.time) * this.stemRate;
    const loop = this.loop;
    if (loop && report.position < loop.end && p >= loop.end) p = loop.start + ((p - loop.start) % (loop.end - loop.start));
    return Math.min(Math.floor(p), this.totalSamples);
  }

  /** Current playhead position in seconds. */
  get position(): number {
    return this.positionSamples / this.stemRate;
  }

  /** Must be called from the tap/click handler so Safari lets the context resume. */
  play(): void {
    const ctx = this.ctx;
    if (!ctx || !this.node || this.playing || this.lanes.size === 0) return;
    setAudioSessionType('playback');
    if (ctx.state !== 'running') void ctx.resume().catch(() => {});
    if (!this.loop && this.positionSamples >= this.totalSamples) this.setLocalPosition(0);
    this.playing = true;
    this.send({ type: 'play' });
    this.callbacks.onPlayingChange?.(true);
    this.tick();
  }

  pause(): void {
    if (!this.playing) return;
    const position = this.positionSamples;
    this.playing = false;
    this.send({ type: 'pause' });
    this.setLocalPosition(position);
    this.setBuffering(false);
    this.stopTicking();
    this.callbacks.onPlayingChange?.(false);
  }

  seek(seconds: number): void {
    const target = Math.max(0, Math.min(Math.round(seconds * this.stemRate), this.totalSamples));
    this.send({ type: 'seek', position: target });
    this.setLocalPosition(target);
    this.refill();
  }

  /** Sets (or clears, with null) the A–B loop. Takes effect immediately while playing. */
  setLoop(loop: LoopRegion | null): void {
    this.loop = loop ? { start: Math.round(loop.start * this.stemRate), end: Math.round(loop.end * this.stemRate) } : null;
    this.send({ type: 'loop', loop: this.loop });
    if (this.loop && this.positionSamples >= this.loop.end) this.setLocalPosition(this.loop.start);
    this.refill();
  }

  setMix(mix: LaneMix[]): void {
    this.mix = mix;
    this.send({ type: 'gains', gains: effectiveGains(mix) });
  }

  setMasterVolume(volume: number): void {
    this.send({ type: 'master', value: Math.max(0, volume) });
  }

  /** Stops playback, closes the AudioContext and the decoder, and drops all decoded audio. */
  dispose(): void {
    this.disposed = true;
    this.playing = false;
    this.stopTicking();
    if (this.bufferingTimer) clearTimeout(this.bufferingTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.node?.port.close();
    this.node?.disconnect();
    this.node = null;
    this.client?.dispose();
    this.client = null;
    this.lanes.clear();
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => {});
  }

  private send(command: MixerCommand, transfer: Transferable[] = []): void {
    this.node?.port.postMessage(command, transfer);
  }

  private setLocalPosition(position: number): void {
    this.lastReport = {
      type: 'state',
      position,
      time: this.ctx?.currentTime ?? 0,
      playing: this.playing,
      underrun: false,
      ended: false,
    };
    this.callbacks.onPosition?.(position / this.stemRate);
  }

  private onReport(report: MixerReport): void {
    if (this.disposed) return;
    this.lastReport = report;
    if (report.ended && this.playing) {
      this.playing = false;
      this.stopTicking();
      this.setBuffering(false);
      this.callbacks.onPlayingChange?.(false);
      this.callbacks.onPosition?.(this.duration);
    }
    this.setBuffering(this.playing && report.underrun);
    this.refill();
  }

  /** Reports buffering only once the mixer has waited for audio longer than the grace period. */
  private setBuffering(waiting: boolean): void {
    if (!waiting) {
      if (this.bufferingTimer) clearTimeout(this.bufferingTimer);
      this.bufferingTimer = null;
      if (this.buffering) {
        this.buffering = false;
        this.callbacks.onBuffering?.(false);
      }
      return;
    }
    if (this.bufferingTimer || this.buffering) return;
    this.bufferingTimer = setTimeout(() => {
      this.bufferingTimer = null;
      this.buffering = true;
      this.callbacks.onBuffering?.(true);
    }, BUFFERING_GRACE_MS);
  }

  /**
   * Chunks a stem needs now, in play order: from a little before the mixer's last reported
   * position to LOOKAHEAD_SECONDS ahead. This deliberately uses the reported position, not the
   * interpolated one: the estimate runs slightly ahead of the mixer, and dropping a chunk the
   * mixer is still finishing makes it wait for a re-decode — an audible gap.
   */
  private neededChunks(lane: Lane): number[] {
    const reported = this.lastReport?.position ?? 0;
    const margin = Math.round(this.stemRate * KEEP_BEHIND_SECONDS);
    const loop = this.loop;
    // Inside a loop, "behind" the loop start is the loop end, which the window already covers.
    const from = loop && reported >= loop.start && reported - margin < loop.start ? loop.start : Math.max(0, reported - margin);
    return chunksAhead(from, this.stemRate * LOOKAHEAD_SECONDS + margin, this.chunkSize, this.totalSamples, loop)
      .filter((k) => k * this.chunkSize < lane.info.totalSamples);
  }

  /** Drops chunks that are no longer ahead of the playhead and requests the missing ones. */
  private refill(): void {
    const client = this.client;
    if (this.disposed || !client || !this.node) return;
    for (const [id, lane] of this.lanes) {
      const needed = this.neededChunks(lane);
      const keep = new Set(needed);
      for (const k of [...lane.resident]) {
        if (!keep.has(k)) {
          lane.resident.delete(k);
          this.send({ type: 'drop', stemId: id, index: k });
        }
      }
      // Decodes for chunks a seek has left behind don't hold up the new position.
      let busy = needed.filter((k) => lane.inFlight.has(k)).length;
      for (const k of needed) {
        if (busy >= MAX_IN_FLIGHT) break;
        if (lane.resident.has(k) || lane.inFlight.has(k)) continue;
        busy += 1;
        lane.inFlight.add(k);
        client
          .decode(id, k * this.chunkSize, this.chunkSize)
          .then((channels) => {
            lane.inFlight.delete(k);
            lane.failures = 0;
            if (this.disposed || this.lanes.get(id) !== lane) return;
            // The playhead may have moved on while this chunk was decoding.
            if (this.neededChunks(lane).includes(k)) {
              lane.resident.add(k);
              this.send({ type: 'chunk', stemId: id, index: k, channels }, channels.map((c) => c.buffer));
            }
            this.refill();
          })
          .catch((err: unknown) => {
            lane.inFlight.delete(k);
            if (this.disposed || this.lanes.get(id) !== lane) return;
            console.error(`[StemPlayer] Failed to decode ${id} chunk ${k}:`, err);
            lane.failures += 1;
            if (lane.failures >= MAX_DECODE_FAILURES) {
              // Without this the mixer would wait for the stem forever ("Buffering…").
              this.lanes.delete(id);
              this.send({ type: 'removeStem', stemId: id });
              this.callbacks.onStemFailed?.(id);
              this.refill();
              return;
            }
            this.retryTimer ??= setTimeout(() => {
              this.retryTimer = null;
              this.refill();
            }, 1000);
          });
      }
    }
  }

  private tick = (): void => {
    if (!this.playing) return;
    this.callbacks.onPosition?.(this.position);
    if (typeof requestAnimationFrame === 'function') this.frame = requestAnimationFrame(this.tick);
  };

  private stopTicking(): void {
    if (this.frame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.frame);
    this.frame = null;
  }
}
