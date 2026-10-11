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
