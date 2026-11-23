import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { Pause, Play, Repeat, Trash2, Upload, X } from 'lucide-react';
import type { SongStem } from '../lib/songStems';
import type { SongStemsState } from '../hooks/useSongStems';
import { FULL_MIX_STEMS, STEM_IMPORT_ACCEPT, stemColor } from '../lib/stemImport';
import { normalizeLoop, StemPlayer, type LaneMix } from '../lib/stemPlayer';
import { showConfirmToast } from '../utils/toastDialogs';
import toast from '../utils/anchoredToast';

interface Props {
  stemsState: SongStemsState;
  canEdit: boolean;
}

function formatTime(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`;
}

function stemLabel(name: string): string {
  const label = name.replace(/[_-]+/g, ' ');
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function defaultMix(stem: SongStem): LaneMix {
  return { id: stem.id, volume: 1, muted: FULL_MIX_STEMS.has(stem.name), solo: false };
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

export default function SongStems({ stemsState, canEdit }: Props) {
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
  const [mix, setMix] = useState<Record<string, LaneMix>>({});
  const [markerA, setMarkerA] = useState<number | null>(null);
  const [markerB, setMarkerB] = useState<number | null>(null);
  const [loopOn, setLoopOn] = useState(false);
  const durationRef = useRef(0);

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

  // Keep mixer state for stems that are still there; new stems get the defaults.
  useEffect(() => {
    setMix((prev) => {
      const next: Record<string, LaneMix> = {};
      for (const stem of stems) next[stem.id] = prev[stem.id] ?? defaultMix(stem);
      return next;
    });
  }, [stems]);

  useEffect(() => {
    playerRef.current?.setMix(Object.values(mix));
  }, [mix, duration]);

  const loop = markerA !== null && markerB !== null ? normalizeLoop(markerA, markerB, duration) : null;
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

  const seekFromPointer = (event: ReactPointerEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || duration <= 0) return;
    const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    seekTo(fraction * duration);
  };

  const handleSeekKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const position = playerRef.current?.position ?? 0;
    if (event.key === 'ArrowRight') seekTo(position + 5);
    else if (event.key === 'ArrowLeft') seekTo(position - 5);
    else if (event.key === 'Home') seekTo(loopOn && loop ? loop.start : 0);
    else return;
    event.preventDefault();
  };

  const updateLane = (id: string, patch: Partial<LaneMix>) =>
    setMix((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], ...patch } } : prev));

  const setMarker = (which: 'a' | 'b') => {
    const position = playerRef.current?.position ?? 0;
    if (which === 'a') setMarkerA(position);
    else {
      setMarkerB(position);
      if (markerA !== null && normalizeLoop(markerA, position, duration)) setLoopOn(true);
    }
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

  const loopStyle = loop && duration > 0
    ? { left: `${(loop.start / duration) * 100}%`, width: `${((loop.end - loop.start) / duration) * 100}%` }
    : undefined;
  const markerStyle = (t: number | null) => (t !== null && duration > 0 ? { left: `${(t / duration) * 100}%` } : undefined);

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
        {buffering && !loadProgress && (
          <span className="stems-hint" role="status">Buffering…</span>
        )}
        {loadProgress && (
          <span className="stems-hint" role="status">
            Loading stems {loadProgress.loaded} / {loadProgress.total}
          </span>
        )}
      </div>

      <div
        className="stems-seek"
        role="slider"
        tabIndex={0}
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuetext="Playback position"
        onPointerDown={(e) => ready && seekFromPointer(e)}
        onKeyDown={handleSeekKey}
      >
        <div className="stems-seek-track" />
        {loopStyle && <div className={`stems-seek-loop${loopOn ? ' stems-seek-loop--on' : ''}`} style={loopStyle} />}
        {markerA !== null && <div className="stems-seek-marker" style={markerStyle(markerA)}>A</div>}
        {markerB !== null && <div className="stems-seek-marker" style={markerStyle(markerB)}>B</div>}
        <div className="stems-seek-fill" />
        <div className="stems-playhead" />
      </div>

      <div className="stems-loop-controls">
        <button type="button" className="stems-btn" onClick={() => setMarker('a')} disabled={!ready}>Set A</button>
        <button type="button" className="stems-btn" onClick={() => setMarker('b')} disabled={!ready}>Set B</button>
        <button
          type="button"
          className={`stems-btn${loopOn && loop ? ' stems-btn--active' : ''}`}
          onClick={() => setLoopOn((on) => !on)}
          disabled={!loop}
          aria-pressed={loopOn && Boolean(loop)}
        >
          <Repeat size={14} /> Loop
        </button>
        {(markerA !== null || markerB !== null) && (
          <button type="button" className="stems-btn stems-btn--quiet" onClick={clearLoop} aria-label="Clear loop">
            <X size={14} />
          </button>
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
                <div
                  className="stems-waveform"
                  onPointerDown={(e) => ready && seekFromPointer(e)}
                  aria-hidden="true"
                >
                  {stem.waveformBars?.length ? <WaveformPath bars={stem.waveformBars} /> : <div className="stems-waveform-empty" />}
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
