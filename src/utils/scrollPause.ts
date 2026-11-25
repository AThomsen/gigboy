/**
 * Scroll holds: `{hold: 16 bars, Guitar solo}` in a chart holds Concert Mode's autoscroll still
 * for that long (code calls them pauses). Called "hold" in charts, not "pause", which would read
 * as the band pausing. Forms (case-insensitive):
 *   {hold: 16 bars} / {hold: 16}  bars (a bare number is bars)
 *   {hold: 20s}                   seconds ("20 sec", "20 seconds" too)
 *   {hold}                        until tapped
 * Anything after a comma is a label: {hold: 16 bars, Guitar solo}.
 */
export const SCROLL_HOLD_DIRECTIVE = 'hold';

export interface ScrollPause {
  bars?: number;
  seconds?: number;
  label?: string;
}

const AMOUNT_RE = /^(\d+(?:\.\d+)?)\s*(bars?|s|secs?|seconds?)?$/i;

export function parsePause(value: string | undefined): ScrollPause {
  const text = (value ?? '').trim();
  if (!text) return {};
  const comma = text.indexOf(',');
  const head = (comma === -1 ? text : text.slice(0, comma)).trim();
  const tail = comma === -1 ? '' : text.slice(comma + 1).trim();
  const match = head.match(AMOUNT_RE);
  if (!match) {
    // No amount, just words ("{hold: Drum break}"): an untimed pause with that label.
    return { label: text };
  }
  const amount = Number(match[1]);
  const unit = (match[2] ?? 'bars').toLowerCase();
  const pause: ScrollPause = unit.startsWith('bar') ? { bars: amount } : { seconds: amount };
  if (tail) pause.label = tail;
  return pause;
}

/** Beats per bar from a time signature like "3/4" or "6/8"; 4 when unknown. */
export function beatsPerBar(timeSignature: string | undefined): number {
  const match = timeSignature?.match(/^\s*(\d+)\s*\/\s*\d+\s*$/);
  const beats = match ? Number(match[1]) : NaN;
  return Number.isFinite(beats) && beats > 0 ? beats : 4;
}

/** How long a pause lasts, or null when it waits for a tap (untimed, or bars without a tempo). */
export function pauseSeconds(pause: ScrollPause, tempo: number | undefined, timeSignature: string | undefined): number | null {
  if (pause.seconds !== undefined) return pause.seconds > 0 ? pause.seconds : null;
  if (pause.bars === undefined || pause.bars <= 0 || !tempo || tempo <= 0) return null;
  return (pause.bars * beatsPerBar(timeSignature) * 60) / tempo;
}

/** The marker's text in a chart, e.g. "Guitar solo · 16 bars", "Hold · 20 s", "Hold". */
export function describePause(pause: ScrollPause): string {
  const amount = pause.bars !== undefined
    ? `${pause.bars} bar${pause.bars === 1 ? '' : 's'}`
    : pause.seconds !== undefined ? `${pause.seconds} s` : '';
  return [pause.label ?? 'Hold', amount].filter(Boolean).join(' · ');
}
