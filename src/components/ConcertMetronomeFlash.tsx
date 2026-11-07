import { useEffect, useMemo, useRef, useState } from 'react';
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

function playClick(ctx: AudioContext, isDownbeat: boolean) {
  try {
    resumeAudioContext(ctx);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = isDownbeat ? 1000 : 800;
    gain.gain.setValueAtTime(0.35, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.06);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.06);
  } catch {
    // AudioContext may be unavailable in some environments
  }
}

/**
 * Concert Mode beat: flashes the screen edge on every beat of the current song's tempo
 * (bigger and in its own colour on beat one of the bar, per the time signature) and/or
 * plays a click (higher on beat one). One clock drives both so they stay
 * in sync. Renders nothing without a tempo.
 */
export default function ConcertMetronomeFlash({ tempo, timeSignature, flash, audioContext, downbeatColor }: Props) {
  const bpm = typeof tempo === 'number' && Number.isFinite(tempo) && tempo > 0
    ? Math.round(tempo)
    : null;
  const beatsPerBar = useMemo(() => parseBeatsPerBar(timeSignature), [timeSignature]);
  const [activeBeat, setActiveBeat] = useState(0);
  const [tick, setTick] = useState(0);
  // Index of the last beat played; -1 so the first tick lands on beat one.
  const beatRef = useRef(-1);
  const audioRef = useRef(audioContext);
  audioRef.current = audioContext;

  const running = Boolean(bpm) && (flash || Boolean(audioContext));

  useEffect(() => {
    if (!bpm || !running) return;
    const intervalMs = Math.max(80, Math.round(60000 / bpm));
    // (Re)starting — new song tempo/metre, or flash/click switched on — begins a fresh bar.
    beatRef.current = -1;
    const playBeat = () => {
      const beat = (beatRef.current + 1) % beatsPerBar;
      beatRef.current = beat;
      if (audioRef.current) playClick(audioRef.current, beat === 0);
      setActiveBeat(beat);
      setTick((t) => t + 1);
    };
    playBeat(); // Beat one right away, rather than a beat's silence first.
    const intervalId = window.setInterval(playBeat, intervalMs);
    return () => window.clearInterval(intervalId);
  }, [bpm, beatsPerBar, running]);

  // tick 0 = no beat played yet; don't flash before the clock's first beat.
  if (!bpm || !flash || tick === 0) return null;

  return createPortal(
    <span
      key={tick}
      className={`concert-metronome-flash${activeBeat === 0 ? ' is-downbeat' : ''}`}
      style={downbeatColor ? ({ '--metronome-flash-downbeat-color': downbeatColor } as React.CSSProperties) : undefined}
      aria-hidden="true"
    />,
    document.body
  );
}
