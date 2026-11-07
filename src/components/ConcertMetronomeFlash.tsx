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
 * (brighter on the downbeat) and/or plays a click. One clock drives both so they stay
 * in sync. Renders nothing without a tempo.
 */
export default function ConcertMetronomeFlash({ tempo, timeSignature, flash, audioContext }: Props) {
  const bpm = typeof tempo === 'number' && Number.isFinite(tempo) && tempo > 0
    ? Math.round(tempo)
    : null;
  const beatsPerBar = useMemo(() => parseBeatsPerBar(timeSignature), [timeSignature]);
  const [activeBeat, setActiveBeat] = useState(0);
  const [tick, setTick] = useState(0);
  const beatRef = useRef(0);
  const audioRef = useRef(audioContext);
  audioRef.current = audioContext;

  useEffect(() => {
    beatRef.current = 0;
    setActiveBeat(0);
  }, [bpm, beatsPerBar]);

  const running = Boolean(bpm) && (flash || Boolean(audioContext));

  useEffect(() => {
    if (!bpm || !running) return;
    const intervalMs = Math.max(80, Math.round(60000 / bpm));
    const intervalId = window.setInterval(() => {
      const beat = (beatRef.current + 1) % beatsPerBar;
      beatRef.current = beat;
      if (audioRef.current) playClick(audioRef.current, beat === 0);
      setActiveBeat(beat);
      setTick((t) => t + 1);
    }, intervalMs);
    return () => window.clearInterval(intervalId);
  }, [bpm, beatsPerBar, running]);

  if (!bpm || !flash) return null;

  return createPortal(
    <span
      key={tick}
      className={`concert-metronome-flash${activeBeat === 0 ? ' is-downbeat' : ''}`}
      aria-hidden="true"
    />,
    document.body
  );
}
