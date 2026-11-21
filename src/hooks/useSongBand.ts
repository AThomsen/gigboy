import { useLocation } from 'react-router-dom';
import { useBands } from '../context/BandsContext';
import type { Song } from '../types';

type SongRouteState = { bandId?: string } | null;

/**
 * Resolves which band a song route belongs to: router state, then `?bandId=`,
 * then whichever loaded band library contains the song. A direct link carries
 * neither state nor query, so the band can only be inferred once the libraries
 * have loaded — `loading` stays true until then so pages don't redirect early.
 */
export function useSongBand(songId: string | undefined): {
  bandId: string | null;
  song: Song | null;
  loading: boolean;
} {
  const location = useLocation();
  const { bands, bandSongsByBandId, loading: bandsLoading } = useBands();
  const pageState = location.state as SongRouteState;
  const bandIdFromQuery = new URLSearchParams(location.search).get('bandId')?.trim() || null;

  const inferredBandId = songId
    ? (Object.entries(bandSongsByBandId).find(([, songs]) => songs.some((s) => s.id === songId))?.[0] ?? null)
    : null;
  const bandId = pageState?.bandId ?? bandIdFromQuery ?? inferredBandId ?? null;
  const song = bandId ? ((bandSongsByBandId[bandId] ?? []).find((s) => s.id === songId) ?? null) : null;

  const librariesLoading = bandsLoading
    || (bandId ? bandSongsByBandId[bandId] === undefined : bands.some((b) => bandSongsByBandId[b.id] === undefined));

  return { bandId, song, loading: !song && librariesLoading };
}
