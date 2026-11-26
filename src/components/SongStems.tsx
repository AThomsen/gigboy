import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { Minus, Pause, Play, Plus, Repeat, Trash2, Upload, X } from 'lucide-react';
import type { SongStem } from '../lib/songStems';
import type { SongStemsState } from '../hooks/useSongStems';
import { FULL_MIX_STEMS, STEM_IMPORT_ACCEPT, stemColor } from '../lib/stemImport';
import { MAX_SPEED_PERCENT, MAX_TRANSPOSE, MIN_SPEED_PERCENT, normalizeLoop, StemPlayer, type LaneMix } from '../lib/stemPlayer';
import { transposeChord } from '../utils/chordParser';
import { showConfirmToast } from '../utils/toastDialogs';
import toast from '../utils/anchoredToast';
import { readStoredString, removeStoredString, writeStoredString } from '../lib/safeStorage';

interface Props {
  /** Practice settings (loop, speed, pitch) are remembered per song on this device. */
  songId: string;
  stemsState: SongStemsState;
  canEdit: boolean;
  /** The song's key, to name the key the stems are transposed to. */
  songKey?: string;
  /** The chord chart's current transpose, offered as a one-tap pitch for the stems. */
  chartTranspose?: number;
}

const SPEED_STEP = 5;
/** Pointer travel (px) that turns a tap (seek) into a drag (loop selection). */
const DRAG_THRESHOLD_PX = 6;
/** How close (px) to a loop edge a drag must start to move that edge instead of drawing a new loop. */
const EDGE_GRAB_PX = 12;

/** A track's mix as saved, tied to the upload it was set for. */
interface SavedLane {
  /** The stem's createdAt: re-uploading a stem changes it, which discards the saved mix. */
  version: string;
  volume: number;
  muted: boolean;
  solo: boolean;
}

interface PracticeSettings {
  speed: number;
  transpose: number;
  loop: { start: number; end: number; on: boolean } | null;
  /** Only tracks that differ from their default mix, keyed by stem id. */
  lanes: Record<string, SavedLane>;
}

const DEFAULT_SETTINGS: PracticeSettings = { speed: 100, transpose: 0, loop: null, lanes: {} };

function settingsKey(songId: string): string {
  return `gigboy-stems-settings-${songId}`;
}

function readSettings(songId: string): PracticeSettings {
  const raw = readStoredString(settingsKey(songId));
  if (!raw) return DEFAULT_SETTINGS;
  try {
    const parsed = JSON.parse(raw) as Partial<PracticeSettings>;
    const num = (v: unknown, fallback: number, min: number, max: number) =>
      typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
    const loop = parsed.loop;
    const lanes: Record<string, SavedLane> = {};
    if (parsed.lanes && typeof parsed.lanes === 'object') {
      for (const [id, lane] of Object.entries(parsed.lanes as Record<string, Partial<SavedLane>>)) {
        if (!lane || typeof lane.version !== 'string') continue;
        lanes[id] = { version: lane.version, volume: num(lane.volume, 1, 0, 1.5), muted: lane.muted === true, solo: lane.solo === true };
      }
    }
    return {
      lanes,
      speed: num(parsed.speed, 100, MIN_SPEED_PERCENT, MAX_SPEED_PERCENT),
      transpose: Math.round(num(parsed.transpose, 0, -MAX_TRANSPOSE, MAX_TRANSPOSE)),
      loop:
        loop && typeof loop.start === 'number' && typeof loop.end === 'number' && loop.end > loop.start && loop.start >= 0
          ? { start: loop.start, end: loop.end, on: loop.on !== false }
          : null,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function writeSettings(songId: string, settings: PracticeSettings): void {
  if (settings.speed === 100 && settings.transpose === 0 && !settings.loop && Object.keys(settings.lanes).length === 0) removeStoredString(settingsKey(songId));
  else writeStoredString(settingsKey(songId), JSON.stringify(settings));
}

interface LoopDrag {
  pointerId: number;
  startX: number;
  rect: DOMRect;
  /** The fixed end of the selection, in seconds. */
  anchor: number;
  /** True once the pointer has moved far enough to count as a drag. */
  dragging: boolean;
  /** Grabbing an existing edge starts as a drag right away. */
  edge: boolean;
}

function pitchLabel(transpose: number, songKey: string | undefined): string {
  if (songKey) return `Key of ${transpose === 0 ? songKey : transposeChord(songKey.replace(/^H/i, 'B'), transpose)}`;
  return transpose === 0 ? 'Original key' : `${transpose > 0 ? '+' : ''}${transpose} st`;
}

function formatTime(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`;
}

function stemLabel(name: string): string {
  const label = name.replace(/[_-]+/g, ' ');
  return label.charAt(0).toUpperCase() + label.slice(1);
}

type Lane = LaneMix & { version: string };

function defaultMix(stem: SongStem): Lane {
  return { id: stem.id, version: stem.createdAt, volume: 1, muted: FULL_MIX_STEMS.has(stem.name), solo: false };
}

function isDefaultMix(lane: Lane, stem: SongStem): boolean {
  const d = defaultMix(stem);
  return lane.volume === d.volume && lane.muted === d.muted && lane.solo === d.solo;
}

/** One SVG path of mirrored bars — a single element per lane keeps rerenders cheap. */
function WaveformPath({ bars }: { bars: number[] }) {
  const d = useMemo(
    () =>
      bars
        .map((v, i) => {
          const h = Math.max(0.02, Math.min(1, v)) * 48;
          return `M${i + 0.15} ${50 - h}h0.7v${h * 2}h-0.7z`;
        })
        .join(''),
    [bars],
  );
  return (
    <svg className="stems-waveform-svg" viewBox={`0 0 ${Math.max(1, bars.length)} 100`} preserveAspectRatio="none" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export default function SongStems({ songId, stemsState, canEdit, songKey, chartTranspose = 0 }: Props) {
  const { stems, loading, progress, error, importStems, deleteStem, deleteAllStems } = stemsState;
  const rootRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const playerRef = useRef<StemPlayer | null>(null);

  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [duration, setDuration] = useState(0);
  const [loadProgress, setLoadProgress] = useState<{ loaded: number; total: number } | null>(null);
  const [failedIds, setFailedIds] = useState<string[]>([]);
  const [mix, setMix] = useState<Record<string, Lane>>({});
  // Restored once per mount; SongView keys this component by song, so a new song remounts it.
  const [initialSettings] = useState(() => readSettings(songId));
  const [markerA, setMarkerA] = useState<number | null>(initialSettings.loop?.start ?? null);
  const [markerB, setMarkerB] = useState<number | null>(initialSettings.loop?.end ?? null);
  /** The loop being drawn, shown live but only handed to the player on release. */
  const [draftLoop, setDraftLoop] = useState<{ a: number; b: number } | null>(null);
  const dragRef = useRef<LoopDrag | null>(null);
  const [loopOn, setLoopOn] = useState(initialSettings.loop?.on ?? false);
  const [speed, setSpeed] = useState(initialSettings.speed);
  const [transpose, setTranspose] = useState(initialSettings.transpose);
  const durationRef = useRef(0);
  // Read when the stems finish loading, to start a restored loop from its top.
  const loopStateRef = useRef({ markerA, markerB, loopOn });
  loopStateRef.current = { markerA, markerB, loopOn };

  // The playhead moves every frame; write it straight to the DOM instead of re-rendering.
  const showPosition = useCallback((seconds: number) => {
    const total = durationRef.current;
    rootRef.current?.style.setProperty('--stems-progress', String(total > 0 ? Math.min(1, seconds / total) : 0));
    if (timeRef.current) timeRef.current.textContent = formatTime(seconds);
  }, []);

  // Reload the player whenever the set of stems (or a replaced stem's file) changes.
  const loadKey = stems.map((s) => s.downloadUrl).join('|');
  useEffect(() => {
    if (stems.length === 0) return;
    const player = new StemPlayer({
      onPosition: showPosition,
      onPlayingChange: setPlaying,
      onBuffering: setBuffering,
      onStemFailed: (id) => setFailedIds((prev) => (prev.includes(id) ? prev : [...prev, id])),
      onPitchShiftFailed: () => toast.error("Couldn't load the pitch shifter: speed changes will change the pitch too."),
    });
    playerRef.current = player;
    setPlaying(false);
    setBuffering(false);
    setFailedIds([]);
    setDuration(0);
    durationRef.current = 0;
    showPosition(0);
    let cancelled = false;
    void player
      .load(stems.map((s) => ({ id: s.id, url: s.downloadUrl })), (loaded, total) => {
        if (!cancelled) setLoadProgress({ loaded, total });
      })
      .then(({ failed }) => {
        if (cancelled) return;
        setLoadProgress(null);
        setFailedIds(failed);
        durationRef.current = player.duration;
        setDuration(player.duration);
        showPosition(0);
        const { markerA: a, markerB: b, loopOn: on } = loopStateRef.current;
        const restored = on && a !== null && b !== null ? normalizeLoop(a, b, player.duration) : null;
        if (restored) player.seek(restored.start);
      })
      .catch((err: unknown) => {
        // e.g. no AudioWorklet support, or the decoder worker failed to start.
        console.error('[SongStems] Failed to load the stem player:', err);
        if (cancelled) return;
        setLoadProgress(null);
        setFailedIds(stems.map((s) => s.id));
      });
    return () => {
      cancelled = true;
      player.dispose();
      if (playerRef.current === player) playerRef.current = null;
    };
    // stems is captured through loadKey; reloading on every array identity change would refetch needlessly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadKey, showPosition]);

  // Keep mixer state for stems that are still there, then a mix saved on this device; a new or
  // re-uploaded stem (new createdAt) starts from the defaults.
  const savedLanesRef = useRef(initialSettings.lanes);
  const hadStemsRef = useRef(false);
  useEffect(() => {
    const savedLanes = savedLanesRef.current;
    setMix((prev) => {
      const next: Record<string, Lane> = {};
      for (const stem of stems) {
        const kept = prev[stem.id];
        const saved = savedLanes[stem.id];
        next[stem.id] =
          kept?.version === stem.createdAt ? kept
          : saved?.version === stem.createdAt ? { id: stem.id, ...saved }
          : defaultMix(stem);
      }
      return next;
    });
  }, [stems]);

  useEffect(() => {
    playerRef.current?.setMix(Object.values(mix));
  }, [mix, duration]);

  useEffect(() => {
    playerRef.current?.setSpeed(speed / 100);
    playerRef.current?.setTranspose(transpose);
  }, [speed, transpose, duration]);

  const loop = markerA !== null && markerB !== null ? normalizeLoop(markerA, markerB, duration) : null;
  // A loop is only kept once both ends are set; a lone keyboard marker isn't worth remembering.
  const loopToSave = markerA !== null && markerB !== null && markerA !== markerB
    ? { start: Math.min(markerA, markerB), end: Math.max(markerA, markerB), on: loopOn }
    : null;
  useEffect(() => {
    // Until the stems have loaded, keep what was saved; once they have, the live mix is the truth
    // (so removing every stem drops the saved mix too).
    if (stems.length > 0) hadStemsRef.current = true;
    // The mix is rebuilt a render after the stems change; wait for it to catch up.
    const mixInSync = Object.keys(mix).length === stems.length && stems.every((stem) => mix[stem.id]?.version === stem.createdAt);
    if (hadStemsRef.current && mixInSync) {
      const lanes: Record<string, SavedLane> = {};
      for (const stem of stems) {
        const lane = mix[stem.id];
        if (!isDefaultMix(lane, stem)) {
          lanes[stem.id] = { version: lane.version, volume: lane.volume, muted: lane.muted, solo: lane.solo };
        }
      }
      savedLanesRef.current = lanes;
    }
    writeSettings(songId, { speed, transpose, loop: loopToSave, lanes: savedLanesRef.current });
  }, [songId, speed, transpose, loopToSave?.start, loopToSave?.end, loopToSave?.on, mix, stems]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    playerRef.current?.setLoop(loopOn && loop ? loop : null);
  }, [loopOn, loop?.start, loop?.end, duration]); // eslint-disable-line react-hooks/exhaustive-deps

  const ready = stems.length > 0 && loadProgress === null && duration > 0;
  const anySolo = Object.values(mix).some((lane) => lane.solo);

  const togglePlay = () => {
    const player = playerRef.current;
    if (!player || !ready) return;
    if (player.isPlaying) player.pause();
    else player.play();
  };

  const seekTo = (seconds: number) => playerRef.current?.seek(seconds);

  const timeAt = (clientX: number, rect: DOMRect) =>
    rect.width > 0 ? Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * duration : 0;

  // Tap a waveform to seek; drag across it to select a loop (or drag a loop edge to adjust it).
  const handleWavePointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (!ready || event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const x = event.clientX - rect.left;
    const edgeX = (t: number) => (t / duration) * rect.width;
    let anchor = timeAt(event.clientX, rect);
    let edge = false;
    if (loop) {
      if (Math.abs(x - edgeX(loop.start)) <= EDGE_GRAB_PX) { anchor = loop.end; edge = true; }
      else if (Math.abs(x - edgeX(loop.end)) <= EDGE_GRAB_PX) { anchor = loop.start; edge = true; }
    }
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, rect, anchor, dragging: edge, edge };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handleWavePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.dragging && Math.abs(event.clientX - drag.startX) < DRAG_THRESHOLD_PX) return;
    drag.dragging = true;
    setDraftLoop({ a: drag.anchor, b: timeAt(event.clientX, drag.rect) });
  };

  const handleWavePointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDraftLoop(null);
    const time = timeAt(event.clientX, drag.rect);
    if (!drag.dragging) {
      seekTo(time);
      return;
    }
    const region = normalizeLoop(drag.anchor, time, duration);
    if (!region) return;
    setMarkerA(region.start);
    setMarkerB(region.end);
    setLoopOn(true);
    // A freshly drawn loop starts from its top; nudging an edge keeps playing where it is.
    const position = playerRef.current?.position ?? 0;
    if (!drag.edge || position < region.start || position > region.end) seekTo(region.start);
  };

  const handleWavePointerCancel = () => {
    dragRef.current = null;
    setDraftLoop(null);
  };

  const waveHandlers = {
    onPointerDown: handleWavePointerDown,
    onPointerMove: handleWavePointerMove,
    onPointerUp: handleWavePointerUp,
    onPointerCancel: handleWavePointerCancel,
  };

  const handleSeekKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const position = playerRef.current?.position ?? 0;
    if (event.key === 'ArrowRight') seekTo(position + 5);
    else if (event.key === 'ArrowLeft') seekTo(position - 5);
    else if (event.key === 'Home') seekTo(loopOn && loop ? loop.start : 0);
    else if (event.key === '[' || event.key === ']') setMarker(event.key === '[' ? 'a' : 'b');
    else return;
    event.preventDefault();
  };

  const updateLane = (id: string, patch: Partial<LaneMix>) =>
    setMix((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], ...patch } } : prev));

  // Keyboard fallback for drawing a loop: [ and ] set its start and end at the playhead.
  const setMarker = (which: 'a' | 'b') => {
    const position = playerRef.current?.position ?? 0;
    const other = which === 'a' ? markerB : markerA;
    if (which === 'a') setMarkerA(position);
    else setMarkerB(position);
    if (other !== null && normalizeLoop(other, position, duration)) setLoopOn(true);
  };

  const clearLoop = () => {
    setMarkerA(null);
    setMarkerB(null);
    setLoopOn(false);
  };

  const handleFiles = async (fileList: FileList | null) => {
    const files = Array.from(fileList ?? []);
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (files.length === 0) return;
    const result = await importStems(files, (spread) =>
      showConfirmToast(
        `These stems differ in length by ${spread < 1 ? `${Math.round(spread * 1000)} ms` : `${spread.toFixed(1)} s`}, so they may not have been exported together and won't line up. Import anyway?`,
        { confirmLabel: 'Import' },
      ),
    );
    if (result.cancelled) return;
    if (result.imported > 0) toast.success(`Imported ${result.imported} stem${result.imported === 1 ? '' : 's'}`);
    if (result.failed.length > 0) toast.error(`Couldn't import: ${result.failed.join(', ')}`);
  };

  const handleDeleteStem = async (stem: SongStem) => {
    const confirmed = await showConfirmToast(`Remove the ${stemLabel(stem.name).toLowerCase()} stem?`, { confirmLabel: 'Remove' });
    if (confirmed) await deleteStem(stem);
  };

  const handleDeleteAll = async () => {
    const confirmed = await showConfirmToast('Remove all stems from this song?', { confirmLabel: 'Remove all' });
    if (confirmed) await deleteAllStems();
  };

  const busy = progress !== null;
  const progressLabel = progress
    ? progress.phase === 'reading'
      ? 'Reading files…'
      : `${progress.phase === 'preparing' ? 'Preparing' : 'Uploading'} ${Math.min(progress.done + 1, progress.total)} / ${progress.total}`
    : null;

  const importControls = canEdit && (
    <div className="stems-import">
      <input
        ref={fileInputRef}
        type="file"
        accept={STEM_IMPORT_ACCEPT}
        multiple
        className="stems-file-input"
        onChange={(e) => void handleFiles(e.target.files)}
        aria-label="Stem files"
      />
      <button type="button" className="stems-btn" onClick={() => fileInputRef.current?.click()} disabled={busy}>
        <Upload size={14} /> {busy ? progressLabel : 'Import stems…'}
      </button>
      {stems.length > 0 && !busy && (
        <button type="button" className="stems-btn stems-btn--quiet" onClick={() => void handleDeleteAll()}>
          <Trash2 size={14} /> Remove all
        </button>
      )}
    </div>
  );

  if (loading && stems.length === 0) {
    return <div className="song-stems"><p className="stems-hint">Loading stems…</p></div>;
  }

  if (stems.length === 0) {
    return (
      <div className="song-stems">
        <p className="stems-hint">
          No stems yet.{canEdit ? ' Import a stem ZIP (e.g. exported from StemDeck) or several audio files that line up.' : ''}
        </p>
        {error && <p className="stems-error" role="alert">{error}</p>}
        {importControls}
      </div>
    );
  }

  const shownLoop = draftLoop ? normalizeLoop(draftLoop.a, draftLoop.b, duration) : loop;
  const loopStyle = shownLoop && duration > 0
    ? { left: `${(shownLoop.start / duration) * 100}%`, width: `${((shownLoop.end - shownLoop.start) / duration) * 100}%` }
    : undefined;
  const loopActive = draftLoop !== null || loopOn;
  const loopRegion = loopStyle && (
    <div className={`stems-loop-region${loopActive ? ' stems-loop-region--on' : ''}`} style={loopStyle} />
  );
  // A lone [ / ] marker from the keyboard, waiting for its partner.
  const pendingMarker = loop ? null : markerA ?? markerB;

  return (
    <div className="song-stems" ref={rootRef}>
      <div className="stems-transport">
        <button
          type="button"
          className="stems-play"
          onClick={togglePlay}
          disabled={!ready}
          aria-label={playing ? 'Pause stems' : 'Play stems'}
        >
          {playing ? <Pause size={20} /> : <Play size={20} />}
        </button>
        <span className="stems-time">
          <span ref={timeRef}>0:00</span> / {formatTime(duration)}
        </span>
        <div
          className="stems-seek"
          role="slider"
          tabIndex={0}
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuetext="Playback position"
          aria-keyshortcuts="[ ]"
          title="Tap to seek, drag to loop"
          onKeyDown={handleSeekKey}
          {...waveHandlers}
        >
          <div className="stems-seek-track" />
          {loopRegion}
          {pendingMarker !== null && duration > 0 && (
            <div className="stems-seek-marker" style={{ left: `${(pendingMarker / duration) * 100}%` }} />
          )}
          <div className="stems-seek-fill" />
          <div className="stems-playhead" />
        </div>
      </div>

      {(buffering || loadProgress) && (
        <span className="stems-hint" role="status">
          {loadProgress ? `Loading stems ${loadProgress.loaded} / ${loadProgress.total}` : 'Buffering…'}
        </span>
      )}

      <div className="stems-tempo-controls">
        <div className="stems-stepper" role="group" aria-label="Speed">
          <button
            type="button"
            className="stems-btn"
            onClick={() => setSpeed((s) => Math.max(MIN_SPEED_PERCENT, s - SPEED_STEP))}
            disabled={speed <= MIN_SPEED_PERCENT}
            aria-label="Slower"
          >
            <Minus size={14} />
          </button>
          <button
            type="button"
            className={`stems-btn stems-stepper-value${speed !== 100 ? ' stems-btn--active' : ''}`}
            onClick={() => setSpeed(100)}
            title="Reset speed"
            aria-label={`Speed ${speed}%${speed !== 100 ? ', reset' : ''}`}
          >
            {speed}%
          </button>
          <button
            type="button"
            className="stems-btn"
            onClick={() => setSpeed((s) => Math.min(MAX_SPEED_PERCENT, s + SPEED_STEP))}
            disabled={speed >= MAX_SPEED_PERCENT}
            aria-label="Faster"
          >
            <Plus size={14} />
          </button>
        </div>
        <div className="stems-stepper" role="group" aria-label="Pitch">
          <button
            type="button"
            className="stems-btn"
            onClick={() => setTranspose((t) => Math.max(-MAX_TRANSPOSE, t - 1))}
            disabled={transpose <= -MAX_TRANSPOSE}
            aria-label="Pitch down a semitone"
          >
            <Minus size={14} />
          </button>
          <button
            type="button"
            className={`stems-btn stems-stepper-value${transpose !== 0 ? ' stems-btn--active' : ''}`}
            onClick={() => setTranspose(0)}
            title="Reset pitch"
            aria-label={`${pitchLabel(transpose, songKey)}${transpose !== 0 ? ', reset' : ''}`}
          >
            {pitchLabel(transpose, songKey)}
          </button>
          <button
            type="button"
            className="stems-btn"
            onClick={() => setTranspose((t) => Math.min(MAX_TRANSPOSE, t + 1))}
            disabled={transpose >= MAX_TRANSPOSE}
            aria-label="Pitch up a semitone"
          >
            <Plus size={14} />
          </button>
        </div>
        {chartTranspose !== 0 && chartTranspose !== transpose && Math.abs(chartTranspose) <= MAX_TRANSPOSE && (
          <button type="button" className="stems-btn stems-btn--quiet" onClick={() => setTranspose(chartTranspose)}>
            Match chords ({pitchLabel(chartTranspose, songKey)})
          </button>
        )}
        {loop ? (
          <div className="stems-loop-chip" role="group" aria-label="Loop">
            <button
              type="button"
              className={`stems-btn${loopOn ? ' stems-btn--active' : ''}`}
              onClick={() => setLoopOn((on) => !on)}
              aria-pressed={loopOn}
              aria-label={`Loop ${formatTime(loop.start)} to ${formatTime(loop.end)}`}
            >
              <Repeat size={14} /> {formatTime(loop.start)}–{formatTime(loop.end)}
            </button>
            <button type="button" className="stems-btn stems-btn--quiet" onClick={clearLoop} aria-label="Clear loop">
              <X size={14} />
            </button>
          </div>
        ) : (
          ready && <span className="stems-hint stems-loop-hint">Drag across a waveform to loop</span>
        )}
      </div>

      <ul className="stems-lanes">
        {stems.map((stem) => {
          const lane = mix[stem.id] ?? defaultMix(stem);
          const failed = failedIds.includes(stem.id);
          const audible = anySolo ? lane.solo : !lane.muted;
          return (
            <li
              key={stem.id}
              className={`stems-lane${audible ? '' : ' stems-lane--silent'}`}
              style={{ '--stem-color': stemColor(stem.name) } as CSSProperties}
            >
              <div className="stems-lane-head">
                <span className="stems-lane-dot" aria-hidden="true" />
                <span className="stems-lane-name" title={stem.name}>{stemLabel(stem.name)}</span>
                <button
                  type="button"
                  className={`stems-toggle${lane.muted ? ' stems-toggle--mute' : ''}`}
                  onClick={() => updateLane(stem.id, { muted: !lane.muted })}
                  aria-pressed={lane.muted}
                  aria-label={`Mute ${stemLabel(stem.name)}`}
                >
                  M
                </button>
                <button
                  type="button"
                  className={`stems-toggle${lane.solo ? ' stems-toggle--solo' : ''}`}
                  onClick={() => updateLane(stem.id, { solo: !lane.solo })}
                  aria-pressed={lane.solo}
                  aria-label={`Solo ${stemLabel(stem.name)}`}
                >
                  S
                </button>
                <input
                  type="range"
                  className="stems-volume"
                  min={0}
                  max={1.5}
                  step={0.01}
                  value={lane.volume}
                  onChange={(e) => updateLane(stem.id, { volume: Number(e.target.value) })}
                  aria-label={`${stemLabel(stem.name)} volume`}
                />
                {canEdit && (
                  <button
                    type="button"
                    className="stems-toggle stems-toggle--quiet"
                    onClick={() => void handleDeleteStem(stem)}
                    aria-label={`Remove ${stemLabel(stem.name)} stem`}
                    disabled={busy}
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
              {failed ? (
                <p className="stems-error">Couldn't load this stem ({stem.mimeType}). Try importing it again as MP3 or WAV.</p>
              ) : (
                <div className="stems-waveform" aria-hidden="true" {...waveHandlers}>
                  {stem.waveformBars?.length ? <WaveformPath bars={stem.waveformBars} /> : <div className="stems-waveform-empty" />}
                  {loopRegion}
                  <div className="stems-playhead" />
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {error && <p className="stems-error" role="alert">{error}</p>}
      {importControls}
    </div>
  );
}
