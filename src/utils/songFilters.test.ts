import { describe, expect, it } from 'vitest';
import {
  EMPTY_SONG_FILTERS,
  getFilterOptions,
  matchesSongFilters,
  parseArtistUsage,
  parseStoredFilters,
  pickQuickArtists,
} from './songFilters';
import type { Song } from '../types';

const song = (artist?: string) => ({ id: artist ?? 'x', title: 't', artist }) as Song;

describe('artist filters', () => {
  it('matches case/whitespace-insensitively', () => {
    const f = { ...EMPTY_SONG_FILTERS, artists: ['metallica'] };
    expect(matchesSongFilters(song(' Metallica '), f)).toBe(true);
    expect(matchesSongFilters(song('Slayer'), f)).toBe(false);
    expect(matchesSongFilters(song(undefined), f)).toBe(false);
  });

  it('merges artist spellings and sorts by song count', () => {
    const { artists } = getFilterOptions([song('Slayer'), song('Metallica'), song('metallica ')]);
    expect(artists.map((a) => [a.key, a.count])).toEqual([['metallica', 2], ['slayer', 1]]);
  });

  it('parses legacy stored filters without artists', () => {
    expect(parseStoredFilters('{"keys":["C"]}').artists).toEqual([]);
  });

  it('puts used artists first, then pads by song count', () => {
    const { artists } = getFilterOptions([song('A'), song('A'), song('B'), song('C')]);
    expect(pickQuickArtists(artists, { c: 3 }, 2).map((a) => a.key)).toEqual(['c', 'a']);
    expect(pickQuickArtists(artists, {}, 2).map((a) => a.key)).toEqual(['a', 'b']);
  });

  it('ignores malformed usage', () => {
    expect(parseArtistUsage('[1]')).toEqual({});
    expect(parseArtistUsage('{"a":2,"b":"x"}')).toEqual({ a: 2 });
  });
});

describe('has filters', () => {
  const withTab = { id: 'a', title: 't', chordpro: '{start_of_tab}\ne|--0--|\n{end_of_tab}' } as Song;
  const plain = { id: 'b', title: 't', chordpro: '[C]hi' } as Song;
  const counts = { b: { notes: 0, attachments: 2, recordings: 1 } };

  it('detects tabs from the song and the rest from badge counts', () => {
    expect(matchesSongFilters(withTab, { ...EMPTY_SONG_FILTERS, has: ['tabs'] })).toBe(true);
    expect(matchesSongFilters(plain, { ...EMPTY_SONG_FILTERS, has: ['tabs'] })).toBe(false);
    expect(matchesSongFilters(plain, { ...EMPTY_SONG_FILTERS, has: ['recordings', 'attachments'] }, counts)).toBe(true);
    expect(matchesSongFilters(plain, { ...EMPTY_SONG_FILTERS, has: ['notes'] }, counts)).toBe(false);
    expect(matchesSongFilters(plain, { ...EMPTY_SONG_FILTERS, has: ['notes'] })).toBe(false);
  });

  it('drops unknown stored has values', () => {
    expect(parseStoredFilters('{"has":["tabs","bogus"]}').has).toEqual(['tabs']);
  });
});

describe('duration filters', () => {
  const d = (durationSeconds?: number) => ({ id: 'x', title: 't', durationSeconds }) as Song;
  const f = { ...EMPTY_SONG_FILTERS, duration: ['medium'] };
  it('buckets by length and hides songs without one', () => {
    expect(matchesSongFilters(d(240), f)).toBe(true);
    expect(matchesSongFilters(d(300), f)).toBe(false);
    expect(matchesSongFilters(d(undefined), f)).toBe(false);
  });
});
