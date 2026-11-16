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
  /**
   * A clock shared with other devices, as its lead over `performance.now()` in ms (see
   * useServerClockOffset). Given, the bars are counted from its zero, so every device on it
   * with the same song keeps the same beat. null/undefined = this device's own beat.
   */
  sharedClock?: number | null;
}

// How far ahead beats are queued. The scheduler wakes once per beat, just as the next one
// comes within this window (with WAKE_SLACK_MS to spare), so a busy page or a late timer
// can hold it up by nearly the whole window without a beat landing late.
const LOOKAHEAD_S = 0.25;
const WAKE_SLACK_MS = 30;
// While the click's audio is still starting up (its clock stands still), check back soon.
const AUDIO_WAIT_MS = 50;

/** Queues a click at audio time `at`; returns its node, so it can be cancelled before it plays. */
function scheduleClick(ctx: AudioContext, at: number, isDownbeat: boolean): OscillatorNode | null {
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
    return osc;
  } catch {
    // AudioContext may be unavailable in some environments
    return null;
  }
}

/**
 * Concert Mode beat: flashes the screen edge on every beat of the current song's tempo
 * (bigger and in its own colour on beat one of the bar, per the time signature) and/or
 * plays a click (higher on beat one). Renders nothing without a tempo.
 *
 * Timing doesn't rest on a JavaScript timer firing on the beat (they fire late whenever the
 * page is busy). Beats sit on a fixed grid of times, and a scheduler that wakes once per
 * beat queues the next ones a little ahead: flashes as CSS animations with a start delay, started on time by
 * the GPU; clicks on the audio clock, played by the audio hardware exactly then. The grid
 * is in page time; clicks are placed on it through one page-to-audio conversion that
 * allows for output latency (several ms on a speaker, far more over Bluetooth), so a click
 * is heard as its flash shows.
 *
 * Given a shared clock (in a setlist session), the grid is laid on it instead, so the band's
 * devices flash and click together without sending the beat around.
 */
export default function ConcertMetronomeFlash({ tempo, timeSignature, flash, audioContext, downbeatColor, sharedClock }: Props) {
  const bpm = typeof tempo === 'number' && Number.isFinite(tempo) && tempo > 0
    ? Math.round(tempo)
    : null;
  const beatsPerBar = useMemo(() => parseBeatsPerBar(timeSignature), [timeSignature]);
  const layerRef = useRef<HTMLDivElement>(null);
  const flashRef = useRef(flash);
  flashRef.current = flash;

  const running = Boolean(bpm) && (flash || Boolean(audioContext));
  // The song's beat grid, in page time: when beat 0 is due (seen / heard), and the next beat
  // still to be flashed. Kept while the metronome runs, so switching the click on or off
  // carries on in the same bar; the parent remounts this per song for a fresh one. On a
  // shared clock it's laid out from that clock, and again whenever the reading of it changes.
  const gridRef = useRef<{ anchor: number; nextFlash: number; clock: number | null } | null>(null);
  const clock = sharedClock ?? null;

  useEffect(() => {
    if (!bpm || !running) {
      gridRef.current = null;
      layerRef.current?.replaceChildren(); // drop flashes still waiting for their beat
      return;
    }
    const ctx = audioContext;
    const beatMs = Math.max(80, 60000 / bpm);
    if (gridRef.current && gridRef.current.clock !== clock) {
      // A new reading of the shared clock moves the beat (a little): drop the flashes queued
      // on the old one, or they'd show next to the moved ones.
      gridRef.current = null;
      layerRef.current?.replaceChildren();
    }
    if (!gridRef.current) {
      const now = performance.now();
      if (clock === null) {
        // Starting: beat one a moment from now, so it can be queued ahead like the rest.
        gridRef.current = { anchor: now + 50, nextFlash: 0, clock };
      } else {
        // The bar under way on the shared clock, counted from its zero: the same on every device.
        const barMs = beatMs * beatsPerBar;
        gridRef.current = { anchor: Math.floor((now + clock) / barMs) * barMs - clock, nextFlash: 0, clock };
      }
    }
    const grid = gridRef.current;
    const beatAt = (n: number) => grid.anchor + n * beatMs;
    const firstBeatFrom = (ms: number) => Math.max(0, Math.ceil((ms - grid.anchor) / beatMs));
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
    // Audio time minus page time (s) for this context, less its output latency, so a click
    // put at a beat's page time converted this way is *heard* on it. Taken once the context
    // runs (a resuming one's clock stands still) and again after any interruption. Not via
    // getOutputTimestamp: on iOS its performanceTime isn't reliably on the page's clock.
    let audioOffset: number | null = null;
    let nextClick = 0;
    let timer = 0;
    // Clicks queued but not yet played. Cancelled when this run ends (the click switched off,
    // or a restart), or they'd play late once the audio resumes, right next to the fresh ones.
    const queuedClicks = new Set<OscillatorNode>();
    const schedule = () => {
      const now = performance.now();
      // Fallen behind (e.g. back from the background): skip missed beats, don't burst.
      grid.nextFlash = Math.max(grid.nextFlash, firstBeatFrom(now));
      for (; beatAt(grid.nextFlash) < now + LOOKAHEAD_S * 1000; grid.nextFlash += 1) {
        if (flashRef.current) showFlash(grid.nextFlash % beatsPerBar === 0, beatAt(grid.nextFlash) - now);
      }
      // Next wake-up: as the next beat still to be queued comes within the lookahead.
      const wakeFor = (beatMs: number) => {
        timer = window.setTimeout(schedule, Math.max(10, beatMs - LOOKAHEAD_S * 1000 + WAKE_SLACK_MS - now));
      };
      if (!ctx) {
        wakeFor(beatAt(grid.nextFlash));
        return;
      }
      if (ctx.state !== 'running') {
        audioOffset = null;
        timer = window.setTimeout(schedule, AUDIO_WAIT_MS);
        return;
      }
      if (audioOffset === null) {
        audioOffset = ctx.currentTime - now / 1000 - (ctx.outputLatency || ctx.baseLatency || 0);
        nextClick = firstBeatFrom(now);
      }
      const clickAt = (n: number) => beatAt(n) / 1000 + audioOffset!;
      const audioNow = ctx.currentTime;
      while (clickAt(nextClick) < audioNow) nextClick += 1;
      for (; clickAt(nextClick) < audioNow + LOOKAHEAD_S; nextClick += 1) {
        const osc = scheduleClick(ctx, clickAt(nextClick), nextClick % beatsPerBar === 0);
        if (osc) {
          queuedClicks.add(osc);
          osc.onended = () => queuedClicks.delete(osc);
        }
      }
      wakeFor(Math.min(beatAt(grid.nextFlash), beatAt(nextClick)));
    };
    schedule();
    return () => {
      window.clearTimeout(timer);
      queuedClicks.forEach((osc) => {
        try { osc.disconnect(); } catch { /* already gone */ }
      });
    };
  }, [bpm, beatsPerBar, running, audioContext, clock]);

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
