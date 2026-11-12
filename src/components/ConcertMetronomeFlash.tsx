import { useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { parseBeatsPerBar } from '../utils/metronome';
import { resumeAudioContext } from '../lib/webAudio';

interface Props {
  tempo?: number;
  timeSignature?: string;
  /** Flash the screen edge on each beat. */
  flash: boolean;
  /**
   * Play a click on each beat through this context. It must have been created (and
   * resumed) from a user gesture — see createResumedAudioContext. null = silent.
   */
  audioContext: AudioContext | null;
  /** CSS colour for beat one of the bar (the user's preference). */
  downbeatColor?: string;
}

// How far ahead beats are scheduled, and how often the scheduler looks. A busy page can
// delay the scheduler by up to LOOKAHEAD - TICK without a single beat landing late.
const LOOKAHEAD_S = 0.15;
const TICK_MS = 50;

function scheduleClick(ctx: AudioContext, at: number, isDownbeat: boolean) {
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = isDownbeat ? 1000 : 800;
    gain.gain.setValueAtTime(0.35, at);
    gain.gain.exponentialRampToValueAtTime(0.001, at + 0.06);
    osc.start(at);
    osc.stop(at + 0.06);
  } catch {
    // AudioContext may be unavailable in some environments
  }
}

/**
 * Concert Mode beat: flashes the screen edge on every beat of the current song's tempo
 * (bigger and in its own colour on beat one of the bar, per the time signature) and/or
 * plays a click (higher on beat one). Renders nothing without a tempo.
 *
 * Timing doesn't rest on a JavaScript timer firing on the beat (they fire late whenever the
 * page is busy). Beats sit on a fixed grid of clock times, and a relaxed scheduler queues
 * the next ones a little ahead: clicks on the audio clock, played by the audio hardware
 * exactly then; flashes as CSS animations with a start delay, started on time by the GPU.
 * With the click on, the audio clock drives both, and each flash is timed to when its click
 * is actually heard — output latency (several ms on a speaker, far more over Bluetooth)
 * included — so they stay together.
 */
export default function ConcertMetronomeFlash({ tempo, timeSignature, flash, audioContext, downbeatColor }: Props) {
  const bpm = typeof tempo === 'number' && Number.isFinite(tempo) && tempo > 0
    ? Math.round(tempo)
    : null;
  const beatsPerBar = useMemo(() => parseBeatsPerBar(timeSignature), [timeSignature]);
  const layerRef = useRef<HTMLDivElement>(null);
  const flashRef = useRef(flash);
  flashRef.current = flash;

  const running = Boolean(bpm) && (flash || Boolean(audioContext));

  useEffect(() => {
    if (!bpm || !running) return;
    const ctx = audioContext;
    const secondsPerBeat = Math.max(0.08, 60 / bpm);
    // The clock: the audio clock when clicking, otherwise the page's (both in seconds).
    const now = () => (ctx ? ctx.currentTime : performance.now() / 1000);
    // How long from now until a beat at clock time t is heard (or, without a click, due), in
    // ms. Read straight off the clock that schedules it, plus the output latency the browser
    // reports. (Not via getOutputTimestamp: on iOS its performanceTime isn't reliably on the
    // page's clock, which left flashes scheduled far off — never shown, or only every other.)
    const msUntil = (t: number) => {
      if (!ctx) return t * 1000 - performance.now();
      const latency = ctx.outputLatency || ctx.baseLatency || 0;
      return (t - ctx.currentTime + latency) * 1000;
    };
    const showFlash = (isDownbeat: boolean, inMs: number) => {
      const layer = layerRef.current;
      if (!layer) return;
      const el = document.createElement('span');
      el.className = `concert-metronome-flash${isDownbeat ? ' is-downbeat' : ''}`;
      el.style.animationDelay = `${Math.max(0, inMs)}ms`;
      el.addEventListener('animationend', () => el.remove());
      layer.appendChild(el);
    };

    if (ctx) resumeAudioContext(ctx);
    // (Re)starting — new song tempo/metre, or flash/click switched on — begins a fresh bar,
    // a moment from now so beat one can be scheduled ahead like the rest.
    const start = now() + 0.05;
    let beat = 0;
    const schedule = () => {
      const t = now();
      // Fallen behind (e.g. back from the background): skip the missed beats, don't burst.
      const behind = Math.ceil((t - (start + beat * secondsPerBeat)) / secondsPerBeat);
      if (behind > 0) beat += behind;
      for (let at = start + beat * secondsPerBeat; at < t + LOOKAHEAD_S; at = start + beat * secondsPerBeat) {
        const isDownbeat = beat % beatsPerBar === 0;
        if (ctx) scheduleClick(ctx, at, isDownbeat);
        if (flashRef.current) showFlash(isDownbeat, msUntil(at));
        beat += 1;
      }
    };
    schedule();
    const id = window.setInterval(schedule, TICK_MS);
    const layer = layerRef.current;
    return () => {
      window.clearInterval(id);
      layer?.replaceChildren(); // drop flashes still waiting for their beat
    };
  }, [bpm, beatsPerBar, running, audioContext]);

  if (!bpm) return null;

  return createPortal(
    <div
      ref={layerRef}
      className="concert-metronome-layer"
      style={downbeatColor ? ({ '--metronome-flash-downbeat-color': downbeatColor } as React.CSSProperties) : undefined}
      aria-hidden="true"
    />,
    document.body
  );
}
