import type { Song } from '../types';

export interface BpmBucket {
  id: string;
  label: string;
  min: number;
  max: number;
}

export const BPM_BUCKETS: BpmBucket[] = [
  { id: 'slow', label: 'Slow · <80', min: 0, max: 80 },
  { id: 'mid', label: 'Mid · 80–109', min: 80, max: 110 },
  { id: 'upbeat', label: 'Upbeat · 110–139', min: 110, max: 140 },
  { id: 'fast', label: 'Fast · 140+', min: 140, max: Infinity },
];

const NOTE_ORDER = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_TO_SHARP: Record<string, string> = { Db: 'C#', Eb: 'D#', Gb: 'F#', Ab: 'G#', Bb: 'A#' };

/** Normalizes free-text keys ("Bb", "a minor", "F#m") to "A#", "Am", "F#m". Returns undefined if unparseable. */
export function normalizeKey(raw?: string): string | undefined {
  if (!raw) return undefined;
  const match = raw.trim().match(/^([A-Ga-g])\s*([#b♯♭]?)\s*(.*)$/);
  if (!match) return undefined;
  const accidental = match[2] === '♯' ? '#' : match[2] === '♭' ? 'b' : match[2];
  let root = match[1].toUpperCase() + accidental;
  root = FLAT_TO_SHARP[root] ?? root;
  if (!NOTE_ORDER.includes(root)) return undefined;
  const quality = match[3].trim().toLowerCase();
  const isMinor = /^(m|min|minor|-)(?!aj)/.test(quality) && !quality.startsWith('maj');
  return isMinor ? `${root}m` : root;
}

/** Musical sort order: C, Cm, C#, C#m, D … */
export function compareKeys(a: string, b: string): number {
  const rootA = NOTE_ORDER.indexOf(a.replace(/m$/, ''));
  const rootB = NOTE_ORDER.indexOf(b.replace(/m$/, ''));
  return rootA - rootB || Number(a.endsWith('m')) - Number(b.endsWith('m'));
}

export function songLanguages(song: Song): string[] {
  return [song.language, ...(song.secondaryLanguages ?? [])].filter(Boolean);
}

/** Case/whitespace-insensitive artist identity, so "Metallica " and "metallica" are one filter value. */
export function normalizeArtist(raw?: string): string | undefined {
  const key = raw?.trim().replace(/\s+/g, ' ').toLowerCase();
  return key || undefined;
}

export interface SongFilters {
  languages: string[];
  keys: string[];
  bpm: string[];
  /** Normalized artist keys (see normalizeArtist). */
  artists: string[];
}

export const EMPTY_SONG_FILTERS: SongFilters = { languages: [], keys: [], bpm: [], artists: [] };

export function countActiveFilters(filters: SongFilters): number {
  return filters.languages.length + filters.keys.length + filters.bpm.length + filters.artists.length;
}

/** AND across filter groups, OR within a group. */
export function matchesSongFilters(song: Song, filters: SongFilters): boolean {
  if (filters.languages.length > 0 && !songLanguages(song).some((l) => filters.languages.includes(l))) {
    return false;
  }
  if (filters.keys.length > 0) {
    const key = normalizeKey(song.key);
    if (!key || !filters.keys.includes(key)) return false;
  }
  if (filters.bpm.length > 0) {
    const tempo = song.tempo;
    if (!tempo) return false;
    const inBucket = BPM_BUCKETS.some((b) => filters.bpm.includes(b.id) && tempo >= b.min && tempo < b.max);
    if (!inBucket) return false;
  }
  if (filters.artists.length > 0) {
    const artist = normalizeArtist(song.artist);
    if (!artist || !filters.artists.includes(artist)) return false;
  }
  return true;
}

/** Parses persisted filters defensively; anything malformed falls back to no filters. */
export function parseStoredFilters(raw: string | null): SongFilters {
  if (!raw) return EMPTY_SONG_FILTERS;
  try {
    const parsed = JSON.parse(raw) as Partial<SongFilters>;
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    return {
      languages: strings(parsed.languages),
      keys: strings(parsed.keys),
      bpm: strings(parsed.bpm),
      artists: strings(parsed.artists),
    };
  } catch {
    return EMPTY_SONG_FILTERS;
  }
}

export interface ArtistOption {
  key: string;
  label: string;
  count: number;
  /** Timestamp (ms) of the artist's most recently added song; 0 when unknown. */
  latest: number;
}

export interface SongFilterOptions {
  languages: string[];
  keys: string[];
  hasTempo: boolean;
  /** Most songs first, then A → Z. */
  artists: ArtistOption[];
}

/** Options for the filter chips, derived from the songs actually in the list. */
export function getFilterOptions(songs: Song[], languageLabel: (code: string) => string = (c) => c): SongFilterOptions {
  const languages = [...new Set(songs.flatMap(songLanguages))].sort((a, b) => languageLabel(a).localeCompare(languageLabel(b)));
  const keys = [...new Set(songs.map((s) => normalizeKey(s.key)).filter((k): k is string => Boolean(k)))].sort(compareKeys);
  const byArtist = new Map<string, ArtistOption>();
  for (const song of songs) {
    const key = normalizeArtist(song.artist);
    if (!key) continue;
    const existing = byArtist.get(key);
    const added = Date.parse(song.createdAt ?? '') || 0;
    if (existing) {
      existing.count += 1;
      existing.latest = Math.max(existing.latest, added);
    } else byArtist.set(key, { key, label: song.artist!.trim(), count: 1, latest: added });
  }
  const artists = [...byArtist.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  return { languages, keys, hasTempo: songs.some((s) => s.tempo), artists };
}

/** How often each artist key has been filtered/searched for in a list. */
export type ArtistUsage = Record<string, number>;

export function parseArtistUsage(raw: string | null): ArtistUsage {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([, v]) => typeof v === 'number' && Number.isFinite(v) && v > 0)
    ) as ArtistUsage;
  } catch {
    return {};
  }
}

/**
 * Artists for the quick-filter row: used artists first (most used), then artists with the most
 * recently added songs, then the rest by song count, so a list with no history still gets a full row.
 */
export function pickQuickArtists(artists: ArtistOption[], usage: ArtistUsage, limit = 12): ArtistOption[] {
  const used = artists
    .filter((a) => (usage[a.key] ?? 0) > 0)
    .sort((a, b) => usage[b.key] - usage[a.key] || b.count - a.count || a.label.localeCompare(b.label));
  const usedKeys = new Set(used.map((a) => a.key));
  const rest = artists
    .filter((a) => !usedKeys.has(a.key))
    .sort((a, b) => b.latest - a.latest || b.count - a.count || a.label.localeCompare(b.label));
  return [...used, ...rest].slice(0, limit);
}
