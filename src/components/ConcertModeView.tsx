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
import type { Song } from '../types';
import ChordDisplay from './ChordDisplay';
import ChordDiagram, { type DiagramInstrument } from './ChordDiagram';
import { useBandChordVoicings } from '../hooks/useBandChordVoicings';
import type { useSetlistSession } from '../hooks/useSetlistSession';
import LyricHandNotesOverlay from './LyricHandNotesOverlay';
import SongTextNotesOverlay from './SongTextNotesOverlay';
import ConcertMetronomeFlash from './ConcertMetronomeFlash';
import { createResumedAudioContext, resumeAudioContext, setAudioSessionType } from '../lib/webAudio';
import { useSongHandNotes } from '../hooks/useSongHandNotes';
import { downbeatColorCss } from '../lib/userPreferences';
import type { ChordNotation } from '../utils/chordParser';
import { getUserNoteColor } from '../lib/userColors';
import { extractPinnedLineIds } from '../lib/lineAnchor';

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

  // The "Up next" card after the song, kept whole on a page.
  const upNext = contentEl.querySelector('.concert-next-song');
  if (upNext) processAtom(upNext);

  return offsets;
}

const FONT_SCALE_KEY = 'gigboy.concert.fontScale';
const PAGINATION_KEY = 'gigboy.concert.pagination';
const PULSE_KEY = 'gigboy.concert.pulse';
const AUTOSCROLL_KEY = 'gigboy.concert.autoscroll';
const SCROLL_SPEED_KEY = 'gigboy.concert.scrollSpeed';
const QUICK_MENU_INTRO_KEY = 'gigboy.concert.quickMenuIntroSeen';
const SCROLL_SPEED_MIN = 5;
const SCROLL_SPEED_MAX = 120;
const SCROLL_SPEED_DEFAULT = 25;
const FONT_SCALE_MIN = 0.7;
const FONT_SCALE_MAX = 1.6;
const FONT_SCALE_STEP = 0.1;

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
  songNotes,
  bandId,
  canUseMetronome,
  transposeBySongId,
  session,
}: Props) {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const { bands } = useBands();
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
  const [transpose, setTranspose] = useState(0);
  // Display prefs are fixed in concert mode — they're set up beforehand in SongView.
  const showChords = true;
  const chordInstrument: DiagramInstrument = 'guitar';
  const chordNotation: ChordNotation = 'anglo';
  const [activeChord, setActiveChord] = useState<ActiveChord | null>(null);
  // Pagination (discrete pages) vs. continuous scrolling. Autoscroll needs continuous
  // scrolling, so the two toggles are mutually exclusive.
  const [pagination, setPagination] = useState(() => readStoredFlag(PAGINATION_KEY, true));
  const [autoscroll, setAutoscroll] = useState(() => readStoredFlag(AUTOSCROLL_KEY, false));
  const [scrollSpeed, setScrollSpeed] = useState(readStoredScrollSpeed);
  const [pulse, setPulse] = useState(() => readStoredFlag(PULSE_KEY, true));
  const [scrolling, setScrolling] = useState(false);
  const [scrollEdge, setScrollEdge] = useState({ top: true, bottom: false });
  const continuous = !pagination;
  const [showSettings, setShowSettings] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);
  const [showSongNavigator, setShowSongNavigator] = useState(false);
  const songNavigatorRef = useRef<HTMLElement>(null);
  const [fontScale, setFontScale] = useState(readStoredFontScale);
  const chordVoicings = useBandChordVoicings(bandId, false);

  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // While swiping, the chart and the title slide in lanes of their own; the header's buttons stay put.
  const chartLaneRef = useRef<HTMLDivElement>(null);
  const titleLaneRef = useRef<HTMLDivElement>(null);
  const targetPageRef = useRef(0);
  const contentScrollHeightRef = useRef(0);

  const isMultiSong = songs.length > 1;
  const activeSong = songs[currentIndex] ?? null;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIndex]);

  const sessionMode = session?.mode ?? 'solo';
  const sessionState = session?.state ?? null;

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
    targetPageRef.current = sessionState.pageIndex;
    setCurrentIndex(Math.min(Math.max(sessionState.songIndex, 0), Math.max(0, songs.length - 1)));
    setCurrentPageInSong(sessionState.pageIndex);
    setTranspose(sessionState.transpose);
  }, [sessionMode, sessionState, songs.length]);

  // Lead mode: broadcast local navigation to followers.
  const sessionPush = session?.push;
  useEffect(() => {
    if (sessionMode !== 'lead' || !sessionPush) return;
    sessionPush({ songIndex: currentIndex, pageIndex: currentPageInSong, transpose });
  }, [sessionMode, sessionPush, currentIndex, currentPageInSong, transpose]);

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

      contentScrollHeightRef.current = content.scrollHeight;
      const offsets = computePageOffsets(content, vh);

      content.style.transition = prevTransition;
      content.style.transform = prevTransform;
      content.style.clipPath = prevClipPath;

      setPageOffsets(offsets);
      updateScrollEdge();
      setCurrentPageInSong((p) => Math.min(p, offsets.length - 1));
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIndex, transpose, continuous]);

  // Leaving continuous mode: the viewport goes back to overflow:hidden, but would keep
  // its old scrollTop and show the song offset by that amount underneath the page transform.
  useLayoutEffect(() => {
    if (!continuous && viewportRef.current) viewportRef.current.scrollTop = 0;
  }, [continuous]);

  // Where the content sits to show a page: shifted up to the page's top and clipped below
  // its bottom, so the next page's first lines don't peek in.
  const pageStyle = useCallback((page: number) => {
    const offsetY = pageOffsets[page] ?? 0;
    // Read the content's *live* height rather than trusting the cached
    // snapshot from the last measurement pass. Content can shrink after that
    // snapshot was taken (e.g. hand-note data arriving and un-pinning lines
    // that were temporarily forced to single-row layout) without a resize
    // event ever re-running measure() — clipping against a stale, too-tall
    // snapshot can clip away an entire page's visible content.
    const liveScrollHeight = contentRef.current?.scrollHeight ?? contentScrollHeightRef.current;
    const nextOffsetY = pageOffsets[page + 1] ?? liveScrollHeight;
    // Guard against a broken/non-monotonic offset pair (e.g. a stale page
    // index read against a different song's offsets) ever clipping away an
    // entire page — better to show unclipped content than render nothing.
    const bottomClip = nextOffsetY > offsetY ? Math.max(0, liveScrollHeight - nextOffsetY) : 0;
    return { transform: `translateY(${-offsetY}px)`, clipPath: `inset(0 0 ${bottomClip}px 0)` };
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
    navigate(backRoute);
  }, [confirmingStop, navigate, backRoute]);

  const updateScrollEdge = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const top = viewport.scrollTop <= 1;
    const bottom = viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 2;
    setScrollEdge((prev) => (prev.top === top && prev.bottom === bottom ? prev : { top, bottom }));
  }, []);

  // Autoscroll loop. scrollTop can round to whole pixels, so keep the fractional position
  // ourselves; slow speeds would otherwise never advance.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!scrolling || !autoscroll || !continuous || !viewport) return;
    let raf = 0;
    let last = performance.now();
    let pos = viewport.scrollTop;
    const tick = (now: number) => {
      const dt = Math.min(now - last, 100) / 1000;
      last = now;
      // Re-sync if something else (a nav button, the user) moved the scroll position.
      if (Math.abs(viewport.scrollTop - pos) > 2) pos = viewport.scrollTop;
      pos += scrollSpeed * dt;
      viewport.scrollTop = pos;
      if (viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 1) {
        setScrolling(false);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [scrolling, autoscroll, continuous, scrollSpeed]);

  const changePagination = useCallback((on: boolean) => {
    setPagination(on);
    storeValue(PAGINATION_KEY, on ? '1' : '0');
    if (on) {
      setAutoscroll(false);
      setScrolling(false);
      storeValue(AUTOSCROLL_KEY, '0');
    }
  }, []);

  const changeAutoscroll = useCallback((on: boolean) => {
    setAutoscroll(on);
    storeValue(AUTOSCROLL_KEY, on ? '1' : '0');
    if (on) {
      setPagination(false);
      storeValue(PAGINATION_KEY, '0');
    } else {
      setScrolling(false);
    }
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
    if (!on) return;
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

  const changeScrollSpeed = useCallback((value: number) => {
    setScrollSpeed(value);
    storeValue(SCROLL_SPEED_KEY, String(value));
  }, []);

  // Drag-to-set-speed in autoscroll mode. The viewport handles the drag itself (finger
  // and mouse alike, touch-action: none) so there is no native momentum fighting the
  // autoscroll loop. On release, the forward speed of the last moments of the drag
  // becomes the new autoscroll speed; a backward drag or a drag that came to rest
  // before release just leaves autoscroll paused.
  const dragRef = useRef<{
    pointerId: number;
    startY: number;
    startScroll: number;
    moved: boolean;
    samples: { t: number; y: number }[];
  } | null>(null);
  const lastGestureEndRef = useRef(0);
  const dragScrollsManually = autoscroll && continuous;

  // iOS Safari doesn't honour touch-action: none on a scroll container: it pans natively
  // and sends pointercancel instead of pointerup, so the drag never sets a speed. A
  // non-passive touchmove that calls preventDefault keeps the gesture ours.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!dragScrollsManually || !viewport) return;
    const onTouchMove = (e: TouchEvent) => {
      if (e.cancelable) e.preventDefault();
    };
    viewport.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => viewport.removeEventListener('touchmove', onTouchMove);
  }, [dragScrollsManually]);

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
    pointerId: number; x: number; y: number; dx: number; axis: 'x' | 'y' | null; titleDir: number;
  } | null>(null);
  const [swiping, setSwiping] = useState(false);
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
      // Decide once which way it goes; vertical gestures (scrolling, autoscroll drags) are left alone.
      if (dragRef.current?.moved || Math.abs(dy) > Math.max(12, Math.abs(dx))) {
        swipe.axis = 'y';
        return;
      }
      if (Math.abs(dx) < 12) return;
      swipe.axis = 'x';
      dragRef.current = null;
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
    // animating. A song is entered at its start, whichever way the swipe went.
    if (!page) showSwipeTitle(dir);
    slideChart(swipe.dx, -dir * (width + PEEK_GAP), () => {
      flushSync(() => {
        if (page) {
          skipPageFlipRef.current = true;
          setCurrentPageInSong((p) => p + dir);
        } else {
          targetPageRef.current = 0;
          setCurrentIndex(currentIndex + dir);
        }
        setSwiping(false);
      });
      removePagePeeks();
      showSwipeTitle(0);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIndex, songs, slideChart, springBack, showSwipeTitle, removePagePeeks, continuous, pageOffsets, currentPageInSong]);

  const touchesRef = useRef(new Map<number, { x: number; y: number }>());
  const multiTouchRef = useRef<{
    start: number;
    maxTouches: number;
    moved: boolean;
  } | null>(null);

  const onSurfacePointerDownCapture = useCallback((e: React.PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    const touches = touchesRef.current;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 1) {
      multiTouchRef.current = { start: e.timeStamp, maxTouches: 1, moved: false };
      const busy = !isMultiSong || chartLaneRef.current?.getAnimations().length;
      songSwipeRef.current = busy || (e.target as Element).closest('.concert-settings, input')
        ? null
        : { pointerId: e.pointerId, x: e.clientX, y: e.clientY, dx: 0, axis: null, titleDir: 0 };
      return;
    }
    const gesture = multiTouchRef.current;
    // More than one finger: not a drag, swipe or tap.
    dragRef.current = null;
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

  const onViewportPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragScrollsManually || e.button !== 0) return;
    if (touchesRef.current.size > 1) return;
    if ((e.target as HTMLElement).closest('button, a, input, label, select, [role="button"]')) return;
    dragRef.current = {
      pointerId: e.pointerId,
      startY: e.clientY,
      startScroll: e.currentTarget.scrollTop,
      moved: false,
      samples: [{ t: e.timeStamp, y: e.clientY }],
    };
  }, [dragScrollsManually]);

  const onViewportPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const dy = e.clientY - drag.startY;
    if (!drag.moved) {
      if (Math.abs(dy) < 8) return;
      drag.moved = true;
      setScrolling(false);
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    e.currentTarget.scrollTop = drag.startScroll - dy;
    drag.samples.push({ t: e.timeStamp, y: e.clientY });
    // Only the recent past matters for the release speed.
    while (drag.samples.length > 2 && e.timeStamp - drag.samples[0].t > 300) drag.samples.shift();
  }, []);

  const onViewportPointerEnd = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    if (!drag.moved) return;
    lastGestureEndRef.current = Date.now();
    if (e.type === 'pointercancel') return;
    // Measure over the last ~150ms; holding still before letting go reads as zero.
    const now = e.timeStamp;
    const recent = drag.samples.filter((s) => now - s.t <= 150);
    if (recent.length < 2) return;
    const first = recent[0];
    const last = recent[recent.length - 1];
    const dt = (last.t - first.t) / 1000;
    if (dt <= 0) return;
    const forward = (first.y - last.y) / dt; // finger moving up = scrolling forward
    if (forward < SCROLL_SPEED_MIN) return;
    changeScrollSpeed(Math.round(Math.min(forward, SCROLL_SPEED_MAX)));
    setScrolling(true);
  }, [changeScrollSpeed]);

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
    if (target.closest('button, a, input, label, select, [role="button"]')) return;
    // A drag (which sets the autoscroll speed), a swipe or a multi-finger gesture is not a tap.
    if (Date.now() - lastGestureEndRef.current < 400) return;
    if ((multiTouchRef.current?.maxTouches ?? 0) > 1) return;
    if (activeChord) {
      setActiveChord(null);
      return;
    }
    if (autoscroll && continuous) {
      // Tap anywhere to start/pause autoscroll.
      setScrolling((v) => !v);
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
  }, [activeChord, autoscroll, continuous, goToNextPage, goToPrevPage, user?.preferences?.concertTapToNavigate]);

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
        else navigate(backRoute);
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
        if (autoscroll && continuous) setScrolling((v) => !v);
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
    goToNextPage, goToPrevPage, isMultiSong, autoscroll, continuous,
    quickMenu, showSettings, activeChord, showIntro, showSongNavigator, navigate, backRoute,
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
  const nextSong = songs[currentIndex + 1] ?? null;
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
      style={{ '--concert-font-scale': fontScale } as React.CSSProperties}
    >
      {session?.error && <p className="concert-session-error">{session.error}</p>}
      {canUseMetronome && (
        <ConcertMetronomeFlash
          tempo={currentSong.tempo}
          timeSignature={currentSong.timeSignature}
          flash={pulse}
          audioContext={clickSound ? clickAudio : null}
          downbeatColor={downbeatColorCss(user?.preferences?.concertDownbeatColor)}
        />
      )}

      <div className={`concert-content-wrap${showSongNavigator && isMultiSong ? '' : ' concert-content-wrap--full'}`}>
        <article
          className={`concert-song-surface${swiping ? ' concert-song-surface--swiping' : ''}`}
          onPointerDownCapture={onSurfacePointerDownCapture}
          onPointerMoveCapture={onSurfacePointerMoveCapture}
          onPointerUpCapture={onSurfacePointerEndCapture}
          onPointerCancelCapture={onSurfacePointerEndCapture}
          onClick={handleSurfaceTap}
        >
          <div className="concert-song-header concert-song-header--compact">
            <div className="concert-song-header-main">
              <div className="concert-swipe-lane concert-title-lane" ref={titleLaneRef}>
                {renderSongTitle(currentSong, currentIndex)}
                {renderSwipePeeks(renderSongTitle, true)}
              </div>
            </div>
            <div className="concert-header-actions">
              {!continuous && currentPageCount > 1 && (
                <span className="concert-page-count" aria-label={`Page ${currentPageInSong + 1} of ${currentPageCount}`}>
                  {currentPageInSong + 1}/{currentPageCount}
                </span>
              )}
              {autoscroll && continuous && (
                <button
                  type="button"
                  className={`concert-icon-btn concert-icon-btn--play${scrolling ? ' is-active' : ''}`}
                  onClick={() => setScrolling((v) => !v)}
                  aria-label={scrolling ? 'Pause autoscroll' : 'Start autoscroll'}
                  aria-pressed={scrolling}
                  title={scrolling ? 'Pause autoscroll' : 'Start autoscroll'}
                >
                  <Play size={18} fill="currentColor" style={{ transform: 'rotate(90deg)' }} />
                </button>
              )}
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
                  <label className="toggle-label">
                    <input
                      type="checkbox"
                      checked={pagination}
                      onChange={(e) => changePagination(e.target.checked)}
                    />
                    Pagination
                  </label>
                  <label className="toggle-label">
                    <input
                      type="checkbox"
                      checked={autoscroll}
                      onChange={(e) => changeAutoscroll(e.target.checked)}
                    />
                    Autoscroll
                  </label>
                  {canUseMetronome && (
                    <label className="toggle-label">
                      <input
                        type="checkbox"
                        checked={pulse}
                        onChange={(e) => changePulse(e.target.checked)}
                      />
                      BPM pulse
                    </label>
                  )}
                  {autoscroll && (
                    <label className="concert-settings-slider">
                      <span>Speed</span>
                      <input
                        type="range"
                        min={SCROLL_SPEED_MIN}
                        max={SCROLL_SPEED_MAX}
                        step={5}
                        value={scrollSpeed}
                        onChange={(e) => changeScrollSpeed(Number(e.target.value))}
                        aria-label="Autoscroll speed"
                      />
                    </label>
                  )}
                  {session && (
                    <div className="concert-session-toggle" role="group" aria-label="Setlist sync">
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
              className={`concert-page-viewport${continuous ? ' concert-page-viewport--scroll' : ''}${dragScrollsManually ? ' concert-page-viewport--drag' : ''}`}
              ref={viewportRef}
              onScroll={continuous ? updateScrollEdge : undefined}
              // With autoscroll on, a drag sets the speed (see onViewportPointer*). Without
              // it, native scrolling applies and a wheel/touch just pauses.
              onPointerDown={onViewportPointerDown}
              onPointerMove={onViewportPointerMove}
              onPointerUp={onViewportPointerEnd}
              onPointerCancel={onViewportPointerEnd}
              onTouchMove={continuous && !dragScrollsManually ? () => setScrolling(false) : undefined}
              onWheel={continuous ? () => setScrolling(false) : undefined}
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
                {/* Part of the running text, so it lands on the last page / end of the scroll. */}
                {nextSong && (
                  <button
                    type="button"
                    className="concert-next-song"
                    onClick={() => goToSong(currentIndex + 1)}
                    aria-label={`Next song: ${nextSong.title}`}
                  >
                    <span className="concert-next-song-label">Up next</span>
                    <span className="concert-next-song-position">{currentIndex + 2}/{songs.length}</span>
                    <span className="concert-next-song-title">
                      <strong>{nextSong.title}</strong>
                      {nextSong.artist && <span className="concert-next-song-artist"> · {nextSong.artist}</span>}
                    </span>
                    <ChevronRight size={16} />
                  </button>
                )}
              </div>
            </div>
          {tapFlash && (
            <div
              key={tapFlash.n}
              className={`concert-tap-flash concert-tap-flash--${tapFlash.side}`}
              onAnimationEnd={() => setTapFlash(null)}
              aria-hidden="true"
            />
          )}
          {renderSwipePeeks((song) => (
            <div className="concert-page-viewport">
              <div className="concert-page-content song-notes-stage">
                <ChordDisplay
                  chordpro={song.chordpro}
                  transpose={transposeBySongId?.[song.id] ?? song.preferredTranspose ?? 0}
                  showChords={showChords}
                  notation={chordNotation}
                  bpm={song.tempo}
                  timeSignature={song.timeSignature}
                  instrument={chordInstrument}
                  hideMetaDirectives
                />
              </div>
            </div>
          ))}
          </div>

          {!continuous && currentPageCount > 1 && (
            <div className="concert-page-indicator" aria-label={`Page ${currentPageInSong + 1} of ${currentPageCount}`}>
              {Array.from({ length: currentPageCount }, (_, i) => (
                <button
                  key={i}
                  type="button"
                  className={`concert-page-dot${i === currentPageInSong ? ' concert-page-dot--active' : ''}`}
                  onClick={() => setCurrentPageInSong(i)}
                  aria-label={`Go to page ${i + 1}`}
                />
              ))}
            </div>
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

      <footer className={`concert-nav-footer${showNavButtons ? '' : ' concert-nav-footer--no-nav'}`}>
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
                  onClick={() => { setScrolling((v) => !v); setQuickMenu(false); }}
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
