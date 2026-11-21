import { useRef, useState } from 'react';
import { ChevronsDown, ChevronsUp, Pause } from 'lucide-react';

interface Props {
  scrolling: boolean;
  /** In px/s, for the drag track. */
  speed: number;
  /** Shown on the handle while adjusting instead of the raw speed, e.g. the song's scroll time. */
  speedLabel?: string;
  min: number;
  max: number;
  onToggle: () => void;
  /** Called live while dragging; `done` on release (to save it). */
  onSpeedChange: (speed: number, done: boolean) => void;
  /** Scroll back up at this many px/s while the handle is dragged above the track; 0 = don't. */
  onRewind: (pxPerSecond: number) => void;
}

// Press this long (or start dragging) to adjust the speed instead of toggling.
const HOLD_MS = 350;
const DRAG_START_PX = 10;
// Length of the speed track: the whole speed range.
const TRACK_PX = 250;
// Above the track (past the slowest end) the handle rewinds instead: the further up, the
// faster the chart scrolls back, up to REWIND_MAX at REWIND_ZONE_PX above the track.
const REWIND_ZONE_PX = 120;
const REWIND_MAX_PX_PER_S = 400;

/**
 * Concert mode's autoscroll control, at the right edge of the chart: tap to start/pause.
 * Press and hold (or just drag): autoscroll starts if paused, and a speed track appears
 * through the button, which becomes its handle: drag it along (down is faster, like the
 * scroll) to change the speed, live. The track is placed so the handle starts right under
 * the finger; let go and it slides home.
 * Dragged on up past the track's top (the slowest end), it scrolls the chart back instead,
 * faster the further up: for when the song ran ahead. Back on the track, autoscroll carries on.
 */
export default function ConcertAutoscrollButton({ scrolling, speed, speedLabel, min, max, onToggle, onSpeedChange, onRewind }: Props) {
  const [adjusting, setAdjusting] = useState(false);
  // How far the handle is above the track (0 = on it).
  const [overshoot, setOvershoot] = useState(0);
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
    // Adjusting the speed means wanting to see it: a paused autoscroll starts right away.
    if (!scrolling) onToggle();
  };

  const finish = (pointerId: number) => {
    const press = pressRef.current;
    if (!press || press.pointerId !== pointerId) return;
    window.clearTimeout(press.timer);
    pressRef.current = null;
    if (!press.held) return;
    skipClickRef.current = true;
    setAdjusting(false);
    setOvershoot(0);
    onRewind(0);
    onSpeedChange(press.value, true);
  };

  // The handle's offset from home: along the track (the speed change, in track pixels), or
  // above its top while rewinding.
  const trackTop = -startFraction * TRACK_PX;
  const offset = !adjusting ? 0
    : overshoot > 0 ? trackTop - overshoot
      : (fraction(speed) - startFraction) * TRACK_PX;

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
      {adjusting && (
        <div
          className={`concert-autoscroll-rewind${overshoot > 0 ? ' is-active' : ''}`}
          style={{ top: `calc(50% + ${trackTop - REWIND_ZONE_PX}px)`, height: REWIND_ZONE_PX }}
          aria-hidden="true"
        />
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
          // Above the track: rewind, faster the further up (the speed stays at its slowest).
          const above = Math.min(REWIND_ZONE_PX, Math.max(0, -fraction(press.speed) * TRACK_PX - dy));
          setOvershoot(above);
          onRewind((above / REWIND_ZONE_PX) * REWIND_MAX_PX_PER_S);
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
        {adjusting && overshoot > 0
          ? <ChevronsUp size={22} aria-label="Scrolling back" />
          : adjusting
            ? (
              <span
                className="concert-autoscroll-speed"
                role="status"
                aria-label={speedLabel ? `Scrolls through in ${speedLabel}` : `Autoscroll speed ${speed}`}
              >
                {speedLabel ?? speed}
              </span>
            )
            : scrolling
              ? <Pause size={18} fill="currentColor" />
              : <ChevronsDown size={20} />}
      </button>
    </div>
  );
}
