/**
 * Single chord grammar shared by the paste importer and the ChordPro renderer, so a chord
 * recognised in one place is never rejected in the other.
 *
 * root [#b♯♭]? · suffix atoms (quality, extensions, alterations, "(b9)", "6/9"…) · optional /bass
 * Also accepts the "no chord" marker (N.C. / NC).
 */

const ROOT = '[A-G](?:#|b|♯|♭)?';
const ATOM = '(?:maj|min|dim|aug|sus|add|no|m|M|Δ|△|°|º|ø|\\+|-|(?:#|b|♯|♭)?\\d+|\\/\\d+|\\([^()\\s]{1,8}\\))';
const BASS = '(?:\\/[A-G](?:#|b|♯|♭)?)';

export const CHORD_SOURCE = `(?:${ROOT}${ATOM}{0,6}${BASS}?|N\\.C\\.|NC)`;

/** Whole string is a single chord. */
export const CHORD_TOKEN_RE = new RegExp(`^${CHORD_SOURCE}$`);
/** Finds chords inside a line; boundaries stop it matching the start of ordinary words. */
export const CHORD_SCAN_RE = new RegExp(`(?<![A-Za-z0-9#♯♭/])${CHORD_SOURCE}(?![A-Za-z0-9#♯♭])`, 'g');

/** Rewrites Unicode/alternative symbols into the ASCII spellings the rest of the app understands. */
export function normalizeChordSymbols(chord: string): string {
  return chord
    .replace(/♯/g, '#')
    .replace(/♭/g, 'b')
    .replace(/[Δ△]/g, 'maj')
    .replace(/ø7?/g, 'm7b5')
    .replace(/[°º]/g, 'dim');
}
