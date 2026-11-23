import { isDemoMode } from './demo/demoMode';
import * as demoStore from './demo/demoStore';

/** One stem of a song: a time-aligned audio file played in the multitrack player. */
export interface SongStem {
  id: string;
  /** Stem key, e.g. `vocals`, `drums`, `click`. */
  name: string;
  downloadUrl: string;
  durationMs: number;
  sizeBytes: number;
  mimeType: string;
  sortOrder: number;
  createdAt: string;
  waveformBars?: number[];
}

export interface StemUploadMeta {
  durationMs: number;
  waveformBars?: number[];
  sortOrder: number;
}

/**
 * Song stems, talking to `/api/bands/:bandId/songs/:songId/stems`
 * (see server/routes/songStems.ts).
 */
function stemsUrl(bandId: string, songId: string): string {
  return `/api/bands/${bandId}/songs/${songId}/stems`;
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, credentials: 'include' });
  if (!response.ok) {
    let message = `Request failed with status ${response.status}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      // Response wasn't JSON (e.g. a proxy's 413 page); fall back to the generic message.
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export async function loadSongStems(bandId: string, songId: string): Promise<SongStem[]> {
  if (isDemoMode) return demoStore.delay(demoStore.listStems(bandId, songId));
  const data = await apiFetch<{ stems: SongStem[] }>(stemsUrl(bandId, songId));
  return data.stems ?? [];
}

/** Uploads (or replaces) one stem by name. */
export async function uploadSongStem(
  bandId: string,
  songId: string,
  name: string,
  file: File,
  meta: StemUploadMeta,
): Promise<SongStem> {
  if (isDemoMode) return demoStore.delay(demoStore.putStem(bandId, songId, name, file, meta));
  const formData = new FormData();
  formData.append('durationMs', String(Math.round(meta.durationMs)));
  formData.append('sortOrder', String(meta.sortOrder));
  if (meta.waveformBars?.length) formData.append('waveformBars', JSON.stringify(meta.waveformBars));
  formData.append('file', file, file.name);
  const data = await apiFetch<{ stem: SongStem }>(`${stemsUrl(bandId, songId)}/${encodeURIComponent(name)}`, {
    method: 'PUT',
    body: formData,
  });
  return data.stem;
}

export async function deleteSongStem(bandId: string, songId: string, stem: SongStem): Promise<void> {
  if (isDemoMode) {
    await demoStore.delay(demoStore.removeStem(bandId, songId, stem.id));
    return;
  }
  await apiFetch(`${stemsUrl(bandId, songId)}/${stem.id}`, { method: 'DELETE' });
}

export async function deleteAllSongStems(bandId: string, songId: string): Promise<void> {
  if (isDemoMode) {
    await demoStore.delay(demoStore.removeAllStems(bandId, songId));
    return;
  }
  await apiFetch(stemsUrl(bandId, songId), { method: 'DELETE' });
}
