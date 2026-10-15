import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { X } from 'lucide-react';
import { anchorFromClientPoint, findContentStage, pointFromAnchor, resolveLineRects } from '../lib/lineAnchor';
import { getUserNoteColor } from '../lib/userColors';
import { generateId } from '../lib/uuid';
import type { LineAnchor, LyricNoteDocument, LyricTextNote } from '../types';

interface Props {
  visible: boolean;
  typeEnabled: boolean;
  notes: LyricNoteDocument[];
  myTextNotes: LyricTextNote[];
  myAuthorUid: string;
  myNotesVisible: boolean;
  noteColor: string;
  onMyTextNotesChange: (textNotes: LyricTextNote[]) => void;
}

interface PendingNew {
  id: string;
  anchor: LineAnchor;
  width?: number;
  height?: number;
}

/**
 * In-flight pointer gesture. Kept in a ref and applied straight to the bubble's DOM node, so a
 * drag/resize costs no React render and no line re-measuring per pointer move; the final position
 * is resolved once on release.
 */
type Gesture =
  | {
      kind: 'drag';
      id: string;
      el: HTMLElement;
      startX: number;
      startY: number;
      /** Viewport point of the bubble's anchor (top-centre) at grab time, so the grab offset is kept. */
      originX: number;
      originY: number;
      dx: number;
      dy: number;
      moved: boolean;
    }
  | {
      kind: 'resize';
      id: string;
      el: HTMLElement;
      startX: number;
      startY: number;
      startWidth: number;
      startHeight: number;
      width: number;
      height: number;
      inlineWidth: string;
      inlineMaxWidth: string;
      inlineHeight: string;
    };

// Minimum screen-pixel distance before a pointerdown is treated as a drag instead of a tap-to-edit.
const DRAG_THRESHOLD_PX = 6;
const MIN_BUBBLE_WIDTH = 48;
const MAX_BUBBLE_WIDTH = 600;
const MIN_BUBBLE_HEIGHT = 28;
const MAX_BUBBLE_HEIGHT = 600;

const clampWidth = (w: number) => Math.min(MAX_BUBBLE_WIDTH, Math.max(MIN_BUBBLE_WIDTH, Math.round(w)));
const clampHeight = (h: number) => Math.min(MAX_BUBBLE_HEIGHT, Math.max(MIN_BUBBLE_HEIGHT, Math.round(h)));

/** Inline size for a bubble; a set size also lifts the default max-width cap. */
const sizeStyle = (n: { width?: number; height?: number }): CSSProperties => ({
  ...(n.width ? { width: n.width, maxWidth: 'none' } : {}),
  ...(n.height ? { height: n.height } : {}),
});

const autosize = (el: HTMLTextAreaElement | null) => {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
};

export default function SongTextNotesOverlay({
  visible,
  typeEnabled,
  notes,
  myTextNotes,
  myAuthorUid,
  myNotesVisible,
  noteColor,
  onMyTextNotesChange,
}: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [pendingNew, setPendingNew] = useState<PendingNew | null>(null);
  const [pendingNewText, setPendingNewText] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingEditText, setPendingEditText] = useState('');

  // Re-render on resize/reflow so bubble positions (resolved from line anchors) stay current.
  const [, setLayoutRevision] = useState(0);

  // Prevents the stage click that fires immediately after a textarea blur from
  // opening a new bubble (blur fires before click in the same event sequence).
  const suppressNextClickRef = useRef(false);

  const gestureRef = useRef<Gesture | null>(null);

  // Reset all transient state when type mode is turned off
  useEffect(() => {
    if (!typeEnabled) {
      setPendingNew(null);
      setPendingNewText('');
      setEditingId(null);
      setPendingEditText('');
      gestureRef.current = null;
    }
  }, [typeEnabled]);

  useEffect(() => {
    if (!visible) return;
    const element = stageRef.current;
    if (!element) return;

    const bump = () => setLayoutRevision((r) => r + 1);
    const raf1 = window.requestAnimationFrame(bump);
    const raf2 = window.requestAnimationFrame(bump);

    const observer = new ResizeObserver(bump);
    observer.observe(element);
    window.addEventListener('resize', bump);

    return () => {
      window.cancelAnimationFrame(raf1);
      window.cancelAnimationFrame(raf2);
      observer.disconnect();
      window.removeEventListener('resize', bump);
    };
  }, [visible, notes]);

  const getContentStage = useCallback(() => findContentStage(stageRef.current), []);

  /** Resolves a stored anchor to a `{left%, top%}` style relative to the overlay stage. */
  const styleForAnchor = useCallback((anchor: LineAnchor): CSSProperties => {
    const overlay = stageRef.current;
    const contentStage = getContentStage();
    if (!overlay || !contentStage) return { left: '0%', top: '0%' };

    const overlayRect = overlay.getBoundingClientRect();
    const stageRect = contentStage.getBoundingClientRect();
    const lineRects = resolveLineRects(contentStage);
    const point = pointFromAnchor(lineRects, anchor);
    if (!point) return { left: '0%', top: '0%' };

    // Convert from contentStage-relative px to overlay-relative percentage
    // (the overlay and contentStage share the same box, but resolve independently to be safe).
    const offsetX = stageRect.left - overlayRect.left;
    const offsetY = stageRect.top - overlayRect.top;
    const width = Math.max(overlayRect.width, 1);
    const height = Math.max(overlayRect.height, 1);

    return {
      left: `${((point.x + offsetX) / width) * 100}%`,
      top: `${((point.y + offsetY) / height) * 100}%`,
    };
  }, [getContentStage]);

  // ── Stage click: create a new bubble at the clicked position ──────────────
  const handleStageClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!typeEnabled) return;
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      return;
    }
    if ((e.target as HTMLElement).closest('.song-text-bubble')) return;
    const contentStage = getContentStage();
    if (!contentStage) return;
    const anchor = anchorFromClientPoint(contentStage, e.clientX, e.clientY);
    if (!anchor) return;
    setPendingNew({ id: generateId(), anchor });
    setPendingNewText('');
  }, [typeEnabled, getContentStage]);

  // ── Commit / discard the new bubble being typed ───────────────────────────
  const commitPendingNew = useCallback(() => {
    suppressNextClickRef.current = true;
    const text = pendingNewText.trim();
    if (text && pendingNew) {
      onMyTextNotesChange([...myTextNotes, {
        id: pendingNew.id,
        ...pendingNew.anchor,
        ...(pendingNew.width ? { width: pendingNew.width } : {}),
        ...(pendingNew.height ? { height: pendingNew.height } : {}),
        text,
        createdAt: new Date().toISOString(),
      }]);
    }
    setPendingNew(null);
    setPendingNewText('');
  }, [pendingNew, pendingNewText, myTextNotes, onMyTextNotesChange]);

  // ── Commit / discard an in-place edit ────────────────────────────────────
  const commitEdit = useCallback(() => {
    if (!editingId) return;
    suppressNextClickRef.current = true;
    const text = pendingEditText.trim();
    onMyTextNotesChange(
      text
        ? myTextNotes.map((n) => n.id === editingId ? { ...n, text } : n)
        : myTextNotes.filter((n) => n.id !== editingId),
    );
    setEditingId(null);
    setPendingEditText('');
  }, [editingId, pendingEditText, myTextNotes, onMyTextNotesChange]);

  // ── Delete a bubble ───────────────────────────────────────────────────────
  const handleDeleteNote = useCallback((id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    onMyTextNotesChange(myTextNotes.filter((n) => n.id !== id));
    if (editingId === id) { setEditingId(null); setPendingEditText(''); }
  }, [myTextNotes, onMyTextNotesChange, editingId]);

  /** Applies a move/resize to a saved note, or to the new bubble that is still being typed. */
  const applyPatch = useCallback((id: string, patch: Partial<LyricTextNote>) => {
    if (pendingNew?.id === id) {
      const { lineId, fx, fy, width, height } = patch;
      setPendingNew({
        ...pendingNew,
        ...(lineId !== undefined && fx !== undefined && fy !== undefined ? { anchor: { lineId, fx, fy } } : {}),
        ...(width !== undefined ? { width } : {}),
        ...(height !== undefined ? { height } : {}),
      });
      return;
    }
    onMyTextNotesChange(myTextNotes.map((n) => (n.id === id ? { ...n, ...patch } : n)));
  }, [pendingNew, myTextNotes, onMyTextNotesChange]);

  // ── Drag (on the bubble itself)  ───────────────────────────────────────────
  const handleBubblePointerDown = useCallback((
    e: React.PointerEvent<HTMLDivElement>,
    note: Pick<LyricTextNote, 'id' | 'text'>,
  ) => {
    if (!typeEnabled || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    gestureRef.current = {
      kind: 'drag',
      id: note.id,
      el,
      startX: e.clientX,
      startY: e.clientY,
      originX: rect.left + rect.width / 2,
      originY: rect.top,
      dx: 0,
      dy: 0,
      moved: false,
    };
    el.setPointerCapture(e.pointerId);
  }, [typeEnabled]);

  const handleBubblePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>, note: Pick<LyricTextNote, 'id'>) => {
    const g = gestureRef.current;
    if (g?.kind !== 'drag' || g.id !== note.id) return;
    g.dx = e.clientX - g.startX;
    g.dy = e.clientY - g.startY;
    if (!g.moved) {
      if (Math.abs(g.dx) <= DRAG_THRESHOLD_PX && Math.abs(g.dy) <= DRAG_THRESHOLD_PX) return;
      g.moved = true;
      g.el.classList.add('song-text-bubble--dragging');
    }
    g.el.style.transform = `translate(calc(-50% + ${g.dx}px), ${g.dy}px)`;
  }, []);

  const endDrag = useCallback((g: Extract<Gesture, { kind: 'drag' }>) => {
    g.el.style.transform = '';
    g.el.classList.remove('song-text-bubble--dragging');
    gestureRef.current = null;
  }, []);

  const handleBubblePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>, note: Pick<LyricTextNote, 'id' | 'text'>) => {
    const g = gestureRef.current;
    if (g?.kind !== 'drag' || g.id !== note.id) return;
    e.stopPropagation();
    endDrag(g);

    if (g.moved) {
      const contentStage = getContentStage();
      const anchor = contentStage
        ? anchorFromClientPoint(contentStage, g.originX + g.dx, g.originY + g.dy)
        : null;
      if (anchor) {
        applyPatch(note.id, anchor);
      }
    } else if (editingId !== note.id && pendingNew?.id !== note.id) {
      // Tap: open for editing
      setEditingId(note.id);
      setPendingEditText(note.text);
    }
  }, [endDrag, getContentStage, applyPatch, editingId, pendingNew?.id]);

  const handleBubblePointerCancel = useCallback(() => {
    const g = gestureRef.current;
    if (g?.kind === 'drag') endDrag(g);
  }, [endDrag]);

  // ── Resize (corner handle) ────────────────────────────────────────────────
  // The bubble is centred on its anchor, so width changes by twice the pointer delta to keep the
  // right edge (where the handle sits) under the pointer.
  const handleResizePointerDown = useCallback((
    e: React.PointerEvent<HTMLDivElement>,
    note: Pick<LyricTextNote, 'id'>,
  ) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const el = e.currentTarget.parentElement;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    gestureRef.current = {
      kind: 'resize',
      id: note.id,
      el,
      startX: e.clientX,
      startY: e.clientY,
      startWidth: rect.width,
      startHeight: rect.height,
      width: rect.width,
      height: rect.height,
      inlineWidth: el.style.width,
      inlineMaxWidth: el.style.maxWidth,
      inlineHeight: el.style.height,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const handleResizePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>, note: Pick<LyricTextNote, 'id'>) => {
    const g = gestureRef.current;
    if (g?.kind !== 'resize' || g.id !== note.id) return;
    g.width = clampWidth(g.startWidth + (e.clientX - g.startX) * 2);
    g.height = clampHeight(g.startHeight + (e.clientY - g.startY));
    g.el.style.width = `${g.width}px`;
    g.el.style.maxWidth = 'none';
    g.el.style.height = `${g.height}px`;
    g.el.classList.add('song-text-bubble--sized');
  }, []);

  const handleResizePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>, note: Pick<LyricTextNote, 'id'>) => {
    const g = gestureRef.current;
    if (g?.kind !== 'resize' || g.id !== note.id) return;
    e.stopPropagation();
    gestureRef.current = null;
    applyPatch(note.id, { width: g.width, height: g.height });
  }, [applyPatch]);

  const handleResizePointerCancel = useCallback(() => {
    const g = gestureRef.current;
    if (g?.kind !== 'resize') return;
    g.el.style.width = g.inlineWidth;
    g.el.style.maxWidth = g.inlineMaxWidth;
    g.el.style.height = g.inlineHeight;
    g.el.classList.toggle('song-text-bubble--sized', !!g.el.style.height);
    gestureRef.current = null;
  }, []);

  const otherTextNotes = useMemo(() => notes
    .filter((n) => n.authorUid !== myAuthorUid)
    .flatMap((n) =>
      (n.textNotes ?? []).map((tn) => ({
        ...tn,
        authorUid: n.authorUid,
        authorName: n.authorName ?? null,
      }))
    ), [notes, myAuthorUid]);

  if (!visible) return null;

  return (
    <div
      ref={stageRef}
      className={`song-text-notes-overlay${typeEnabled ? ' song-text-notes-overlay--active' : ''}`}
      onClick={handleStageClick}
    >
      {/* Other users' text notes (read-only) */}
      {otherTextNotes.map((tn) => {
        const color = getUserNoteColor(tn.authorUid);
        return (
          <div
            key={`${tn.authorUid}-${tn.id}`}
            className={`song-text-bubble song-text-bubble--readonly${tn.height ? ' song-text-bubble--sized' : ''}`}
            style={{
              ...styleForAnchor(tn),
              ...sizeStyle(tn),
              '--bubble-color': color,
            } as CSSProperties}
          >
            <div className="song-text-bubble-content">{tn.text}</div>
          </div>
        );
      })}

      {/* Current user's committed text notes */}
      {myNotesVisible && myTextNotes.map((note) => {
        const isEditing = editingId === note.id;
        return (
          <div
            key={note.id}
            className={[
              'song-text-bubble',
              'song-text-bubble--mine',
              isEditing ? 'song-text-bubble--editing' : '',
              note.height ? 'song-text-bubble--sized' : '',
            ].filter(Boolean).join(' ')}
            style={{
              ...styleForAnchor(note),
              ...sizeStyle(note),
              '--bubble-color': noteColor,
            } as CSSProperties}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => handleBubblePointerDown(e, note)}
            onPointerMove={(e) => handleBubblePointerMove(e, note)}
            onPointerUp={(e) => handleBubblePointerUp(e, note)}
            onPointerCancel={handleBubblePointerCancel}
          >
            {isEditing && <div className="song-text-bubble-grip" title="Drag to move" />}
            {isEditing ? (
              <textarea
                className="song-text-bubble-input"
                autoFocus
                ref={note.height ? undefined : autosize}
                value={pendingEditText}
                onChange={(e) => {
                  setPendingEditText(e.target.value);
                  if (!note.height) autosize(e.target);
                }}
                onBlur={commitEdit}
                onKeyDown={(e) => { if (e.key === 'Escape') commitEdit(); }}
                onPointerDown={(e) => e.stopPropagation()}
              />
            ) : (
              <div className="song-text-bubble-content">{note.text}</div>
            )}
            {typeEnabled && (
              <div
                className="song-text-bubble-resize"
                onPointerDown={(e) => handleResizePointerDown(e, note)}
                onPointerMove={(e) => handleResizePointerMove(e, note)}
                onPointerUp={(e) => handleResizePointerUp(e, note)}
                onPointerCancel={handleResizePointerCancel}
                aria-label="Resize note"
                title="Resize note"
              />
            )}
            {typeEnabled && !isEditing && (
              <button
                className="song-text-bubble-delete"
                onClick={(e) => handleDeleteNote(note.id, e)}
                onPointerDown={(e) => e.stopPropagation()}
                aria-label="Delete note"
                title="Delete note"
              >
                <X size={10} />
              </button>
            )}
          </div>
        );
      })}

      {/* New bubble being typed */}
      {pendingNew && (
        <div
          className={`song-text-bubble song-text-bubble--mine song-text-bubble--editing${pendingNew.height ? ' song-text-bubble--sized' : ''}`}
          style={{
            ...styleForAnchor(pendingNew.anchor),
            ...sizeStyle(pendingNew),
            '--bubble-color': noteColor,
          } as CSSProperties}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => handleBubblePointerDown(e, { id: pendingNew.id, text: pendingNewText })}
          onPointerMove={(e) => handleBubblePointerMove(e, pendingNew)}
          onPointerUp={(e) => handleBubblePointerUp(e, { id: pendingNew.id, text: pendingNewText })}
          onPointerCancel={handleBubblePointerCancel}
        >
          <div className="song-text-bubble-grip" title="Drag to move" />
          <textarea
            className="song-text-bubble-input"
            autoFocus
            placeholder="Type a note…"
            value={pendingNewText}
            onChange={(e) => setPendingNewText(e.target.value)}
            onBlur={commitPendingNew}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { setPendingNew(null); setPendingNewText(''); }
            }}
            onPointerDown={(e) => e.stopPropagation()}
          />
          <div
            className="song-text-bubble-resize"
            onPointerDown={(e) => handleResizePointerDown(e, pendingNew)}
            onPointerMove={(e) => handleResizePointerMove(e, pendingNew)}
            onPointerUp={(e) => handleResizePointerUp(e, pendingNew)}
            onPointerCancel={handleResizePointerCancel}
            aria-label="Resize note"
            title="Resize note"
          />
        </div>
      )}
    </div>
  );
}
