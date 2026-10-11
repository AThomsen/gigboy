import { useMemo, useState } from 'react';
import { languageName } from '../utils/languages';
import {
  BPM_BUCKETS,
  EMPTY_SONG_FILTERS,
  countActiveFilters,
  getFilterOptions,
} from '../utils/songFilters';
import type { Song } from '../types';
import type { SongFilters } from '../utils/songFilters';

interface Props {
  /** Songs the chips are derived from (only values present in these songs are offered). */
  songs: Song[];
  filters: SongFilters;
  onChange: (filters: SongFilters) => void;
  /** Number of songs currently matching, shown in the footer while filters are active. */
  resultCount: number;
  id?: string;
  className?: string;
}

export default function SongFilterPanel({ songs, filters, onChange, resultCount, id, className }: Props) {
  const options = useMemo(() => getFilterOptions(songs, languageName), [songs]);
  const activeCount = countActiveFilters(filters);
  const [artistQuery, setArtistQuery] = useState('');
  const normalizedArtistQuery = artistQuery.trim().toLowerCase();
  const artistSuggestions = normalizedArtistQuery
    ? options.artists
        .filter((a) => !filters.artists.includes(a.key) && a.key.includes(normalizedArtistQuery))
        .slice(0, 6)
    : [];
  const selectedArtists = filters.artists.map((key) => options.artists.find((a) => a.key === key)?.label ?? key);

  function addArtist(key: string) {
    onChange({ ...filters, artists: [...filters.artists, key] });
    setArtistQuery('');
  }

  function toggle(group: keyof SongFilters, value: string) {
    const current = filters[group];
    onChange({
      ...filters,
      [group]: current.includes(value) ? current.filter((v) => v !== value) : [...current, value],
    });
  }

  return (
    <div className={`song-filter-panel${className ? ` ${className}` : ''}`} id={id}>
      {options.languages.length > 1 && (
        <div className="song-filter-group">
          <span className="song-filter-label">Language</span>
          {options.languages.map((code) => (
            <button
              key={code}
              type="button"
              className="song-filter-chip"
              aria-pressed={filters.languages.includes(code)}
              onClick={() => toggle('languages', code)}
            >
              {languageName(code)}
            </button>
          ))}
        </div>
      )}
      {options.keys.length > 0 && (
        <div className="song-filter-group">
          <span className="song-filter-label">Key</span>
          {options.keys.map((key) => (
            <button
              key={key}
              type="button"
              className="song-filter-chip"
              aria-pressed={filters.keys.includes(key)}
              onClick={() => toggle('keys', key)}
            >
              {key}
            </button>
          ))}
        </div>
      )}
      {options.hasTempo && (
        <div className="song-filter-group">
          <span className="song-filter-label">BPM</span>
          {BPM_BUCKETS.map((bucket) => (
            <button
              key={bucket.id}
              type="button"
              className="song-filter-chip"
              aria-pressed={filters.bpm.includes(bucket.id)}
              onClick={() => toggle('bpm', bucket.id)}
            >
              {bucket.label}
            </button>
          ))}
        </div>
      )}
      {options.artists.length > 1 && (
        <div className="song-filter-group">
          <span className="song-filter-label">Artist</span>
          {filters.artists.map((key, i) => (
            <button
              key={key}
              type="button"
              className="song-filter-chip"
              aria-pressed={true}
              onClick={() => toggle('artists', key)}
            >
              {selectedArtists[i]}
            </button>
          ))}
          <input
            type="search"
            className="song-filter-artist-input"
            placeholder="Find artist…"
            aria-label="Find artist"
            value={artistQuery}
            onChange={(e) => setArtistQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && artistSuggestions.length > 0) {
                e.preventDefault();
                addArtist(artistSuggestions[0].key);
              }
            }}
          />
          {artistSuggestions.map((a) => (
            <button key={a.key} type="button" className="song-filter-chip" aria-pressed={false} onClick={() => addArtist(a.key)}>
              {a.label} <span className="song-filter-chip-count">{a.count}</span>
            </button>
          ))}
        </div>
      )}
      {activeCount > 0 && (
        <div className="song-filter-footer">
          <span>
            {resultCount} of {songs.length} songs
            {filters.keys.length > 0 || filters.bpm.length > 0 ? ' · songs without key/BPM are hidden' : ''}
          </span>
          <button type="button" className="song-filter-clear" onClick={() => onChange(EMPTY_SONG_FILTERS)}>
            Clear all
          </button>
        </div>
      )}
    </div>
  );
}
