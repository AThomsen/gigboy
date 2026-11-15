import { useRef, useState } from 'react';
import { Pause, ChevronsDown } from 'lucide-react';

interface Props {
  scrolling: boolean;
  speed: number;
  min: number;
  max: number;
  onToggle: () => void;
  /** Called live while dragging; `done` on release (to save it). */
  onSpeedChange: (speed: number, done: boolean) => void;
}

// Press this long (or start dragging) to adjust the speed instead of toggling.
const HOLD_MS = 350;
const DRAG_START_PX = 10;
// Length of the speed track: the whole speed range.
const TRACK_PX = 250;

/**
 * Concert mode's autoscroll control, at the right edge of the chart: tap to start/pause.
 * Press and hold (or just drag) and a speed track appears through the button, which becomes
 * its handle: drag it along (down is faster, like the scroll) to change the speed, live. The
 * track is placed so the handle starts right under the finger; let go and it slides home.
 */
export default function ConcertAutoscrollButton({ scrolling, speed, min, max, onToggle, onSpeedChange }: Props) {
  const [adjusting, setAdjusting] = useState(false);
  // Where the speed was when the press started, as a fraction of the range (places the track).
  const [startFraction, setStartFraction] = useState(0);
  const fraction = (value: number) => (value - min) / (max - min);
  const pressRef = useRef<{ pointerId: number; y: number; speed: number; timer: number; held: boolean; value: number } | null>(null);
  // The click that follows a press used for adjusting isn't a toggle.
  const skipClickRef = useRef(false);

  const startAdjusting = () => {
    const press = pressRef.current;
    if (!press || press.held) return;
    window.clearTimeout(press.timer);
    press.held = true;
    setStartFraction(fraction(press.speed));
    setAdjusting(true);
  };

  const finish = (pointerId: number) => {
    const press = pressRef.current;
    if (!press || press.pointerId !== pointerId) return;
    window.clearTimeout(press.timer);
    pressRef.current = null;
    if (!press.held) return;
    skipClickRef.current = true;
    setAdjusting(false);
    onSpeedChange(press.value, true);
  };

  // The handle's offset from home along the track: the speed change, in track pixels.
  const offset = adjusting ? (fraction(speed) - startFraction) * TRACK_PX : 0;

  return (
    <div className="concert-autoscroll">
      {adjusting && (
        <div
          className="concert-autoscroll-track"
          style={{ top: `calc(50% - ${startFraction * TRACK_PX}px)`, height: TRACK_PX }}
          aria-hidden="true"
        >
          <div className="concert-autoscroll-track-fill" style={{ height: `${fraction(speed) * 100}%` }} />
        </div>
      )}
      <button
        type="button"
        className={`concert-autoscroll-btn${scrolling ? ' is-playing' : ''}${adjusting ? ' is-adjusting' : ''}`}
        aria-label={scrolling ? 'Pause autoscroll (hold to change speed)' : 'Start autoscroll (hold to change speed)'}
        aria-pressed={scrolling}
        style={{ transform: `translateY(${offset}px)` }}
        onPointerDown={(e) => {
          skipClickRef.current = false;
          e.currentTarget.setPointerCapture(e.pointerId);
          pressRef.current = {
            pointerId: e.pointerId,
            y: e.clientY,
            speed,
            value: speed,
            held: false,
            timer: window.setTimeout(startAdjusting, HOLD_MS),
          };
        }}
        onPointerMove={(e) => {
          const press = pressRef.current;
          if (!press || press.pointerId !== e.pointerId) return;
          const dy = e.clientY - press.y;
          if (!press.held && Math.abs(dy) > DRAG_START_PX) startAdjusting();
          if (!press.held) return;
          press.value = Math.round(Math.min(max, Math.max(min, press.speed + dy * ((max - min) / TRACK_PX))));
          onSpeedChange(press.value, false);
        }}
        onPointerUp={(e) => finish(e.pointerId)}
        onPointerCancel={(e) => finish(e.pointerId)}
        onClick={() => {
          if (skipClickRef.current) {
            skipClickRef.current = false;
            return;
          }
          onToggle();
        }}
      >
        {adjusting
          ? <span className="concert-autoscroll-speed" role="status" aria-label={`Autoscroll speed ${speed}`}>{speed}</span>
          : scrolling
            ? <Pause size={18} fill="currentColor" />
            : <ChevronsDown size={20} />}
      </button>
    </div>
  );
}
