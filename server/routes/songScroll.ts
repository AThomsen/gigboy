import { Router } from 'express';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { songs } from '../db/schema.js';
import { requireAuth } from '../middleware/session.js';
import { requireBandEditor } from '../middleware/bandAccess.js';
import { loadBandSongScope } from '../lib/songScope.js';

export const SCROLL_SECONDS_MIN = 10;
export const SCROLL_SECONDS_MAX = 1800;

function parseScrollSeconds(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(SCROLL_SECONDS_MIN, Math.min(SCROLL_SECONDS_MAX, Math.round(n)));
}

/**
 * The band's autoscroll time for one song, set from Concert Mode. Mounted at
 * `/api/bands/:bandId/songs/:songId/scroll`. Updates only that column: not a song edit, so no
 * revision and no `updatedAt` bump.
 */
export const bandSongScrollRouter = Router({ mergeParams: true });
bandSongScrollRouter.use(requireAuth, requireBandEditor);

bandSongScrollRouter.put('/', async (req, res) => {
  try {
    const scope = await loadBandSongScope(req, res);
    if (!scope) return;
    const scrollSeconds = parseScrollSeconds((req.body ?? {}).scrollSeconds);
    if (scrollSeconds === null) {
      res.status(400).json({ error: 'scrollSeconds must be a number.' });
      return;
    }
    await db
      .update(songs)
      .set({ scrollSeconds })
      .where(and(eq(songs.id, scope.song.id), eq(songs.bandId, scope.bandId)));
    res.json({ scrollSeconds });
  } catch (err) {
    console.error('Failed to save song scroll time:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});
