import { X } from 'lucide-react';
import { languageName } from '../utils/languages';
import { BPM_BUCKETS } from '../utils/songFilters';
import type { ArtistOption, SongFilters } from '../utils/songFilters';

interface Props {
  filters: SongFilters;
  onChange: (filters: SongFilters) => void;
  /** Every artist in the list, used to show real names for the active artist chips. */
  artistOptions: ArtistOption[];
  /** Artists offered as one-tap chips. */
  quickArtists: ArtistOption[];
  /** Hide the active-filter chips (the open panel already shows them). */
  hideActive?: boolean;
}

type Group = keyof SongFilters;

/** Always-visible row: removable active filters, then one-tap chips for frequent artists. */
export default function SongFilterBar({ filters, onChange, artistOptions, quickArtists, hideActive }: Props) {
  const artistLabel = (key: string) => artistOptions.find((a) => a.key === key)?.label ?? key;

  const active: { group: Group; value: string; label: string }[] = hideActive
    ? []
    : [
        ...filters.languages.map((v) => ({ group: 'languages' as const, value: v, label: languageName(v) })),
        ...filters.keys.map((v) => ({ group: 'keys' as const, value: v, label: v })),
        ...filters.bpm.map((v) => ({ group: 'bpm' as const, value: v, label: BPM_BUCKETS.find((b) => b.id === v)?.label ?? v })),
        ...filters.artists.map((v) => ({ group: 'artists' as const, value: v, label: artistLabel(v) })),
      ];
  const quick = quickArtists.filter((a) => !filters.artists.includes(a.key));

  if (active.length === 0 && quick.length === 0) return null;

  function remove(group: Group, value: string) {
    onChange({ ...filters, [group]: filters[group].filter((v) => v !== value) });
  }

  return (
    <div className="song-filter-bar" role="group" aria-label="Quick filters">
      {active.map(({ group, value, label }) => (
        <button
          key={`${group}:${value}`}
          type="button"
          className="song-filter-chip song-filter-chip--active"
          onClick={() => remove(group, value)}
          aria-label={`Remove filter ${label}`}
        >
          {label}
          <X size={12} aria-hidden="true" />
        </button>
      ))}
      {quick.map((artist) => (
        <button
          key={artist.key}
          type="button"
          className="song-filter-chip"
          aria-pressed={false}
          onClick={() => onChange({ ...filters, artists: [...filters.artists, artist.key] })}
        >
          {artist.label}
        </button>
      ))}
    </div>
  );
}
