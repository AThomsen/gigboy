import { useEffect, useLayoutEffect, useState, useCallback, useRef, useMemo } from 'react';
import { flushSync } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  ChevronLeft,
  ChevronRight,
  List,
  Minus,
  Pause,
  Play,
  Plus,
  Settings,
  SkipBack,
  SkipForward,
  SquarePen,
  Square,
  Volume2,
  VolumeX,
  X,
  Zap,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useBands } from '../context/BandsContext';
import type { LyricNoteDocument, Song } from '../types';
import ChordDisplay from './ChordDisplay';
import ChordDiagram, { type DiagramInstrument } from './ChordDiagram';
import { useBandChordVoicings } from '../hooks/useBandChordVoicings';
import type { useSetlistSession } from '../hooks/useSetlistSession';
import { useServerClockOffset } from '../hooks/useServerClockOffset';
import LyricHandNotesOverlay from './LyricHandNotesOverlay';
import SongTextNotesOverlay from './SongTextNotesOverlay';
import ConcertMetronomeFlash from './ConcertMetronomeFlash';
import ConcertAutoscrollButton from './ConcertAutoscrollButton';
import { createResumedAudioContext, resumeAudioContext, setAudioSessionType } from '../lib/webAudio';
import { useSongHandNotes } from '../hooks/useSongHandNotes';
import { loadSongHandNotes } from '../lib/songHandNotes';
import { downbeatColorCss } from '../lib/userPreferences';
import { transposeChord, type ChordNotation } from '../utils/chordParser';
import { getUserNoteColor } from '../lib/userColors';
import { extractPinnedLineIds } from '../lib/lineAnchor';
import { clampScrollSeconds } from '../lib/songScroll';
import { parsePause, pauseSeconds } from '../utils/scrollPause';
import { formatDuration } from '../utils/duration';

const noop = () => {};
// Space between a song and the next/previous one peeking in while swiping (see .concert-swipe-peek).
const PEEK_GAP = 24;

interface ActiveChord {
  chord: string;
  rect: DOMRect;
}

function computePageOffsets(contentEl: HTMLElement, viewportHeight: number): number[] {
  const contentRect = contentEl.getBoundingClientRect();
  const contentTop = contentRect.top;

  const offsets: number[] = [0];
  let pageStartY = 0;

  const relTop = (el: Element) => el.getBoundingClientRect().top - contentTop;
  const relBottom = (el: Element) => el.getBoundingClientRect().bottom - contentTop;

  const processAtom = (el: Element) => {
    const elTop = relTop(el);
    const elBottom = relBottom(el);
    if (elBottom - pageStartY > viewportHeight && elTop > pageStartY) {
      pageStartY = elTop;
      offsets.push(pageStartY);
    }
  };

  const processSection = (section: HTMLElement) => {
    const secTop = relTop(section);
    const secBottom = relBottom(section);
    const secHeight = secBottom - secTop;

    if (secBottom - pageStartY <= viewportHeight) return; // whole section fits

    if (secHeight <= viewportHeight && secTop > pageStartY) {
      // Keep the whole section together on a new page
      pageStartY = secTop;
      offsets.push(pageStartY);
      return;
    }

    // Section is taller than one page — split line by line
    for (const child of Array.from(section.children)) {
      processAtom(child);
    }
  };

  const chordDisplay = contentEl.querySelector('.chord-display');
  if (!chordDisplay) return offsets;

  for (const child of Array.from(chordDisplay.children) as HTMLElement[]) {
    if (child.classList.contains('chord-section')) {
      processSection(child);
    } else {
      processAtom(child);
    }
  }

  return offsets;
}

// Page breaks depend on each screen's size and text size, so a shared session names a page
// by the chart line at its top (data-line-id, the same on every screen showing the song).

/** Tops of the chart's lines, relative to the content's own top, in chart order. */
function chartLineTops(contentEl: HTMLElement): { id: number; top: number }[] {
  const contentTop = contentEl.getBoundingClientRect().top;
  const lines: { id: number; top: number }[] = [];
  contentEl.querySelectorAll<HTMLElement>('.chord-display [data-line-id]').forEach((el) => {
    const id = Number(el.dataset.lineId);
    if (Number.isFinite(id)) lines.push({ id, top: el.getBoundingClientRect().top - contentTop });
  });
  return lines;
}

/** The first and last chart lines on the page from `pageTop` to `nextPageTop` (none: the last page). */
function pageLineRange(
  contentEl: HTMLElement,
  pageTop: number,
  nextPageTop: number | undefined,
): { first: number; last: number } | null {
  const onPage = chartLineTops(contentEl).filter((line) =>
    line.top >= pageTop - 1 && (nextPageTop === undefined || line.top < nextPageTop - 1));
  return onPage.length ? { first: onPage[0].id, last: onPage[onPage.length - 1].id } : null;
}

/**
 * The page (of `offsets`) showing line `lineId`. A line this screen doesn't show (lyrics or
 * chords only) is stood in for by the next one it does.
 */
function pageOfLineId(contentEl: HTMLElement, offsets: number[], lineId: number): number | null {
  const lines = chartLineTops(contentEl);
  if (lines.length === 0) return null;
  const line = lines.find((l) => l.id === lineId)
    ?? lines.find((l) => l.id > lineId)
    ?? lines[lines.length - 1];
  let page = 0;
  offsets.forEach((offset, i) => {
    if (offset <= line.top + 1) page = i;
  });
  return page;
}

/**
 * What autoscroll needs to know about the chart's layout, measured with the pagination.
 *
 * Musicians read ahead: what's coming matters more than what was played. So autoscroll keeps the
 * line being played (the "play line") a third of the way down the screen, leaving two thirds of
 * look-ahead. It tracks a play position moving down the chart at the music's pace, from the top
 * to the chart's end over the song's scroll time (less its pauses). The scroll follows it at
 * scrollTop = play position − a third of the screen, so:
 * - at the start it holds still (a "lead-in") until the play position reaches the play line;
 *   scrolling sooner would push lines off the top before they're played;
 * - it stops early, once the chart's end reaches the bottom of the screen, and the rest is read
 *   without scrolling. The next-song cue after the chart just scrolls on at the same speed.
 */
interface ScrollGeometry {
  /** Height (px) of the chart, from the top of the scroll to the end of the notes stage. */
  chartHeight: number;
  /** Scroll distance (px) from the top until the chart's end reaches the bottom of the screen. */
  distance: number;
  /** How far the play line sits below the top of the screen (px): the lead-in at the start. */
  leadIn: number;
  /** Each {hold} marker: the raw directive value, the scroll position (play position − lead-in,
   * negative during the lead-in) at which it fires, and whether autoscroll ever gets there: a
   * marker in the last screenful is reached after scrolling has stopped. */
  pauses: { value: string; trigger: number; fires: boolean }[];
}

const EMPTY_GEOMETRY: ScrollGeometry = { chartHeight: 0, distance: 0, leadIn: 0, pauses: [] };

// The play line: this far down the screen.
const PLAY_LINE = 1 / 3;

function measureScrollGeometry(viewport: HTMLElement, content: HTMLElement): ScrollGeometry {
  const viewportRect = viewport.getBoundingClientRect();
  const contentRect = content.getBoundingClientRect();
  const contentTop = contentRect.top - viewportRect.top + viewport.scrollTop;
  const stage = content.querySelector('.song-notes-stage') ?? content;
  const chartHeight = stage.getBoundingClientRect().bottom - contentRect.top + contentTop;
  const distance = Math.max(0, chartHeight - viewport.clientHeight);
  const leadIn = viewport.clientHeight * PLAY_LINE;
  const pauses = Array.from(content.querySelectorAll<HTMLElement>('[data-scroll-pause]')).map((el) => {
    const y = el.getBoundingClientRect().top - contentRect.top + contentTop;
    const trigger = y - leadIn;
    return { value: el.dataset.scrollPause ?? '', trigger, fires: trigger <= distance };
  });
  return { chartHeight, distance, leadIn, pauses };
}

function sameGeometry(a: ScrollGeometry, b: ScrollGeometry): boolean {
  return Math.abs(a.distance - b.distance) < 0.5
    && Math.abs(a.chartHeight - b.chartHeight) < 0.5
    && Math.abs(a.leadIn - b.leadIn) < 0.5
    && a.pauses.length === b.pauses.length
    && a.pauses.every((p, i) => p.value === b.pauses[i].value && p.fires === b.pauses[i].fires
      && Math.abs(p.trigger - b.pauses[i].trigger) < 0.5);
}

const FONT_SCALE_KEY = 'gigboy.concert.fontScale';
const CHORD_SCALE_KEY = 'gigboy.concert.chordScale';
const CHART_CONTENT_KEY = 'gigboy.concert.chartContent';
const PAGINATION_KEY = 'gigboy.concert.pagination';
const PULSE_KEY = 'gigboy.concert.pulse';
const AUTOSCROLL_KEY = 'gigboy.concert.autoscroll';
// The px/s speed from before speeds were saved per song: still the starting speed for a song
// with neither a scroll time nor a play length. No longer written.
const SCROLL_SPEED_KEY = 'gigboy.concert.scrollSpeed';
const QUICK_MENU_INTRO_KEY = 'gigboy.concert.quickMenuIntroSeen';
const SCROLL_SPEED_MIN = 5;
const SCROLL_SPEED_MAX = 120;
const SCROLL_SPEED_DEFAULT = 25;
const FONT_SCALE_MIN = 0.7;
const FONT_SCALE_MAX = 1.6;
const FONT_SCALE_STEP = 0.1;
// Chord size relative to the lyrics (on top of the text size).
const CHORD_SCALE_MIN = 0.6;
const CHORD_SCALE_MAX = 2;
const CHORD_SCALE_STEP = 0.1;

/** What the chart shows: a lead singer may want just the lyrics, a guitarist just the chords. */
type ChartContent = 'both' | 'lyrics' | 'chords';
const CHART_CONTENT_OPTIONS: { value: ChartContent; label: string; title: string }[] = [
  { value: 'both', label: 'Both', title: 'Lyrics with the chords above them' },
  { value: 'lyrics', label: 'Lyrics', title: 'Just the lyrics, without chords, tabs or strumming' },
  { value: 'chords', label: 'Chords', title: 'Just the chords of each line, without lyrics' },
];

function readStoredChartContent(): ChartContent {
  try {
    const raw = localStorage.getItem(CHART_CONTENT_KEY);
    if (raw === 'both' || raw === 'lyrics' || raw === 'chords') return raw;
  } catch { /* storage unavailable */ }
  return 'both';
}

function readStoredChordScale(): number {
  try {
    const raw = localStorage.getItem(CHORD_SCALE_KEY);
    const value = Number(raw);
    if (raw !== null && Number.isFinite(value) && value >= CHORD_SCALE_MIN && value <= CHORD_SCALE_MAX) return value;
  } catch { /* storage unavailable */ }
  return 1;
}

function readStoredFlag(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === '1') return true;
    if (raw === '0') return false;
  } catch { /* storage unavailable */ }
  return fallback;
}

function storeValue(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}

function readStoredScrollSpeed(): number {
  try {
    const raw = Number(localStorage.getItem(SCROLL_SPEED_KEY));
    if (Number.isFinite(raw) && raw >= SCROLL_SPEED_MIN && raw <= SCROLL_SPEED_MAX) return raw;
  } catch { /* storage unavailable */ }
  return SCROLL_SPEED_DEFAULT;
}

function readStoredFontScale(): number {
  try {
    const raw = Number(localStorage.getItem(FONT_SCALE_KEY));
    if (Number.isFinite(raw) && raw >= FONT_SCALE_MIN && raw <= FONT_SCALE_MAX) return raw;
  } catch { /* storage unavailable */ }
  return 1;
}

interface Props {
  songs: Song[];
  /** Accessible label for the concert view. Pass setlist name for setlist mode, or empty string to omit. */
  title: string;
  backRoute: string;
  /** Router state to pass along when leaving concert mode via backRoute. */
  backState?: unknown;
  /** Per-song notes keyed by song ID (from setlist) */
  songNotes?: Record<string, string>;
  bandId?: string;
  canUseMetronome: boolean;
  /** Current user's personal transpose overrides, keyed by song id. Used when solo or
   * leading; ignored while following, where the leader's transpose applies to everyone. */
  transposeBySongId?: Record<string, number>;
  /** Shared "now playing" session (setlist mode only). When leading, local navigation is
   * broadcast; when following, position is driven by the leader. */
  session?: ReturnType<typeof useSetlistSession>;
}

export default function ConcertModeView({
  songs,
  title,
  backRoute,
  backState,
  songNotes,
  bandId,
  canUseMetronome,
  transposeBySongId,
  session,
}: Props) {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const { bands, saveBandSongScrollSeconds } = useBands();
  const band = bandId ? (bands ?? []).find((b) => b.id === bandId) ?? null : null;
  const canEditSongs = Boolean(bandId) && (!user || !band || band.memberRoles?.[user.id] !== 'viewer');

  // Coming back from "Edit song" reopens the song that was being edited.
  const [currentIndex, setCurrentIndex] = useState(() => {
    const songId = (location.state as { concertSongId?: string } | null)?.concertSongId;
    const index = songId ? songs.findIndex((s) => s.id === songId) : -1;
    return index >= 0 ? index : 0;
  });
  const [currentPageInSong, setCurrentPageInSong] = useState(0);
  const [pageOffsets, setPageOffsets] = useState<number[]>([0]);
  const currentPageCount = pageOffsets.length;
  // For effects that run on the leader's updates, not on this screen's layout.
  const currentIndexRef = useRef(currentIndex);
  currentIndexRef.current = currentIndex;
  const pageOffsetsRef = useRef(pageOffsets);
  pageOffsetsRef.current = pageOffsets;
  const [transpose, setTranspose] = useState(0);
  const [chartContent, setChartContent] = useState(readStoredChartContent);
  const showChords = chartContent !== 'lyrics';
  const showLyrics = chartContent !== 'chords';
  const chordInstrument: DiagramInstrument = 'guitar';
  const chordNotation: ChordNotation = 'anglo';
  const [activeChord, setActiveChord] = useState<ActiveChord | null>(null);
  // Pagination (discrete pages) vs. continuous scrolling. Autoscroll needs continuous
  // scrolling, so the two toggles are mutually exclusive.
  const [pagination, setPagination] = useState(() => readStoredFlag(PAGINATION_KEY, true));
  const [autoscroll, setAutoscroll] = useState(() => readStoredFlag(AUTOSCROLL_KEY, false));
  const [legacyScrollSpeed] = useState(readStoredScrollSpeed);
  const [scrollGeometry, setScrollGeometry] = useState<ScrollGeometry>(EMPTY_GEOMETRY);
  // A speed change in concert mode applies at once, but stays unsaved until "Save" in the bar
  // at the bottom. Moving to another song drops it.
  const [scrollAdjust, setScrollAdjust] = useState<{ songId: string; seconds: number } | null>(null);
  const [scrollSaveState, setScrollSaveState] = useState<{ saving: boolean; error: string | null }>({ saving: false, error: null });
  // Set further down from the song's scroll time; read by the autoscroll loop, so a speed
  // change applies at once without restarting it.
  const scrollSpeedRef = useRef(legacyScrollSpeed);
  // The scroll pause autoscroll is holding at, if any: which marker, and when it ends
  // (performance.now() time; null waits for a tap).
  const [activePause, setActivePause] = useState<{ index: number; endsAt: number | null } | null>(null);
  // Whole seconds until the lead-in at the top of the song ends and the chart starts moving, shown
  // on the autoscroll button (the chart standing still while "playing" would look broken); null
  // otherwise.
  const [leadInSeconds, setLeadInSeconds] = useState<number | null>(null);
  const activePauseRef = useRef(activePause);
  const scrollPausesRef = useRef<{ trigger: number; seconds: number | null; fires: boolean }[]>([]);
  const scrollLeadInRef = useRef(0);
  // Where the lead-in had got to (a negative scroll position) when autoscroll was paused at the
  // top of the song, to carry on from there; null starts it afresh. Reset for each song.
  const leadInPosRef = useRef<number | null>(null);
  // One finger moving on the chart: autoscroll holds still while the user scrolls by hand.
  // A finger merely resting there (steadying the tablet) doesn't count.
  const touchingRef = useRef(false);
  const [pulse, setPulse] = useState(() => readStoredFlag(PULSE_KEY, true));
  const [scrolling, setScrolling] = useState(false);
  const [scrollEdge, setScrollEdge] = useState({ top: true, bottom: false });
  const continuous = !pagination;
  const [showSettings, setShowSettings] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);
  const [showSongNavigator, setShowSongNavigator] = useState(false);
  const songNavigatorRef = useRef<HTMLElement>(null);
  const [fontScale, setFontScale] = useState(readStoredFontScale);
  const [chordScale, setChordScale] = useState(readStoredChordScale);
  const chordVoicings = useBandChordVoicings(bandId, false);

  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // While swiping, the chart and the title slide in lanes of their own; the header's buttons stay put.
  const chartLaneRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLElement>(null);
  const titleLaneRef = useRef<HTMLDivElement>(null);
  const targetPageRef = useRef(0);
  // Following: the leader's page, as the line at its top, until this screen turns a page of
  // its own. Kept so a re-measure here (the font loading, a resize) stays on that line.
  const followAnchorRef = useRef<{
    songIndex: number;
    lineId: number;
    lastLineId: number | null;
    page: number | null;
  } | null>(null);
  // Following a leader whose page holds more than this screen's: the last of this screen's
  // pages that the leader's page reaches, so a cue can say the next turn is this screen's own.
  const [leaderPageEnd, setLeaderPageEnd] = useState<{ songIndex: number; page: number } | null>(null);
  // Turns to this screen's page holding the leader's top line (and notes where the leader's
  // page ends here). False when the chart has no lines to go by.
  const resolveFollowAnchor = useCallback((content: HTMLElement, offsets: number[]): boolean => {
    const anchor = followAnchorRef.current;
    if (!anchor) return false;
    const page = pageOfLineId(content, offsets, anchor.lineId);
    if (page === null) return false;
    anchor.page = page;
    setCurrentPageInSong(page);
    const endPage = anchor.lastLineId === null ? null : pageOfLineId(content, offsets, anchor.lastLineId);
    setLeaderPageEnd(endPage !== null && endPage > page ? { songIndex: anchor.songIndex, page: endPage } : null);
    return true;
  }, []);
  const currentPageRef = useRef(currentPageInSong);
  currentPageRef.current = currentPageInSong;

  const isMultiSong = songs.length > 1;
  const activeSong = songs[currentIndex] ?? null;

  // Autoscroll speed. A song stores how long it takes to play through the chart (pauses
  // included); the play position moves down the chart at chart height ÷ (that time − pauses),
  // in this screen's px, so it's right at any width and text size (see ScrollGeometry). Every
  // timed pause is part of the song's time, also one in the last screenful that never holds
  // the (by then finished) scroll.
  const scrollPauseSeconds = useMemo(
    () => scrollGeometry.pauses.map((p) => pauseSeconds(parsePause(p.value), activeSong?.tempo, activeSong?.timeSignature)),
    [scrollGeometry.pauses, activeSong?.tempo, activeSong?.timeSignature],
  );
  scrollPausesRef.current = scrollGeometry.pauses.map((p, i) => ({ trigger: p.trigger, seconds: scrollPauseSeconds[i], fires: p.fires }));
  scrollLeadInRef.current = scrollGeometry.leadIn;
  const scrollPauseTotal = scrollPauseSeconds.reduce<number>((sum, s) => sum + (s ?? 0), 0);
  // The px the play position covers over the song; 0 when the chart fits without scrolling.
  const scrollDistance = scrollGeometry.distance > 0 ? scrollGeometry.chartHeight : 0;
  const storedScrollSeconds = activeSong?.scrollSeconds ?? activeSong?.durationSeconds ?? null;
  const adjustedScrollSeconds = scrollAdjust && scrollAdjust.songId === activeSong?.id ? scrollAdjust.seconds : null;
  const scrollSeconds = adjustedScrollSeconds ?? storedScrollSeconds;
  const scrollPxPerSecond = scrollSeconds !== null && scrollDistance > 0
    ? Math.min(SCROLL_SPEED_MAX * 2, scrollDistance / Math.max(1, scrollSeconds - scrollPauseTotal))
    : legacyScrollSpeed;
  scrollSpeedRef.current = scrollPxPerSecond;
  const pxToScrollSeconds = (px: number) => scrollDistance / px + scrollPauseTotal;
  // Shown while adjusting: the whole song's scroll time.
  const shownScrollSeconds = scrollDistance > 0 ? (scrollSeconds ?? pxToScrollSeconds(legacyScrollSpeed)) : null;
  const scrollAdjustUnsaved = adjustedScrollSeconds !== null && Math.round(adjustedScrollSeconds) !== storedScrollSeconds;

  const changeScrollSpeed = (px: number, done: boolean) => {
    if (!activeSong || scrollDistance <= 0) return;
    const seconds = pxToScrollSeconds(px);
    setScrollAdjust({ songId: activeSong.id, seconds: done ? clampScrollSeconds(seconds) : seconds });
    setScrollSaveState({ saving: false, error: null });
  };

  const canSaveScrollSpeed = canEditSongs && Boolean(bandId);
  const saveScrollSpeed = async () => {
    if (!bandId || !scrollAdjust || scrollSaveState.saving) return;
    const { songId, seconds } = scrollAdjust;
    setScrollSaveState({ saving: true, error: null });
    const error = await saveBandSongScrollSeconds(bandId, songId, seconds);
    setScrollSaveState({ saving: false, error });
    if (!error) setScrollAdjust((current) => (current?.songId === songId ? null : current));
  };

  const handNotes = useSongHandNotes({
    bandId: bandId ?? null,
    songId: activeSong?.id ?? '',
    user,
    enabled: Boolean(user && activeSong?.id),
    defaultToCurrentUser: true,
  });

  useEffect(() => {
    setCurrentIndex((current) => {
      if (songs.length === 0) return 0;
      return Math.min(Math.max(current, 0), songs.length - 1);
    });
  }, [songs.length]);

  // Keep the screen awake for the duration of the show. The lock is released
  // automatically by the browser when the tab is hidden, so re-acquire it on
  // return (e.g. switching apps to check a text, then coming back mid-set).
  useEffect(() => {
    if (!('wakeLock' in navigator)) return;

    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;

    const acquire = async () => {
      if (sentinel) return;
      try {
        const lock = await navigator.wakeLock.request('screen');
        if (cancelled) {
          void lock.release();
          return;
        }
        sentinel = lock;
        // The browser auto-releases on tab-hide without firing our code; this keeps the
        // ref honest so onVisibilityChange knows it needs to re-acquire.
        lock.addEventListener('release', () => {
          if (sentinel === lock) sentinel = null;
        });
      } catch {
        // Wake lock can be denied (e.g. low battery, unsupported context) — ignore.
      }
    };

    void acquire();

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void acquire();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      void sentinel?.release();
    };
  }, []);

  // Layout effect (not a regular effect): must resolve the target page for the new
  // song *before* the pagination-measuring layout effect below runs, since that effect
  // clamps the current page against the new song's page count. Layout effects for a
  // given commit always run before regular effects, so if this were a plain useEffect
  // it would still be reading the *previous* song's page index when that clamp ran.
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (viewport && continuous) {
      // Continuous mode has no pages: land at the top, or the bottom when stepping back.
      viewport.scrollTop = targetPageRef.current === Number.POSITIVE_INFINITY ? viewport.scrollHeight : 0;
    }
    setCurrentPageInSong(targetPageRef.current);
    targetPageRef.current = 0;
    setScrolling(false);
    setActiveChord(null);
    // An unsaved speed change belongs to the song it was made on.
    setScrollAdjust(null);
    leadInPosRef.current = null;
    setScrollSaveState({ saving: false, error: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIndex]);

  const sessionMode = session?.mode ?? 'solo';
  const sessionState = session?.state ?? null;
  // Leading or following: the metronome keeps the band's beat, on the server's clock.
  const sharedClock = useServerClockOffset(sessionMode !== 'solo');

  // Seed the transpose from this member's own saved value for the song. Skipped while
  // following — there the leader's transpose is applied to everyone (see the effect below),
  // and it's restored from personal prefs once the session ends and the mode flips back.
  useEffect(() => {
    if (sessionMode === 'follow') return;
    const personal = activeSong ? transposeBySongId?.[activeSong.id] : undefined;
    setTranspose(personal ?? activeSong?.preferredTranspose ?? 0);
  }, [activeSong?.id, activeSong?.preferredTranspose, activeSong, transposeBySongId, sessionMode]);

  // Follow mode: the leader's position — and transpose — drive this screen.
  useEffect(() => {
    if (sessionMode !== 'follow' || !sessionState) return;
    const songIndex = Math.min(Math.max(sessionState.songIndex, 0), Math.max(0, songs.length - 1));
    // The leader's page number is only a fallback: this screen may break the song elsewhere.
    targetPageRef.current = sessionState.pageIndex;
    followAnchorRef.current = sessionState.lineId == null
      ? null
      : { songIndex, lineId: sessionState.lineId, lastLineId: sessionState.lastLineId ?? null, page: null };
    setLeaderPageEnd(null);
    setCurrentIndex(songIndex);
    setCurrentPageInSong(sessionState.pageIndex);
    setTranspose(sessionState.transpose);
    // Same song: its pages are already measured, so turn to the line's page now. A new song
    // is resolved once it's measured (see the pagination layout effect).
    const content = contentRef.current;
    if (content && songIndex === currentIndexRef.current) resolveFollowAnchor(content, pageOffsetsRef.current);
  }, [sessionMode, sessionState, songs.length, resolveFollowAnchor]);

  useEffect(() => {
    if (sessionMode !== 'follow') {
      followAnchorRef.current = null;
      setLeaderPageEnd(null);
    }
  }, [sessionMode]);

  // Lead mode: broadcast local navigation to followers, the page as the line at its top.
  const sessionPush = session?.push;
  const lastPushRef = useRef('');
  useEffect(() => {
    if (sessionMode !== 'lead' || !sessionPush) {
      lastPushRef.current = '';
      return;
    }
    const content = contentRef.current;
    const pageTop = pageOffsets[currentPageInSong];
    const lines = !continuous && content && pageTop !== undefined
      ? pageLineRange(content, pageTop, pageOffsets[currentPageInSong + 1])
      : null;
    const patch = {
      songIndex: currentIndex,
      pageIndex: currentPageInSong,
      lineId: lines?.first ?? null,
      lastLineId: lines?.last ?? null,
      transpose,
    };
    // Re-measuring (which this also follows, as it can move the page's top line) mostly
    // changes nothing worth sending.
    const key = JSON.stringify(patch);
    if (key === lastPushRef.current) return;
    lastPushRef.current = key;
    sessionPush(patch);
  }, [sessionMode, sessionPush, currentIndex, currentPageInSong, transpose, pageOffsets, continuous]);

  useLayoutEffect(() => {
    const measure = () => {
      const viewport = viewportRef.current;
      const content = contentRef.current;
      if (!viewport || !content) return;
      const vh = viewport.clientHeight;
      if (vh <= 0) return;
      // Temporarily zero transform and clip-path so measurements reflect natural positions
      const prevTransition = content.style.transition;
      const prevTransform = content.style.transform;
      const prevClipPath = content.style.clipPath;
      content.style.transition = 'none';
      content.style.transform = 'translateY(0px)';
      content.style.clipPath = '';

      const offsets = computePageOffsets(content, vh);
      const geometry = measureScrollGeometry(viewport, content);
      setScrollGeometry((prev) => (sameGeometry(prev, geometry) ? prev : geometry));

      content.style.transition = prevTransition;
      content.style.transform = prevTransform;
      content.style.clipPath = prevClipPath;

      setPageOffsets(offsets);
      updateScrollEdge();
      // Following: land on this screen's page holding the leader's line, unless a page has
      // been turned here since.
      const anchor = followAnchorRef.current;
      const resolved = anchor !== null && anchor.songIndex === currentIndexRef.current
        && (anchor.page === null || anchor.page === currentPageRef.current)
        && resolveFollowAnchor(content, offsets);
      if (!resolved) setCurrentPageInSong((p) => Math.min(p, offsets.length - 1));
    };

    const observer = new ResizeObserver(measure);
    if (viewportRef.current) observer.observe(viewportRef.current);
    if (contentRef.current) observer.observe(contentRef.current);
    measure();

    // JetBrains Mono (the chord-display font) loads asynchronously via a Google Fonts
    // @import with font-display: swap, so the measurement above can briefly run against
    // fallback-font metrics. Re-measure once the real font is confirmed loaded so page
    // breaks reflect the font actually being displayed (the ResizeObserver above also
    // catches the resulting reflow, but this avoids a visible re-wrap on slow networks).
    let cancelled = false;
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      document.fonts.ready.then(() => {
        if (!cancelled) measure();
      });
    }

    return () => {
      cancelled = true;
      observer.disconnect();
    };
    // Anything that changes what the chart shows or how big it is re-measures here, in the
    // same commit, rather than waiting for the ResizeObserver: the first render after such a
    // change clips against the old page breaks, which can hide the whole page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIndex, transpose, continuous, chartContent, fontScale, chordScale]);

  // Leaving continuous mode: the viewport goes back to overflow:hidden, but would keep
  // its old scrollTop and show the song offset by that amount underneath the page transform.
  useLayoutEffect(() => {
    if (!continuous && viewportRef.current) viewportRef.current.scrollTop = 0;
  }, [continuous]);

  // Where the content sits to show a page: shifted up to the page's top and clipped below
  // its bottom, so the next page's first lines don't peek in.
  const pageStyle = useCallback((page: number) => {
    const offsetY = pageOffsets[page] ?? 0;
    const nextOffsetY = pageOffsets[page + 1];
    // Clip below the next page's top, measured against the content's own height (100%) by
    // the browser. Reading that height here instead (scrollHeight, during render) can see
    // the DOM before the change being rendered: switching the chart to lyrics only then
    // clipped against the full chart's height, and hid the whole page.
    // No clip on the last page, or for a broken/non-monotonic offset pair (e.g. a stale page
    // index read against a different song's offsets): better unclipped than nothing.
    const clipPath = nextOffsetY !== undefined && nextOffsetY > offsetY
      ? `inset(0 0 max(0px, calc(100% - ${nextOffsetY}px)) 0)`
      : 'inset(0 0 0 0)';
    return { transform: `translateY(${-offsetY}px)`, clipPath };
  }, [pageOffsets]);

  // A static copy of the content showing `page`, placed exactly over the real content.
  const clonePage = useCallback((page: number) => {
    const content = contentRef.current!;
    const copy = content.cloneNode(true) as HTMLElement;
    Object.assign(copy.style, pageStyle(page), {
      position: 'absolute',
      top: `${content.offsetTop}px`,
      left: `${content.offsetLeft}px`,
      width: `${content.offsetWidth}px`,
      pointerEvents: 'none',
    });
    // Cloning a canvas doesn't copy its drawing (the hand-written notes).
    const canvases = copy.querySelectorAll('canvas');
    content.querySelectorAll('canvas').forEach((canvas, i) => canvases[i]?.getContext('2d')?.drawImage(canvas, 0, 0));
    return copy;
  }, [pageStyle]);
  // Set when a swipe has already slid the new page into place, so it isn't flipped in again.
  const skipPageFlipRef = useRef(false);

  // Pages turn sideways, like a book: a copy of the old page slides out while the new one
  // slides in from the other side. Only for a page turn within a song — not a song change
  // or a re-measure that happens to move the page.
  const shownPageRef = useRef({ index: currentIndex, page: currentPageInSong, offsets: pageOffsets });
  useLayoutEffect(() => {
    const prev = shownPageRef.current;
    shownPageRef.current = { index: currentIndex, page: currentPageInSong, offsets: pageOffsets };
    const skip = skipPageFlipRef.current;
    skipPageFlipRef.current = false;
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (
      skip || continuous || !viewport || !content || prev.page === currentPageInSong
      || prev.index !== currentIndex || prev.offsets !== pageOffsets
    ) return;
    const dir = currentPageInSong > prev.page ? 1 : -1;
    const from = pageStyle(prev.page);
    const to = pageStyle(currentPageInSong);
    const old = clonePage(prev.page);
    viewport.appendChild(old);
    const timing = { duration: 280, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' };
    old.animate(
      [{ transform: from.transform }, { transform: `translateX(${-dir * 100}%) ${from.transform}` }],
      timing,
    ).onfinish = () => old.remove();
    content.animate([{ transform: `translateX(${dir * 100}%) ${to.transform}` }, { transform: to.transform }], timing);
  }, [currentPageInSong, currentIndex, pageOffsets, continuous, pageStyle, clonePage]);

  // Your typed notes on the neighbouring songs, for the swipe peek. Loaded once per song (no
  // polling, unlike the current song's): they're only glimpsed in passing.
  const [neighbourNotes, setNeighbourNotes] = useState<Record<string, LyricNoteDocument[]>>({});
  const requestedNotesRef = useRef(new Set<string>());
  useEffect(() => {
    if (!bandId || !user) return;
    for (const song of [songs[currentIndex - 1], songs[currentIndex + 1]]) {
      if (!song || requestedNotesRef.current.has(song.id)) continue;
      requestedNotesRef.current.add(song.id);
      loadSongHandNotes(bandId, song.id)
        .then((notes) => {
          const mine = notes.filter((note) => note.authorUid === user.id);
          setNeighbourNotes((prev) => ({ ...prev, [song.id]: mine }));
        })
        .catch(() => requestedNotesRef.current.delete(song.id)); // try again next time
    }
  }, [bandId, user, songs, currentIndex]);

  const pinnedLineIds = useMemo(
    () => extractPinnedLineIds(handNotes.visibleNotes),
    [handNotes.visibleNotes]
  );

  const [confirmingStop, setConfirmingStop] = useState(false);
  const confirmStopTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (confirmStopTimeoutRef.current) clearTimeout(confirmStopTimeoutRef.current);
  }, []);

  const handleStopConcert = useCallback(() => {
    if (!confirmingStop) {
      setConfirmingStop(true);
      confirmStopTimeoutRef.current = setTimeout(() => setConfirmingStop(false), 3000);
      return;
    }
    if (confirmStopTimeoutRef.current) clearTimeout(confirmStopTimeoutRef.current);
    navigate(backRoute, { state: backState });
  }, [confirmingStop, navigate, backRoute, backState]);

  const updateScrollEdge = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const top = viewport.scrollTop <= 1;
    const bottom = viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 2;
    setScrollEdge((prev) => (prev.top === top && prev.bottom === bottom ? prev : { top, bottom }));
  }, []);

  // Rewinding: the autoscroll button's handle dragged above its speed track scrolls the chart
  // back at this rate (px/s), playing or paused.
  const rewindRef = useRef(0);
  const [rewinding, setRewinding] = useState(false);
  const changeRewind = useCallback((pxPerSecond: number) => {
    rewindRef.current = pxPerSecond;
    setRewinding(pxPerSecond > 0);
  }, []);

  const startPause = useCallback((pause: { index: number; endsAt: number | null } | null) => {
    activePauseRef.current = pause;
    setActivePause(pause);
  }, []);

  // Start/pause autoscroll. Holding at a scroll pause, it ends the pause instead and scrolls on.
  const toggleScrolling = useCallback(() => {
    if (activePauseRef.current) {
      startPause(null);
      return;
    }
    setScrolling((v) => !v);
  }, [startPause]);

  // Autoscroll loop. scrollTop rounds to whole (device) pixels, so keep the fractional position
  // ourselves; slow speeds would otherwise never advance. Typical speeds move less than a pixel
  // a frame, which scrollTop alone shows as a step every few frames: the leftover fraction goes
  // into a translateY on the content instead, so the chart glides. While the user scrolls by hand
  // (a finger down, or the scroll still moving from a drag, wheel or button), it holds
  // still and then carries on from wherever that left it.
  // `pos` is the scroll position the play line asks for (see ScrollGeometry): negative during
  // the lead-in at the top of the song, where the chart holds still.
  // Scrolling down past a {hold} marker's trigger holds still there for the pause's length
  // (or until tapped). Scrolling by hand or rewinding cancels a pause; one that was scrolled
  // past by hand doesn't fire, and one scrolled back above fires again.
  useEffect(() => {
    const viewport = viewportRef.current;
    if ((!scrolling && !rewinding) || !autoscroll || !continuous || !viewport) return;
    const content = contentRef.current;
    let raf = 0;
    let last = performance.now();
    // At the top of the song: the lead-in, from where it was paused or from the start (a hair
    // before it, so a pause marker on the very first line fires too).
    let pos = viewport.scrollTop >= 0.5
      ? viewport.scrollTop
      : (leadInPosRef.current ?? -scrollLeadInRef.current - 0.01);
    // The scrollTop as the browser took it the last time this loop set it: anything else moved
    // the scroll since.
    let written = viewport.scrollTop;
    let movedByOthersAt = -Infinity;
    let applied = '';
    const shift = (px: number) => {
      applied = px > 0.01 ? `translateY(${-px}px)` : '';
      if (content) content.style.transform = applied;
    };
    const scrollTo = (target: number) => {
      const dpr = window.devicePixelRatio || 1;
      viewport.scrollTop = Math.floor(Math.max(0, target) * dpr) / dpr;
      written = viewport.scrollTop;
      // Past the end scrollTop stops short; never shift the chart further than a pixel.
      shift(Math.min(1, Math.max(0, target - written)));
      leadInPosRef.current = target < 0 ? target : null;
    };
    if (content) content.style.willChange = 'transform';
    const tick = (now: number) => {
      const dt = Math.min(now - last, 100) / 1000;
      last = now;
      if (rewindRef.current > 0) {
        if (activePauseRef.current) startPause(null);
        if (Math.abs(viewport.scrollTop - written) > 2) pos = viewport.scrollTop;
        if (pos > 0) pos = Math.max(0, pos - rewindRef.current * dt);
        scrollTo(pos);
        raf = requestAnimationFrame(tick);
        return;
      }
      if (!scrolling) return; // rewinding just ended, and autoscroll is paused
      // Something else moved the scroll (a drag, its momentum, the wheel, a button). While
      // already holding, even a slow drift counts, so it's followed to the very end.
      const holding = touchingRef.current || now - movedByOthersAt < 250;
      if (Math.abs(viewport.scrollTop - written) > (holding ? 0.5 : 2)) movedByOthersAt = now;
      if (touchingRef.current || now - movedByOthersAt < 250) {
        if (activePauseRef.current) startPause(null);
        shift(0);
        pos = viewport.scrollTop;
        written = pos;
        leadInPosRef.current = null;
        setLeadInSeconds(null);
        raf = requestAnimationFrame(tick);
        return;
      }
      const pause = activePauseRef.current;
      if (pause) {
        if (pause.endsAt === null || now < pause.endsAt) {
          raf = requestAnimationFrame(tick);
          return;
        }
        startPause(null);
      }
      let next = pos + scrollSpeedRef.current * dt;
      const hit = scrollPausesRef.current.findIndex((p) => p.fires && pos < p.trigger && p.trigger <= next);
      if (hit !== -1) {
        next = scrollPausesRef.current[hit].trigger;
        const seconds = scrollPausesRef.current[hit].seconds;
        startPause({ index: hit, endsAt: seconds === null ? null : now + seconds * 1000 });
      }
      pos = next;
      scrollTo(pos);
      const speed = scrollSpeedRef.current;
      const leadIn = pos < 0 && speed > 0 ? Math.ceil(-pos / speed) : null;
      setLeadInSeconds((current) => (current === leadIn ? current : leadIn));
      if (viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 1) {
        setScrolling(false);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      // Stopped: the fraction is dropped (under a pixel), back to plain scrolling. Only our own
      // shift is cleared: switching to pages has already put the page's transform there.
      if (content) {
        if (content.style.transform === applied) content.style.transform = '';
        content.style.willChange = '';
      }
      setLeadInSeconds(null);
      if (activePauseRef.current) startPause(null);
    };
  }, [scrolling, rewinding, autoscroll, continuous, startPause]);

  // The unsaved-speed bar's height, to lift the floating footer clear of it.
  const scrollSaveBarRef = useRef<HTMLDivElement>(null);
  const [scrollSaveBarHeight, setScrollSaveBarHeight] = useState(0);
  // Editors only: for view-only members a speed change just lasts until they leave the song.
  // There's no discard: leaving the song (or dragging back) does that.
  const showScrollSaveBar = autoscroll && continuous && scrollAdjustUnsaved && canSaveScrollSpeed;
  useLayoutEffect(() => {
    const bar = scrollSaveBarRef.current;
    if (!showScrollSaveBar || !bar) {
      setScrollSaveBarHeight(0);
      return;
    }
    const update = () => setScrollSaveBarHeight(bar.offsetHeight);
    const observer = new ResizeObserver(update);
    observer.observe(bar);
    update();
    return () => observer.disconnect();
  }, [showScrollSaveBar]);

  // While holding at a pause: its marker lights up, and the countdown ticks.
  const [pauseNow, setPauseNow] = useState(() => performance.now());
  useEffect(() => {
    if (!activePause) return;
    const marker = contentRef.current?.querySelectorAll<HTMLElement>('[data-scroll-pause]')[activePause.index];
    marker?.classList.add('is-active');
    setPauseNow(performance.now());
    const timer = activePause.endsAt === null ? 0 : window.setInterval(() => setPauseNow(performance.now()), 250);
    return () => {
      window.clearInterval(timer);
      marker?.classList.remove('is-active');
    };
  }, [activePause]);

  // How a song is shown: one choice of three, stored as the two (exclusive) flags it's made of.
  const viewMode = pagination ? 'pages' : autoscroll ? 'autoscroll' : 'scroll';
  const changeViewMode = useCallback((mode: 'pages' | 'scroll' | 'autoscroll') => {
    setPagination(mode === 'pages');
    setAutoscroll(mode === 'autoscroll');
    setScrolling(false);
    storeValue(PAGINATION_KEY, mode === 'pages' ? '1' : '0');
    storeValue(AUTOSCROLL_KEY, mode === 'autoscroll' ? '1' : '0');
  }, []);

  const changePulse = useCallback((on: boolean) => {
    setPulse(on);
    storeValue(PULSE_KEY, on ? '1' : '0');
  }, []);

  // Metronome click. Off on every entry (not remembered): audio can only start from a
  // user gesture, and an unexpected click on stage would be worse than none. The
  // context is created from the toggle press itself — see createResumedAudioContext.
  const [clickSound, setClickSound] = useState(false);
  const [clickAudio, setClickAudio] = useState<AudioContext | null>(null);
  const clickAudioRef = useRef<AudioContext | null>(null);

  const changeClickSound = useCallback((on: boolean) => {
    setClickSound(on);
    if (!on) {
      // A running context keeps the audio hardware awake (and the battery draining) even
      // when silent; suspend it until the click is wanted again.
      void clickAudioRef.current?.suspend().catch(() => {});
      return;
    }
    setAudioSessionType('playback'); // play through the iOS silent switch
    if (clickAudioRef.current) {
      resumeAudioContext(clickAudioRef.current);
      return;
    }
    void createResumedAudioContext()
      .then((ctx) => {
        clickAudioRef.current = ctx;
        setClickAudio(ctx);
      })
      .catch(() => setClickSound(false));
  }, []);

  useEffect(() => () => {
    void clickAudioRef.current?.close();
  }, []);

  // When a drag, swipe or multi-finger gesture last ended: the click that follows isn't a tap.
  const lastGestureEndRef = useRef(0);

  // Autoscroll: one finger scrolls natively, and the loop holds still while it moves. Only
  // fingers on the chart count (targetTouches); the chart never hears a finger elsewhere lift.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!autoscroll || !continuous || !viewport) return;
    const onMove = (e: TouchEvent) => {
      if (e.targetTouches.length === 1) touchingRef.current = true;
    };
    const onEnd = () => {
      touchingRef.current = false;
    };
    viewport.addEventListener('touchstart', onEnd, { passive: true });
    viewport.addEventListener('touchmove', onMove, { passive: true });
    viewport.addEventListener('touchend', onEnd);
    viewport.addEventListener('touchcancel', onEnd);
    return () => {
      viewport.removeEventListener('touchstart', onEnd);
      viewport.removeEventListener('touchmove', onMove);
      viewport.removeEventListener('touchend', onEnd);
      viewport.removeEventListener('touchcancel', onEnd);
      touchingRef.current = false;
    };
  }, [autoscroll, continuous]);

  // Two-finger tap opens the quick-actions menu (always centred on screen). Tracked in the capture phase on the song
  // surface so a second finger can cancel the one-finger drag/swipe before it acts.
  const [quickMenu, setQuickMenu] = useState(false);
  // First visit: a one-off coach mark that introduces the quick-actions menu.
  const [showIntro, setShowIntro] = useState(() => !readStoredFlag(QUICK_MENU_INTRO_KEY, false));
  const dismissIntro = useCallback(() => {
    setShowIntro(false);
    storeValue(QUICK_MENU_INTRO_KEY, '1');
  }, []);
  useEffect(() => {
    if (quickMenu && showIntro) dismissIntro();
  }, [quickMenu, showIntro, dismissIntro]);
  const introTouchesRef = useRef(new Set<number>());
  const introMaxTouchesRef = useRef(0);
  const onIntroPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    introTouchesRef.current.add(e.pointerId);
    introMaxTouchesRef.current = Math.max(introMaxTouchesRef.current, introTouchesRef.current.size);
  }, []);
  const onIntroPointerEnd = useCallback((e: React.PointerEvent) => {
    const touches = introTouchesRef.current;
    if (!touches.delete(e.pointerId) || touches.size > 0) return;
    // Trying the gesture on the intro itself opens the menu for real.
    if (introMaxTouchesRef.current === 2) setQuickMenu(true);
    introMaxTouchesRef.current = 0;
  }, []);
  const isCoarsePointer = useMemo(
    () => typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true,
    [],
  );
  const quickMenuRef = useRef<HTMLDivElement>(null);
  // Lifting the fingers that opened the menu makes the browser fire a click right after,
  // which would land on whichever tile now sits under them. Only accept clicks whose press
  // started on the menu after it opened (or keyboard clicks, which have detail 0).
  const quickMenuPressedRef = useRef(false);
  useLayoutEffect(() => {
    quickMenuPressedRef.current = false;
  }, [quickMenu]);
  const onQuickMenuPointerDown = useCallback(() => {
    quickMenuPressedRef.current = true;
  }, []);
  const onQuickMenuClickCapture = useCallback((e: React.MouseEvent) => {
    if (!quickMenuPressedRef.current && e.detail !== 0) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, []);
  // Swipe left/right to change song — or in page mode, page, going on to the neighbouring
  // song past either end. The chart follows the finger with the next page or song peeking in
  // beside it; past a threshold it slides on to it, otherwise it springs back (and only gives
  // a little where there's nothing). The title doesn't follow: as soon as the swipe is clearly
  // heading for another song, it snaps over to that song's, or to "start/end of set".
  const songSwipeRef = useRef<{
    pointerId: number; x: number; y: number; dx: number; axis: 'x' | 'y' | null; titleDir: number; previewDir: number;
  } | null>(null);
  const [swiping, setSwiping] = useState(false);
  // The page counter previews where the swipe is heading (it snaps with the title), and the
  // neighbouring songs' page counts it needs, worked out with their peeks.
  const [pagePreview, setPagePreview] = useState<{ page: number; count: number } | null>(null);
  const neighbourPagesRef = useRef<Record<-1 | 1, number>>({ [-1]: 1, 1: 1 });
  // In page mode, a neighbouring page of the same song is what peeks in (a copy, like the flip).
  const pageThatWay = (dir: number) => !continuous && pageOffsets[currentPageInSong + dir] !== undefined;
  const pagePeeksRef = useRef<HTMLElement[]>([]);
  const removePagePeeks = useCallback(() => {
    pagePeeksRef.current.forEach((peek) => peek.remove());
    pagePeeksRef.current = [];
  }, []);

  const showSwipeTitle = useCallback((dir: number) => {
    const title = titleLaneRef.current;
    if (title) title.style.transform = dir ? `translateX(${-dir * (title.offsetWidth + PEEK_GAP)}px)` : '';
  }, []);

  const slideChart = useCallback((from: number, to: number, onDone: () => void) => {
    const chart = chartLaneRef.current;
    if (!chart) return;
    chart.style.transform = '';
    const anim = chart.animate(
      [{ transform: `translateX(${from}px)` }, { transform: `translateX(${to}px)` }],
      { duration: 220, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', fill: 'forwards' },
    );
    anim.onfinish = () => {
      onDone();
      anim.cancel();
    };
  }, []);

  const springBack = useCallback((dx: number) => {
    showSwipeTitle(0);
    setPagePreview(null);
    slideChart(dx, 0, () => {
      setSwiping(false);
      removePagePeeks();
    });
  }, [showSwipeTitle, slideChart, removePagePeeks]);

  const cancelSongSwipe = useCallback(() => {
    const swipe = songSwipeRef.current;
    songSwipeRef.current = null;
    if (swipe?.axis === 'x') springBack(swipe.dx);
  }, [springBack]);

  const moveSongSwipe = useCallback((e: React.PointerEvent) => {
    const swipe = songSwipeRef.current;
    if (!swipe || swipe.pointerId !== e.pointerId || swipe.axis === 'y') return;
    const dx = e.clientX - swipe.x;
    const dy = e.clientY - swipe.y;
    if (!swipe.axis) {
      // Decide once which way it goes; vertical gestures (scrolling) are left alone.
      if (Math.abs(dy) > Math.max(12, Math.abs(dx))) {
        swipe.axis = 'y';
        return;
      }
      if (Math.abs(dx) < 12) return;
      swipe.axis = 'x';
      setActiveChord(null);
      setSwiping(true);
      e.currentTarget.setPointerCapture(e.pointerId);
      ([-1, 1] as const).forEach((side) => {
        if (!pageThatWay(side) || !chartLaneRef.current) return;
        const peek = document.createElement('div');
        peek.className = `concert-swipe-peek concert-swipe-peek--${side < 0 ? 'prev' : 'next'} concert-page-peek`;
        peek.appendChild(clonePage(currentPageInSong + side));
        chartLaneRef.current.appendChild(peek);
        pagePeeksRef.current.push(peek);
      });
    }
    const dir = dx < 0 ? 1 : -1;
    const page = pageThatWay(dir);
    swipe.dx = page || songs[currentIndex + dir] ? dx : dx * 0.2;
    if (chartLaneRef.current) chartLaneRef.current.style.transform = `translateX(${swipe.dx}px)`;
    const titleDir = Math.abs(dx) > 40 && !page ? dir : 0;
    if (titleDir !== swipe.titleDir) {
      swipe.titleDir = titleDir;
      showSwipeTitle(titleDir);
    }
    // Pages only: the page the swipe is heading for — in this song, or the start / end of the
    // neighbouring one.
    const previewDir = continuous || Math.abs(dx) <= 40 ? 0 : dir;
    if (previewDir !== swipe.previewDir) {
      swipe.previewDir = previewDir;
      const count = neighbourPagesRef.current[dir];
      setPagePreview(
        !previewDir ? null
          : page ? { page: currentPageInSong + dir + 1, count: currentPageCount }
            : songs[currentIndex + dir] ? { page: dir > 0 ? 1 : count, count }
              : null,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIndex, songs, showSwipeTitle, clonePage, continuous, pageOffsets, currentPageInSong]);

  const endSongSwipe = useCallback((e: React.PointerEvent) => {
    const swipe = songSwipeRef.current;
    if (!swipe || swipe.pointerId !== e.pointerId) return;
    songSwipeRef.current = null;
    if (swipe.axis !== 'x') return;
    // Keep the release from also counting as a tap, or reaching the app's sidebar swipe.
    lastGestureEndRef.current = Date.now();
    e.stopPropagation();
    const dir = swipe.dx < 0 ? 1 : -1;
    const width = chartLaneRef.current?.offsetWidth ?? 0;
    const page = pageThatWay(dir);
    if (e.type === 'pointercancel' || !(page || songs[currentIndex + dir]) || Math.abs(swipe.dx) < Math.min(width / 4, 120)) {
      springBack(swipe.dx);
      return;
    }
    // Slide on until the peeking page or song sits where the chart was, then make it the
    // current one. Dropping the swiping class in the same commit lets the title reset without
    // animating.
    if (!page) showSwipeTitle(dir);
    slideChart(swipe.dx, -dir * (width + PEEK_GAP), () => {
      flushSync(() => {
        if (page) {
          skipPageFlipRef.current = true;
          setCurrentPageInSong((p) => p + dir);
        } else {
          // Like a book: back into a song lands on its last page (what its peek showed).
          targetPageRef.current = dir < 0 && !continuous ? Number.POSITIVE_INFINITY : 0;
          setCurrentIndex(currentIndex + dir);
        }
        setSwiping(false);
        setPagePreview(null);
      });
      removePagePeeks();
      showSwipeTitle(0);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIndex, songs, slideChart, springBack, showSwipeTitle, removePagePeeks, continuous, pageOffsets, currentPageInSong]);

  // In page mode the neighbouring songs' peeks are split into pages like the real view, for
  // their page counts (the counter's preview), and a swipe back from the first page lands on
  // the previous song's last page, so its peek is shifted to show that page.
  useLayoutEffect(() => {
    if (!swiping || continuous) return;
    const lane = titleLaneRef.current;
    const actions = lane?.closest('.concert-song-header')?.querySelector<HTMLElement>('.concert-header-actions');
    const actionsHeight = actions?.offsetHeight ?? 0;
    for (const dir of [-1, 1] as const) {
      const side = dir < 0 ? 'prev' : 'next';
      const content = chartLaneRef.current?.querySelector<HTMLElement>(
        `:scope > .concert-swipe-peek--${side}:not(.concert-page-peek) .concert-page-content`,
      );
      const viewport = content?.parentElement;
      if (!content || !viewport || viewport.clientHeight <= 0) continue;
      // While swiping, the header is as tall as the tallest title shown; on that song it'll
      // fit its own title, leaving the chart a different height — and page breaks.
      const title = lane?.querySelector<HTMLElement>(`:scope > .concert-swipe-peek--${side}`);
      const headerShrink = lane && title
        ? Math.max(lane.offsetHeight, actionsHeight) - Math.max(title.offsetHeight, actionsHeight)
        : 0;
      const offsets = computePageOffsets(content, viewport.clientHeight + headerShrink);
      neighbourPagesRef.current[dir] = offsets.length;
      if (dir < 0) content.style.transform = `translateY(${-offsets[offsets.length - 1]}px)`;
    }
  }, [swiping, continuous, currentIndex]);

  // iOS takes over a swipe that isn't dead level as a native pan, and cancels it midway (so
  // it springs back). Claim a one-finger gesture as soon as it heads more sideways than up or
  // down, before iOS starts panning; vertical ones are left to scroll natively. (In page
  // mode there's no native panning to begin with: touch-action: none.)
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const onTouchMove = (e: TouchEvent) => {
      const swipe = songSwipeRef.current;
      if (!swipe || swipe.axis === 'y' || e.touches.length !== 1 || !e.cancelable) return;
      const touch = e.touches[0];
      if (swipe.axis === 'x' || Math.abs(touch.clientX - swipe.x) > Math.abs(touch.clientY - swipe.y)) {
        e.preventDefault();
      }
    };
    surface.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => surface.removeEventListener('touchmove', onTouchMove);
  }, []);

  // The song list floats over the chart on narrow screens, and iOS hands a drag on it that
  // the list can't scroll at all (on its header, or a list that fits) to the chart underneath.
  // Keep those drags on the list. Past either end of a scrolling list, overscroll-behavior
  // keeps the drag there instead, with the rubber-band bounce intact.
  useEffect(() => {
    const panel = songNavigatorRef.current;
    if (!panel || !showSongNavigator || !isMultiSong) return;
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1 || !e.cancelable) return;
      const list = panel.querySelector('ol');
      const onList = !!list && e.target instanceof Node && list.contains(e.target);
      if (!onList || list.scrollHeight <= list.clientHeight) e.preventDefault();
    };
    panel.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => panel.removeEventListener('touchmove', onTouchMove);
  }, [showSongNavigator, isMultiSong]);

  // No pinch-zoom on stage (the text-size buttons set the size). touch-action covers most of
  // it; Safari also zooms on its own gesture events, so those are blocked while here.
  useEffect(() => {
    const block = (e: Event) => e.preventDefault();
    document.addEventListener('gesturestart', block);
    document.addEventListener('gesturechange', block);
    return () => {
      document.removeEventListener('gesturestart', block);
      document.removeEventListener('gesturechange', block);
    };
  }, []);

  const touchesRef = useRef(new Map<number, { x: number; y: number }>());
  // Where the last press on the chart started: a click that ends far from it was a drag
  // (e.g. selecting text with the mouse), not a tap.
  const pressRef = useRef<{ x: number; y: number } | null>(null);
  const multiTouchRef = useRef<{
    start: number;
    maxTouches: number;
    moved: boolean;
  } | null>(null);

  const onSurfacePointerDownCapture = useCallback((e: React.PointerEvent) => {
    pressRef.current = { x: e.clientX, y: e.clientY };
    if (e.pointerType !== 'touch') return;
    const touches = touchesRef.current;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 1) {
      multiTouchRef.current = { start: e.timeStamp, maxTouches: 1, moved: false };
      const busy = !isMultiSong || chartLaneRef.current?.getAnimations().length;
      songSwipeRef.current = busy || (e.target as Element).closest('.concert-settings, .concert-autoscroll, input')
        ? null
        : { pointerId: e.pointerId, x: e.clientX, y: e.clientY, dx: 0, axis: null, titleDir: 0, previewDir: 0 };
      return;
    }
    const gesture = multiTouchRef.current;
    // More than one finger: not a swipe or tap.
    cancelSongSwipe();
    if (!gesture) return;
    gesture.maxTouches = Math.max(gesture.maxTouches, touches.size);
  }, [isMultiSong, cancelSongSwipe]);

  const onSurfacePointerMoveCapture = useCallback((e: React.PointerEvent) => {
    moveSongSwipe(e);
    const start = touchesRef.current.get(e.pointerId);
    const gesture = multiTouchRef.current;
    if (!start || !gesture) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 15) gesture.moved = true;
  }, [moveSongSwipe]);

  const onSurfacePointerEndCapture = useCallback((e: React.PointerEvent) => {
    endSongSwipe(e);
    const touches = touchesRef.current;
    if (!touches.delete(e.pointerId) || touches.size > 0) return;
    const gesture = multiTouchRef.current;
    multiTouchRef.current = null;
    if (!gesture || gesture.maxTouches < 2) return;
    lastGestureEndRef.current = Date.now();
    if (gesture.maxTouches === 2 && !gesture.moved && e.timeStamp - gesture.start < 500) {
      setActiveChord(null);
      setQuickMenu(true);
    }
  }, [endSongSwipe]);

  // The app's top bar is hidden in concert mode and slides in while the menu is open.
  useEffect(() => {
    const root = document.documentElement;
    if (quickMenu) root.dataset.concertTopbar = 'shown';
    else delete root.dataset.concertTopbar;
    return () => { delete root.dataset.concertTopbar; };
  }, [quickMenu]);

  // Close the menu on outside press or Escape. Presses in the (now visible) top bar
  // don't count, so its buttons can be used.
  useEffect(() => {
    if (!quickMenu) return;
    const onPress = (e: PointerEvent) => {
      const target = e.target as Element;
      if (!quickMenuRef.current?.contains(target) && !target.closest?.('.topbar')) {
        setQuickMenu(false);
        // The press that closes the menu shouldn't also turn a page.
        lastGestureEndRef.current = Date.now();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault(); // handled: don't also leave concert mode
        setQuickMenu(false);
      }
    };
    document.addEventListener('pointerdown', onPress, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPress, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [quickMenu]);

  // Pressing anywhere outside the song list closes it, and that's all the press does: it
  // is kept from the song surface (no tap, swipe or drag) and the click it ends in is eaten.
  useEffect(() => {
    if (!showSongNavigator) return;
    const onPress = (e: PointerEvent) => {
      const target = e.target as Element;
      if (songNavigatorRef.current?.contains(target) || quickMenuRef.current?.contains(target)) return;
      e.stopPropagation();
      setShowSongNavigator(false);
      const swallow = (click: MouseEvent) => {
        click.preventDefault();
        click.stopPropagation();
      };
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallow, true), 1000);
    };
    window.addEventListener('pointerdown', onPress, true);
    return () => window.removeEventListener('pointerdown', onPress, true);
  }, [showSongNavigator]);

  const goToSong = useCallback((index: number) => {
    targetPageRef.current = 0;
    setCurrentIndex(Math.min(Math.max(index, 0), songs.length - 1));
  }, [songs.length]);

  const goToNextPage = useCallback(() => {
    if (continuous) {
      const viewport = viewportRef.current;
      const atBottom = !viewport || viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 2;
      if (!atBottom) {
        viewport.scrollBy({ top: viewport.clientHeight * 0.85, behavior: 'smooth' });
      } else if (currentIndex < songs.length - 1) {
        targetPageRef.current = 0;
        setCurrentIndex((i) => i + 1);
      }
      return;
    }
    if (currentPageInSong < currentPageCount - 1) {
      setCurrentPageInSong((p) => p + 1);
    } else if (currentIndex < songs.length - 1) {
      targetPageRef.current = 0;
      setCurrentIndex((i) => i + 1);
    }
  }, [continuous, currentPageInSong, currentPageCount, currentIndex, songs.length]);

  const goToPrevPage = useCallback(() => {
    if (continuous) {
      const viewport = viewportRef.current;
      if (viewport && viewport.scrollTop > 1) {
        viewport.scrollBy({ top: -viewport.clientHeight * 0.85, behavior: 'smooth' });
      } else if (currentIndex > 0) {
        targetPageRef.current = Number.POSITIVE_INFINITY;
        setCurrentIndex((i) => i - 1);
      }
      return;
    }
    if (currentPageInSong > 0) {
      setCurrentPageInSong((p) => p - 1);
    } else if (currentIndex > 0) {
      // Land on the previous song's last page even if it hasn't been measured yet
      // (e.g. the navigator was used to skip ahead) — the layout effect clamps this
      // once real page offsets are computed for that song.
      targetPageRef.current = Number.POSITIVE_INFINITY;
      setCurrentIndex((i) => i - 1);
    }
  }, [continuous, currentPageInSong, currentIndex]);

  // A brief, faint flash over the half of the chart a tap acted on.
  const [tapFlash, setTapFlash] = useState<{ side: 'left' | 'right' | 'top' | 'bottom'; n: number } | null>(null);

  const handleSurfaceTap = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('button, a, input, label, select, [role="button"], .concert-scroll-save-bar')) return;
    // A drag, a swipe or a multi-finger gesture is not a tap.
    const press = pressRef.current;
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) return;
    if (Date.now() - lastGestureEndRef.current < 400) return;
    if ((multiTouchRef.current?.maxTouches ?? 0) > 1) return;
    if (activeChord) {
      setActiveChord(null);
      return;
    }
    if (autoscroll && continuous) {
      // Tap anywhere to start/pause autoscroll.
      toggleScrolling();
      return;
    }
    // A personal preference: taps can be kept from turning pages / scrolling.
    if (user?.preferences?.concertTapToNavigate === false) return;
    // Pages turn sideways, so the left half goes back and the right half forward. Scrolling
    // runs up and down, so there it's the upper and lower half.
    const rect = (chartLaneRef.current ?? e.currentTarget).getBoundingClientRect();
    const back = continuous
      ? e.clientY < rect.top + rect.height / 2
      : e.clientX < rect.left + rect.width / 2;
    if (back) goToPrevPage();
    else goToNextPage();
    const side = continuous ? (back ? 'top' : 'bottom') : (back ? 'left' : 'right');
    setTapFlash((flash) => ({ side, n: (flash?.n ?? 0) + 1 }));
  }, [activeChord, autoscroll, continuous, goToNextPage, goToPrevPage, toggleScrolling, user?.preferences?.concertTapToNavigate]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement
        || (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }

      // Esc closes whatever is open (the menus close themselves); with nothing open, it
      // leaves concert mode. A menu that closed on this Esc marks it handled: its state may
      // already read closed here, since React applies that update before this listener runs.
      if (event.key === 'Escape') {
        if (event.defaultPrevented || quickMenu || showSettings || activeChord || showIntro) return;
        if (showSongNavigator) setShowSongNavigator(false);
        else navigate(backRoute, { state: backState });
        return;
      }

      if (event.key === 'ArrowRight') {
        event.preventDefault();
        goToNextPage();
      }

      // Space: start/pause autoscroll when it's on, otherwise the next page. Buttons in the
      // open menus keep Space for themselves; any other focused button (e.g. one just clicked)
      // is let go of, so Space doesn't press it again.
      if (event.key === ' ' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const inMenu = target instanceof Element
          && (quickMenuRef.current?.contains(target) || settingsRef.current?.contains(target));
        if (inMenu) return;
        event.preventDefault();
        if (target instanceof HTMLElement && target !== document.body) target.blur();
        if (event.repeat) return;
        if (autoscroll && continuous) toggleScrolling();
        else goToNextPage();
      }

      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        goToPrevPage();
      }

      if (isMultiSong && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        setShowSongNavigator((value) => !value);
      }

      // M: the quick-actions menu (the keyboard twin of a two-finger tap), centred.
      if (event.key.toLowerCase() === 'm' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        setQuickMenu((open) => !open);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    goToNextPage, goToPrevPage, toggleScrolling, isMultiSong, autoscroll, continuous,
    quickMenu, showSettings, activeChord, showIntro, showSongNavigator, navigate, backRoute, backState,
  ]);

  // Close the settings popover on outside press or Escape.
  useEffect(() => {
    if (!showSettings) return;
    const onPress = (e: PointerEvent) => {
      if (!settingsRef.current?.contains(e.target as Node)) setShowSettings(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault(); // handled: don't also leave concert mode
        setShowSettings(false);
      }
    };
    document.addEventListener('pointerdown', onPress);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPress);
      document.removeEventListener('keydown', onKey);
    };
  }, [showSettings]);

  const changeFontScale = useCallback((delta: number) => {
    setFontScale((prev) => {
      const next = Math.round(Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, prev + delta)) * 10) / 10;
      try { localStorage.setItem(FONT_SCALE_KEY, String(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const changeChordScale = useCallback((delta: number) => {
    setChordScale((prev) => {
      const next = Math.round(Math.min(CHORD_SCALE_MAX, Math.max(CHORD_SCALE_MIN, prev + delta)) * 10) / 10;
      storeValue(CHORD_SCALE_KEY, String(next));
      return next;
    });
  }, []);

  const changeChartContent = useCallback((content: ChartContent) => {
    setChartContent(content);
    setActiveChord(null);
    storeValue(CHART_CONTENT_KEY, content);
  }, []);

  if (songs.length === 0) {
    return (
      <div className="not-found">
        <p>No songs to display.</p>
        <button type="button" className="btn btn--primary" onClick={handleStopConcert}>Go back</button>
      </div>
    );
  }

  const currentSong = songs[currentIndex] ?? songs[0];
  if (!currentSong) {
    return (
      <div className="not-found">
        <p>Could not load song for concert mode.</p>
        <button type="button" className="btn btn--primary" onClick={handleStopConcert}>Go back</button>
      </div>
    );
  }

  const canGoPrev = continuous
    ? !scrollEdge.top || currentIndex > 0
    : currentIndex > 0 || currentPageInSong > 0;
  const canGoNext = continuous
    ? !scrollEdge.bottom || currentIndex < songs.length - 1
    : currentPageInSong < currentPageCount - 1 || currentIndex < songs.length - 1;
  const showNavButtons = user?.preferences?.concertShowNavButtons !== false;

  // The previous/next song, parked beside a swipe lane while swiping. The title lane shows
  // the start/end of the set where there's no song.
  const renderSwipePeeks = (render: (song: Song, index: number) => React.ReactNode, showSetEdges = false) => swiping
    && ([-1, 1] as const).map((dir) => {
      const song = songs[currentIndex + dir];
      if ((!song && !showSetEdges) || (!showSetEdges && pageThatWay(dir))) return null;
      return (
        <div key={dir} className={`concert-swipe-peek concert-swipe-peek--${dir < 0 ? 'prev' : 'next'}`} aria-hidden="true">
          {song ? render(song, currentIndex + dir) : (
            <h2 className="concert-set-edge">{dir < 0 ? 'Start of set' : 'End of set'}</h2>
          )}
        </div>
      );
    });

  // The cue for the next song. Scrolling, it ends the song's running text; paged, it's laid
  // over the corner of the last page instead, so a chart that exactly fills its pages
  // doesn't get an extra page holding nothing but the cue.
  const renderUpNext = (index: number, overlay = false) => {
    const next = songs[index + 1];
    if (!next) return null;
    // What to get ready for: the key it's played in (after this member's transpose), and the
    // capo — including taking it off when this song has one and the next doesn't.
    const nextTranspose = transposeBySongId?.[next.id] ?? next.preferredTranspose ?? 0;
    const key = next.key?.trim() ? transposeChord(next.key.trim(), nextTranspose) : null;
    const nextCapo = next.capo ?? 0;
    const thisCapo = songs[index]?.capo ?? 0;
    const capo = nextCapo > 0 ? `Capo ${nextCapo}` : thisCapo > 0 ? 'No capo' : null;
    const hints = [key && `Key ${key}`, capo].filter(Boolean).join(' · ');
    const note = songNotes?.[next.id]?.trim();
    return (
      <button
        type="button"
        className={`concert-next-song${overlay ? ' concert-next-song--overlay' : ''}${overlay && showNavButtons ? ' concert-next-song--above-nav' : ''}`}
        onClick={() => goToSong(index + 1)}
        aria-label={`Next song: ${next.title}`}
      >
        <span className="concert-next-song-line">
          <span className="concert-next-song-label">next {index + 2}/{songs.length}</span>
          <strong className="concert-next-song-title">{next.title}</strong>
          <ChevronRight size={16} aria-hidden="true" />
        </span>
        {hints && <span className="concert-next-song-hints">{hints}</span>}
        {note && <span className="concert-next-song-note">{note}</span>}
      </button>
    );
  };

  const renderSongTitle = (song: Song, index: number) => {
    const note = songNotes?.[song.id]?.trim();
    return (
      <>
        <h2>
          {isMultiSong && <span className="concert-song-position">{index + 1}/{songs.length}</span>}
          {song.title}
          {song.artist && <span className="concert-song-artist"> · {song.artist}</span>}
          {song.capo !== undefined && song.capo > 0 && <span className="capo-badge">Capo {song.capo}</span>}
        </h2>
        {note && <p className="concert-song-note">{note}</p>}
      </>
    );
  };

  const editCurrentSong = () => {
    if (!bandId) return;
    // Remember the song on this history entry so Cancel (history back) lands on it too.
    const concertState = { ...((location.state as object | null) ?? {}), concertSongId: currentSong.id };
    const concertPath = `${location.pathname}${location.search}`;
    navigate(concertPath, { replace: true, state: concertState });
    navigate(`/songs/${currentSong.id}/edit`, {
      state: { bandId, backTo: backRoute, returnTo: { path: concertPath, state: concertState } },
    });
  };

  return (
    <section
      className="concert-mode"
      aria-label={title || undefined}
      style={{ '--concert-font-scale': fontScale, '--concert-chord-scale': chordScale } as React.CSSProperties}
    >
      {session?.error && <p className="concert-session-error">{session.error}</p>}
      {canUseMetronome && (
        <ConcertMetronomeFlash
          key={currentSong.id /* each song starts its own bar */}
          tempo={currentSong.tempo}
          timeSignature={currentSong.timeSignature}
          flash={pulse}
          audioContext={clickSound ? clickAudio : null}
          downbeatColor={downbeatColorCss(user?.preferences?.concertDownbeatColor)}
          sharedClock={sharedClock}
        />
      )}

      <div className={`concert-content-wrap${showSongNavigator && isMultiSong ? '' : ' concert-content-wrap--full'}`}>
        <article
          className={`concert-song-surface${swiping ? ' concert-song-surface--swiping' : ''}${continuous ? '' : ' concert-song-surface--paged'}`}
          ref={surfaceRef}
          onPointerDownCapture={onSurfacePointerDownCapture}
          onPointerMoveCapture={onSurfacePointerMoveCapture}
          onPointerUpCapture={onSurfacePointerEndCapture}
          onPointerCancelCapture={onSurfacePointerEndCapture}
          onClick={handleSurfaceTap}
        >
          <div className="concert-song-header concert-song-header--compact">
            <div className="concert-song-header-main">
              <div className="concert-swipe-lane concert-title-lane" ref={titleLaneRef}>
                <div>{renderSongTitle(currentSong, currentIndex)}</div>
                {renderSwipePeeks(renderSongTitle, true)}
              </div>
            </div>
            <div className="concert-header-actions">
              {(() => {
                const shown = pagePreview ?? (continuous ? null : { page: currentPageInSong + 1, count: currentPageCount });
                return shown && shown.count > 1 && (
                  <span className="concert-page-count" aria-label={`Page ${shown.page} of ${shown.count}`}>
                    {shown.page}/{shown.count}
                  </span>
                );
              })()}
              <button
                type="button"
                className={`concert-icon-btn concert-icon-btn--danger${confirmingStop ? ' is-confirming' : ''}`}
                onClick={handleStopConcert}
                onBlur={() => setConfirmingStop(false)}
                aria-label={confirmingStop ? 'Tap again to confirm stopping concert mode' : 'Stop concert mode'}
                title="Stop concert"
              >
                <Square size={16} fill="currentColor" />
                {confirmingStop && <span>Tap again</span>}
              </button>
              {isMultiSong && (
                <button
                  type="button"
                  className={`concert-icon-btn${showSongNavigator ? ' is-active' : ''}`}
                  onClick={() => setShowSongNavigator((value) => !value)}
                  aria-label={showSongNavigator ? 'Hide song navigator' : 'Show song navigator'}
                  aria-pressed={showSongNavigator}
                  title="Song list"
                >
                  <List size={18} />
                </button>
              )}
            <div
              className="concert-settings"
              ref={settingsRef}
              onPointerDown={(e) => e.stopPropagation()}
              onPointerUp={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                className={`concert-settings-btn${showSettings ? ' is-active' : ''}`}
                onClick={() => setShowSettings((v) => !v)}
                aria-label="Concert settings"
                aria-expanded={showSettings}
              >
                <Settings size={18} />
              </button>
              {showSettings && (
                <div className="concert-settings-panel" role="dialog" aria-label="Concert settings">
                  <span className="concert-settings-caption" id="concert-settings-view">Show song as</span>
                  <div className="concert-session-toggle" role="radiogroup" aria-labelledby="concert-settings-view">
                    {(['pages', 'scroll', 'autoscroll'] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        role="radio"
                        aria-checked={viewMode === mode}
                        className={viewMode === mode ? 'is-active' : ''}
                        onClick={() => changeViewMode(mode)}
                        title={
                          mode === 'pages' ? 'Split the song into pages you turn'
                            : mode === 'scroll' ? 'One long page you scroll yourself'
                              : 'One long page that scrolls by itself'
                        }
                      >
                        {mode === 'pages' ? 'Pages' : mode === 'scroll' ? 'Scroll' : 'Autoscroll'}
                      </button>
                    ))}
                  </div>
                  <span className="concert-settings-caption" id="concert-settings-content">Show</span>
                  <div className="concert-session-toggle" role="radiogroup" aria-labelledby="concert-settings-content">
                    {CHART_CONTENT_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={chartContent === option.value}
                        className={chartContent === option.value ? 'is-active' : ''}
                        onClick={() => changeChartContent(option.value)}
                        title={option.title}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                  {showChords && (
                    <>
                      <span className="concert-settings-caption" id="concert-settings-chord-size">Chord size</span>
                      <div className="concert-settings-stepper" role="group" aria-labelledby="concert-settings-chord-size">
                        <button
                          type="button"
                          onClick={() => changeChordScale(-CHORD_SCALE_STEP)}
                          disabled={chordScale <= CHORD_SCALE_MIN}
                          aria-label="Smaller chords"
                        >
                          <Minus size={14} />
                        </button>
                        <span className="concert-settings-stepper-value" aria-live="polite">{Math.round(chordScale * 100)}%</span>
                        <button
                          type="button"
                          onClick={() => changeChordScale(CHORD_SCALE_STEP)}
                          disabled={chordScale >= CHORD_SCALE_MAX}
                          aria-label="Larger chords"
                        >
                          <Plus size={14} />
                        </button>
                      </div>
                    </>
                  )}
                  {session && (
                    <span className="concert-settings-caption" id="concert-settings-sync">Setlist sync</span>
                  )}
                  {session && (
                    <div className="concert-session-toggle" role="group" aria-labelledby="concert-settings-sync">
                      {(['solo', 'follow', 'lead'] as const).map((m) => (
                        <button
                          key={m}
                          type="button"
                          className={session.mode === m ? 'is-active' : ''}
                          onClick={() => session.setMode(m)}
                          title={
                            m === 'solo' ? 'Navigate on your own'
                              : m === 'follow' ? "Follow the leader's screen"
                                : 'Lead — your navigation drives everyone'
                          }
                        >
                          {m === 'solo' ? 'Solo' : m === 'follow' ? 'Follow' : 'Lead'}
                        </button>
                      ))}
                    </div>
                  )}
                  {session && session.mode !== 'solo' && (
                    <span className="concert-session-leader" role="status">
                      {session.host ? (
                        <>
                          <span className="concert-session-leader-avatar" aria-hidden="true">
                            {session.host.avatar || session.host.name.slice(0, 1).toUpperCase()}
                          </span>
                          {session.isHost ? "You're leading" : `${session.host.name} is leading`}
                        </>
                      ) : session.isHost ? "You're leading" : 'Nobody is leading yet'}
                    </span>
                  )}
                </div>
              )}
            </div>
            </div>
          </div>

          <div className="concert-swipe-lane concert-chart-lane" ref={chartLaneRef}>
            <div
              className={`concert-page-viewport${continuous ? ' concert-page-viewport--scroll' : ''}`}
              ref={viewportRef}
              onScroll={continuous ? updateScrollEdge : undefined}
            >
              <div
                className="concert-page-content"
                ref={contentRef}
                style={continuous ? undefined : pageStyle(currentPageInSong)}
              >
                <div className="song-notes-stage">
                  <ChordDisplay
                    chordpro={currentSong.chordpro}
                    transpose={transpose}
                    showChords={showChords}
                    showLyrics={showLyrics}
                    notation={chordNotation}
                    bpm={currentSong.tempo}
                    timeSignature={currentSong.timeSignature}
                    instrument={chordInstrument}
                    hideMetaDirectives
                    onChordClick={showChords
                      ? (chord, rect) => {
                        setActiveChord((previous) =>
                          previous?.chord === chord && previous.rect.top === rect.top
                            ? null
                            : { chord, rect }
                        );
                      }
                      : undefined}
                    pinnedLineIds={pinnedLineIds}
                  />
                  <LyricHandNotesOverlay
                    visible
                    drawEnabled={false}
                    notes={handNotes.visibleNotes}
                    myStrokes={handNotes.myStrokes}
                    strokeColor={getUserNoteColor(user?.id ?? null)}
                    onMyStrokesChange={noop}
                  />
                  {/* Typed notes, read-only on stage. handNotes defaults to the current
                      user's own notes only. */}
                  {user && (
                    <SongTextNotesOverlay
                      visible
                      typeEnabled={false}
                      notes={handNotes.visibleNotes}
                      myTextNotes={handNotes.myTextNotes}
                      myAuthorUid={user.id}
                      myNotesVisible={handNotes.visibleNotes.some((n) => n.authorUid === user.id)}
                      noteColor={getUserNoteColor(user.id)}
                      onMyTextNotesChange={noop}
                    />
                  )}
                </div>
                {/* Scrolling: part of the running text, so it comes at the end of the scroll. */}
                {continuous && renderUpNext(currentIndex)}
              </div>
              {!continuous && currentPageInSong === currentPageCount - 1 && renderUpNext(currentIndex, true)}
              {!continuous && sessionMode === 'follow' && leaderPageEnd?.songIndex === currentIndex
                && currentPageInSong < leaderPageEnd.page && (
                <button
                  type="button"
                  className={`concert-next-song concert-next-song--overlay concert-leader-continues${showNavButtons ? ' concert-next-song--above-nav' : ''}`}
                  onClick={goToNextPage}
                  aria-label="Next page: the leader's page continues there"
                >
                  <span className="concert-next-song-line">
                    <span className="concert-next-song-label">turn yourself</span>
                    <strong className="concert-next-song-title">Leader's page continues</strong>
                    <ChevronRight size={16} aria-hidden="true" />
                  </span>
                </button>
              )}
            </div>
          {tapFlash && (
            <div
              key={tapFlash.n}
              className={`concert-tap-flash concert-tap-flash--${tapFlash.side}`}
              onAnimationEnd={() => setTapFlash(null)}
              aria-hidden="true"
            />
          )}
          {renderSwipePeeks((song) => {
            const myNotes = neighbourNotes[song.id] ?? [];
            return (
              <div className="concert-page-viewport">
                <div className="concert-page-content song-notes-stage">
                  <ChordDisplay
                    chordpro={song.chordpro}
                    transpose={transposeBySongId?.[song.id] ?? song.preferredTranspose ?? 0}
                    showChords={showChords}
                    showLyrics={showLyrics}
                    notation={chordNotation}
                    bpm={song.tempo}
                    timeSignature={song.timeSignature}
                    instrument={chordInstrument}
                    hideMetaDirectives
                  />
                  {user && myNotes.length > 0 && (
                    <SongTextNotesOverlay
                      visible
                      typeEnabled={false}
                      notes={myNotes}
                      myTextNotes={myNotes[0]?.textNotes ?? []}
                      myAuthorUid={user.id}
                      myNotesVisible
                      noteColor={getUserNoteColor(user.id)}
                      onMyTextNotesChange={noop}
                    />
                  )}
                </div>
              </div>
            );
          })}
          </div>

          {showScrollSaveBar && (
            <div className="concert-scroll-save-bar" role="region" aria-label="Unsaved scroll speed" ref={scrollSaveBarRef}>
              <span className="concert-scroll-save-bar-text">
                {scrollSaveState.error
                  ? `Couldn't save: ${scrollSaveState.error}`
                  : 'Scroll speed adjusted. Save changes?'}
              </span>
              <button
                type="button"
                className="btn btn--primary btn--sm"
                onClick={() => { void saveScrollSpeed(); }}
                disabled={scrollSaveState.saving}
              >
                {scrollSaveState.saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          )}

          {autoscroll && continuous && (
            <ConcertAutoscrollButton
              scrolling={scrolling}
              speed={Math.min(SCROLL_SPEED_MAX, Math.max(SCROLL_SPEED_MIN, Math.round(scrollPxPerSecond)))}
              speedLabel={shownScrollSeconds !== null ? formatDuration(shownScrollSeconds) : undefined}
              countdown={activePause
                ? (activePause.endsAt === null ? null : Math.ceil(Math.max(0, activePause.endsAt - pauseNow) / 1000))
                : leadInSeconds}
              waitingForTap={activePause?.endsAt === null}
              min={SCROLL_SPEED_MIN}
              max={SCROLL_SPEED_MAX}
              onToggle={toggleScrolling}
              onSpeedChange={changeScrollSpeed}
              onRewind={changeRewind}
            />
          )}

        </article>

        {isMultiSong && showSongNavigator && (
          <aside className="concert-song-navigator" ref={songNavigatorRef} aria-label="Setlist songs navigator">
            <div className="concert-song-navigator-header">
              <h3>Setlist Songs</h3>
              <button
                type="button"
                className="concert-song-nav-close"
                onClick={() => setShowSongNavigator(false)}
                aria-label="Hide song navigator"
              >
                <X size={14} />
              </button>
            </div>
            <ol>
              {songs.map((song, index) => (
                <li key={song.id}>
                  <button
                    type="button"
                    className={`concert-song-jump${index === currentIndex ? ' active' : ''}${index < currentIndex ? ' played' : ''}`}
                    onClick={() => {
                      goToSong(index);
                      // On narrow screens the list floats over the chart; get it out of the way.
                      if (window.matchMedia('(max-width: 900px)').matches) setShowSongNavigator(false);
                    }}
                  >
                    <span className="concert-song-jump-number">{index + 1}</span>
                    <span className="concert-song-jump-main">
                      <strong>{song.title}</strong>
                      {song.artist && <small>{song.artist}</small>}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </aside>
        )}
      </div>

      <footer
        className={`concert-nav-footer${showNavButtons ? '' : ' concert-nav-footer--no-nav'}`}
        // Lifted clear of the unsaved-speed bar while it's shown.
        style={scrollSaveBarHeight ? { bottom: `calc(.95rem + ${scrollSaveBarHeight}px)` } : undefined}
      >
        {showNavButtons && (
          <button
            type="button"
            className="concert-nav-btn"
            onClick={goToPrevPage}
            disabled={!canGoPrev}
            aria-label="Previous page"
          >
            <ChevronLeft size={18} /> Previous
          </button>
        )}
        <div className="concert-font-size" role="group" aria-label="Text size">
          <button
            type="button"
            onClick={() => changeFontScale(-FONT_SCALE_STEP)}
            disabled={fontScale <= FONT_SCALE_MIN}
            aria-label="Decrease text size"
          >
            <Minus size={12} />A
          </button>
          <button
            type="button"
            onClick={() => changeFontScale(FONT_SCALE_STEP)}
            disabled={fontScale >= FONT_SCALE_MAX}
            aria-label="Increase text size"
          >
            <Plus size={12} />A
          </button>
        </div>
        {showNavButtons && (
          <button
            type="button"
            className="concert-nav-btn concert-nav-btn--primary"
            onClick={goToNextPage}
            disabled={!canGoNext}
            aria-label="Next page"
          >
            Next <ChevronRight size={18} />
          </button>
        )}
      </footer>

      {activeChord && (
        <ChordDiagram
          chord={activeChord.chord}
          instrument={chordInstrument}
          anchorRect={activeChord.rect}
          onClose={() => setActiveChord(null)}
          voicingOverride={chordVoicings.overrideFor('guitar', activeChord.chord)}
        />
      )}

      {showIntro && !quickMenu && (
        <div
          className="concert-intro"
          role="dialog"
          aria-modal="true"
          aria-labelledby="concert-intro-title"
          onPointerDown={onIntroPointerDown}
          onPointerUp={onIntroPointerEnd}
          onPointerCancel={onIntroPointerEnd}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            e.preventDefault(); // handled: don't also leave concert mode
            dismissIntro();
          }}
        >
          <div className="concert-intro-card">
            <div className="concert-intro-fingers" aria-hidden="true">
              <span /><span />
            </div>
            <h2 id="concert-intro-title">Quick actions</h2>
            <p>
              {isCoarsePointer ? (
                <>Tap the screen with <strong>two fingers</strong> to open the quick menu.</>
              ) : (
                <>Press <kbd>M</kbd> (or tap with two fingers on a touch screen) to open the quick menu.</>
              )}
            </p>
            <p className="concert-intro-detail">
              Change song, start autoscroll, edit the song, toggle the metronome and change the text size —
              without leaving the chart.
            </p>
            <button type="button" className="btn btn--primary" onClick={dismissIntro} autoFocus>
              Got it
            </button>
          </div>
        </div>
      )}

      {quickMenu && (
        <div
          ref={quickMenuRef}
          onClickCapture={onQuickMenuClickCapture}
          onPointerDown={onQuickMenuPointerDown}
          className="concert-quick-menu"
          role="menu"
          aria-label="Quick actions"
        >
          {isMultiSong && (
            <div className="concert-quick-menu-row" role="group" aria-label="Songs">
              <button
                type="button"
                role="menuitem"
                className="concert-quick-tile"
                disabled={currentIndex === 0}
                onClick={() => { goToSong(currentIndex - 1); setQuickMenu(false); }}
              >
                <SkipBack size={20} /><span>Previous</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className={`concert-quick-tile${showSongNavigator ? ' is-on' : ''}`}
                onClick={() => { setShowSongNavigator((v) => !v); setQuickMenu(false); }}
              >
                <List size={20} /><span>{currentIndex + 1}/{songs.length}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="concert-quick-tile"
                disabled={currentIndex >= songs.length - 1}
                onClick={() => { goToSong(currentIndex + 1); setQuickMenu(false); }}
              >
                <SkipForward size={20} /><span>Next</span>
              </button>
            </div>
          )}
          {((autoscroll && continuous) || canEditSongs) && (
            <div className="concert-quick-menu-row">
              {autoscroll && continuous && (
                <button
                  type="button"
                  role="menuitem"
                  className={`concert-quick-tile${scrolling ? ' is-on' : ''}`}
                  onClick={() => { toggleScrolling(); setQuickMenu(false); }}
                >
                  {scrolling ? <Pause size={20} /> : <Play size={20} style={{ transform: 'rotate(90deg)' }} />}
                  <span>{scrolling ? 'Pause' : 'Autoscroll'}</span>
                </button>
              )}
              {canEditSongs && (
                <button
                  type="button"
                  role="menuitem"
                  className="concert-quick-tile"
                  onClick={editCurrentSong}
                >
                  <SquarePen size={20} /><span>Edit song</span>
                </button>
              )}
            </div>
          )}
          {/* Metronome toggles stay open so the new state is visible. */}
          {canUseMetronome && Boolean(currentSong.tempo) && (
            <div className="concert-quick-menu-row" role="group" aria-label={`Metronome, ${Math.round(currentSong.tempo ?? 0)} BPM`}>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={pulse}
                className={`concert-quick-tile${pulse ? ' is-on' : ''}`}
                onClick={() => changePulse(!pulse)}
              >
                <Zap size={20} /><span>Flash</span>
              </button>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={clickSound}
                className={`concert-quick-tile${clickSound ? ' is-on' : ''}`}
                onClick={() => changeClickSound(!clickSound)}
              >
                {clickSound ? <Volume2 size={20} /> : <VolumeX size={20} />}<span>Click</span>
              </button>
            </div>
          )}
          {/* Text size stays open so it can be stepped several times. */}
          <div className="concert-quick-menu-row concert-quick-menu-row--size" role="group" aria-label="Text size">
            <button
              type="button"
              role="menuitem"
              className="concert-quick-tile"
              onClick={() => changeFontScale(-FONT_SCALE_STEP)}
              disabled={fontScale <= FONT_SCALE_MIN}
              aria-label="Decrease text size"
            >
              <span className="concert-quick-tile-glyph"><Minus size={14} />A</span>
            </button>
            <span className="concert-quick-menu-label">Text size</span>
            <button
              type="button"
              role="menuitem"
              className="concert-quick-tile"
              onClick={() => changeFontScale(FONT_SCALE_STEP)}
              disabled={fontScale >= FONT_SCALE_MAX}
              aria-label="Increase text size"
            >
              <span className="concert-quick-tile-glyph"><Plus size={14} />A</span>
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
