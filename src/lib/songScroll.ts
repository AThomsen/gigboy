import { isDemoMode } from './demo/demoMode';
import * as demoStore from './demo/demoStore';

/**
 * A song's autoscroll time, shared by the band: `PUT /api/bands/:bandId/songs/:songId/scroll`
 * (see server/routes/songScroll.ts). Editors only; not a song edit, so no revision.
 */
export const SCROLL_SECONDS_MIN = 10;
export const SCROLL_SECONDS_MAX = 1800;

export function clampScrollSeconds(seconds: number): number {
  return Math.max(SCROLL_SECONDS_MIN, Math.min(SCROLL_SECONDS_MAX, Math.round(seconds)));
}

export async function saveSongScrollSeconds(bandId: string, songId: string, scrollSeconds: number): Promise<number> {
  const value = clampScrollSeconds(scrollSeconds);
  if (isDemoMode) return demoStore.setSongScrollSeconds(bandId, songId, value);
  const response = await fetch(`/api/bands/${bandId}/songs/${songId}/scroll`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scrollSeconds: value }),
  });
  if (!response.ok) {
    let message = `Request failed with status ${response.status}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      // not JSON
    }
    throw new Error(message);
  }
  const data = (await response.json()) as { scrollSeconds: number };
  return data.scrollSeconds;
}
