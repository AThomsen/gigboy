import { useEffect, useRef, useState } from 'react';
import type { Song } from '../types';

export interface SongBadgeCounts {
  notes: number;
  attachments: number;
  recordings: number;
}

const BATCH_SIZE = 100;

interface SongBadgesResponse {
  badges: Record<string, SongBadgeCounts>;
}

/**
 * Best-effort badge counts (notes/attachments/recordings) for songs shown in a list.
 * Self-host implementation: batches every not-yet-fetched song id into one call to
 * `GET /api/song-badges` (see server/routes/songBadges.ts) instead of running a Firestore
 * count-aggregation query per song per subcollection.
 */
export function useSongListBadges(songs: Song[], bandId: string | undefined, currentUserId: string | undefined) {
  const [counts, setCounts] = useState<Record<string, SongBadgeCounts>>({});
  const fetchedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const pendingSongIds = songs
      .filter((song) => {
        if (!bandId && !currentUserId) return false;
        return !fetchedRef.current.has(song.id);
      })
      .map((song) => song.id);

    if (pendingSongIds.length === 0) return;
    pendingSongIds.forEach((id) => fetchedRef.current.add(id));

    // Chunked so a large library doesn't overflow the query-string length limit.
    for (let i = 0; i < pendingSongIds.length; i += BATCH_SIZE) {
      const chunk = pendingSongIds.slice(i, i + BATCH_SIZE);
      const params = new URLSearchParams({ songIds: chunk.join(',') });
      fetch(`/api/song-badges?${params.toString()}`, { credentials: 'include' })
        .then((response) => {
          if (!response.ok) throw new Error(`Request failed with status ${response.status}`);
          return response.json() as Promise<SongBadgesResponse>;
        })
        .then((data) => {
          setCounts((prev) => ({ ...prev, ...(data.badges ?? {}) }));
        })
        .catch(() => {
          // Badges are best-effort — leave these songs without counts on failure, but allow retry.
          chunk.forEach((id) => fetchedRef.current.delete(id));
        });
    }
  }, [songs, bandId, currentUserId]);

  return counts;
}
