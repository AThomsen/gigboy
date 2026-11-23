import { useMemo } from 'react';
import { parseChordPro, lineHasChords, transposeChord, convertChordNotation } from '../utils/chordParser';
import type { ChordNotation } from '../utils/chordParser';
import type { ParsedLine } from '../types';
import type { DiagramInstrument } from './ChordDiagram';
import TabDisplay from './TabDisplay';
import StrumDisplay from './StrumDisplay';
import { uniqueChords } from '../utils/strumParser';
import { describePause, parsePause } from '../utils/scrollPause';
import { Pause } from 'lucide-react';

/**
 * Identifies exactly which chord instance was clicked, so a rename can rewrite that one
 * occurrence in the song's chordpro source (via `replaceChordOccurrence`) instead of every
 * chord sharing the same name. `sourceLine` is the raw line index from `parseChordPro`;
 * `occurrenceIndex` counts chord-bearing segments before it on that line.
 */
export interface ChordOccurrence {
  sourceLine: number;
  occurrenceIndex: number;
}

interface Props {
  chordpro: string;
  transpose?: number;
  showChords?: boolean;
  /**
   * Show the lyrics. Off leaves a chord chart: each line's chords in a row, with lines that
   * have no chords left out. (Off together with showChords off shows lyrics anyway.)
   */
  showLyrics?: boolean;
  notation?: ChordNotation;
  bpm?: number;
  timeSignature?: string;
  instrument?: DiagramInstrument;
  onChordClick?: (chord: string, rect: DOMRect, element: HTMLElement, occurrence: ChordOccurrence) => void;
  /**
   * Ids of lines that have a note anchored somewhere on them. These lines are kept from
   * wrapping (and scroll horizontally instead) so a hand-drawn note anchored across several
   * words on the line stays a single straight shape instead of bending across two rows.
   */
  pinnedLineIds?: Set<number>;
  /**
   * Hide {title}/{subtitle}/{artist} directive lines. Callers that already show the song's
   * title/artist elsewhere (e.g. concert mode's header) pass this so the chordpro body
   * doesn't waste page space repeating them above the actual lyrics.
   */
  hideMetaDirectives?: boolean;
}

export default function ChordDisplay({
  chordpro,
  transpose = 0,
  showChords = true,
  showLyrics: showLyricsProp = true,
  notation = 'anglo',
  bpm,
  timeSignature,
  onChordClick,
  pinnedLineIds,
  hideMetaDirectives = false,
}: Props) {
  const lines = useMemo(() => assignLineIds(parseChordPro(chordpro)), [chordpro]);
  const strumChords = useMemo(() => uniqueChords(chordpro), [chordpro]);
  const showLyrics = showLyricsProp || !showChords;
  const modeClass = !showLyrics ? ' chord-display--chords-only' : !showChords ? ' chord-display--lyrics-only' : '';

  return (
    <div className={`chord-display${modeClass}`}>
      {lines.map((line, i) => (
        <LineRenderer
          key={i}
          line={line}
          transpose={transpose}
          showChords={showChords}
          showLyrics={showLyrics}
          notation={notation}
          bpm={bpm}
          timeSignature={timeSignature}
          strumChords={strumChords}
          onChordClick={onChordClick}
          pinnedLineIds={pinnedLineIds}
          hideMetaDirectives={hideMetaDirectives}
        />
      ))}
    </div>
  );
}

/**
 * Assigns a stable, sequential `lineId` to every positionable line (chord-lyric/empty),
 * in render order including lines nested inside sections. Hand-drawn/text notes anchor
 * to this id so they stay pinned to their lyric line when the layout reflows.
 */
function assignLineIds(lines: ParsedLine[]): ParsedLine[] {
  let counter = 0;
  const assign = (list: ParsedLine[]): ParsedLine[] =>
    list.map((line) => {
      const positioned: ParsedLine = { ...line };
      if (line.type === 'chord-lyric' || line.type === 'empty') {
        positioned.lineId = counter++;
      }
      if (line.sectionLines) {
        positioned.sectionLines = assign(line.sectionLines);
      }
      return positioned;
    });
  return assign(lines);
}

const METADATA_DIRECTIVES = new Set(['key', 'capo', 'tempo', 'time', 'duration']);

const SECTION_LABELS: Record<string, string> = {
  verse: 'Verse',
  chorus: 'Chorus',
  intro: 'Intro',
  bridge: 'Bridge',
  pre_chorus: 'Pre-Chorus',
  interlude: 'Interlude',
  solo: 'Solo',
  outro: 'Outro',
};

interface LineRendererProps {
  line: ParsedLine;
  transpose: number;
  showChords: boolean;
  showLyrics: boolean;
  notation: ChordNotation;
  bpm?: number;
  timeSignature?: string;
  strumChords?: string[];
  onChordClick?: (chord: string, rect: DOMRect, element: HTMLElement, occurrence: ChordOccurrence) => void;
  pinnedLineIds?: Set<number>;
  hideMetaDirectives?: boolean;
}

function LineRenderer({
  line,
  transpose,
  showChords,
  showLyrics,
  notation,
  bpm,
  timeSignature,
  strumChords,
  onChordClick,
  pinnedLineIds,
  hideMetaDirectives,
}: LineRendererProps) {
  if (line.type === 'empty') {
    return <div className="chord-line chord-line--empty" data-line-id={line.lineId} />;
  }

  // Tabs and strumming patterns are for whoever plays the chords.
  if (line.type === 'tab') {
    if (!showChords) return null;
    return (
      <TabDisplay
        tabLines={line.tabLines ?? []}
        transpose={transpose}
        bpm={bpm}
        timeSignature={timeSignature}
      />
    );
  }

  if (line.type === 'strum') {
    if (!showChords) return null;
    return (
      <StrumDisplay
        strumLines={line.strumLines ?? []}
        label={line.strumLabel}
        chords={strumChords}
        transpose={transpose}
        bpm={bpm}
        timeSignature={timeSignature}
      />
    );
  }

  if (line.type === 'section') {
    const label = line.sectionLabel || SECTION_LABELS[line.sectionType ?? ''] || line.sectionType || '';
    return (
      <div className={`chord-section chord-section--${line.sectionType}`}>
        {label && <div className="section-label">{label}</div>}
        {line.sectionLines?.map((subline, j) => (
          <LineRenderer
            key={j}
            line={subline}
            transpose={transpose}
            showChords={showChords}
            showLyrics={showLyrics}
            notation={notation}
            bpm={bpm}
            timeSignature={timeSignature}
            strumChords={strumChords}
            onChordClick={onChordClick}
            pinnedLineIds={pinnedLineIds}
            hideMetaDirectives={hideMetaDirectives}
          />
        ))}
      </div>
    );
  }

  if (line.type === 'directive') {
    const dir = line.directive!;
    if (dir === 'title') return hideMetaDirectives ? null : <h2 className="song-title-directive">{line.directiveValue}</h2>;
    if (dir === 'subtitle' || dir === 'artist')
      return hideMetaDirectives ? null : <p className="song-subtitle-directive">{line.directiveValue}</p>;
    // Scroll pause ({pause: 16 bars, Solo}). Concert Mode's autoscroll finds these by the
    // data attribute (its value is the raw directive value) and holds still there.
    if (dir === 'pause') {
      return (
        <div className="scroll-pause-marker" data-scroll-pause={line.directiveValue ?? ''}>
          <Pause size={12} aria-hidden /> {describePause(parsePause(line.directiveValue))}
        </div>
      );
    }
    // Short-form section labels (e.g. {chorus} without start/end)
    if (dir === 'chorus') return <div className="section-label">Chorus</div>;
    if (dir === 'intro') return <div className="section-label">Intro</div>;
    if (dir === 'verse') return <div className="section-label">Verse</div>;
    if (dir === 'bridge') return <div className="section-label">Bridge</div>;
    if (dir === 'interlude') return <div className="section-label">Interlude</div>;
    if (dir === 'solo') return <div className="section-label">Solo</div>;
    if (dir === 'outro') return <div className="section-label">Outro</div>;
    // Pure metadata directives (key, tempo, capo, etc.) are already surfaced via the
    // song's own fields/toolbar — don't dump their raw value as a stray, unlabeled line.
    if (METADATA_DIRECTIVES.has(dir)) return null;
    if (line.directiveValue) return <div className="section-label">{line.directiveValue}</div>;
    return null;
  }

  // Chord-lyric line
  const segments = line.segments ?? [];
  const hasChords = showChords && lineHasChords(line);
  const isChordOnly = hasChords && (!showLyrics || segments.every(seg => !seg.lyric.trim()));
  // Nothing to show on this line: lyrics without chords in a chord chart, or a chords-only
  // line (an intro riff, say) with chords hidden.
  if (showLyrics ? !showChords && lineHasChords(line) && segments.every(seg => !seg.lyric.trim()) : !hasChords) {
    return null;
  }
  const isPinned = line.lineId !== undefined && pinnedLineIds?.has(line.lineId);

  return (
    <div
      className={`chord-line ${hasChords ? 'chord-line--has-chords' : ''} ${isChordOnly ? 'chord-line--chord-only' : ''} ${isPinned ? 'chord-line--pinned' : ''}`}
      data-line-id={line.lineId}
    >
      {(() => {
        let chordOccurrenceIndex = 0;
        return segments.map((seg, idx) => {
          const occurrenceIndex = chordOccurrenceIndex;
          if (seg.chord) chordOccurrenceIndex++;
          // A chord chart lists just the chords, without the room their lyrics took.
          if (!showLyrics && !seg.chord) return null;
          return (
            <span key={idx} className="chord-segment">
              {hasChords && (
                <span className="chord-name">
                  {seg.chord ? (
                    onChordClick ? (
                      <button
                        className="chord-name-btn"
                        onClick={(e) => {
                          const el = e.currentTarget as HTMLElement;
                          onChordClick(transposeChord(seg.chord, transpose), el.getBoundingClientRect(), el, {
                            sourceLine: line.sourceLine ?? -1,
                            occurrenceIndex,
                          });
                        }}
                      >
                        {convertChordNotation(transposeChord(seg.chord, transpose), notation)}
                      </button>
                    ) : (
                      convertChordNotation(transposeChord(seg.chord, transpose), notation)
                    )
                  ) : (
                    <>&nbsp;</>
                  )}
                </span>
              )}
              {showLyrics && (
                <span className="lyric-text">{seg.lyric || (showChords && seg.chord ? ' ' : '')}</span>
              )}
            </span>
          );
        });
      })()}
    </div>
  );
}
