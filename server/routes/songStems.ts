import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { songStems } from '../db/schema.js';
import { requireAuth } from '../middleware/session.js';
import { requireBandEditor, requireBandMember } from '../middleware/bandAccess.js';
import { localStorageAdapter } from '../storage/localStorageAdapter.js';
import { extensionForAudioMimeType, streamStoredAudio } from '../lib/songRecordings.js';
import {
  parseWaveformBars,
  songStemToApi,
  STEM_ACCEPTED_MIME_TYPES,
  STEM_NAME_RE,
  stemUpload,
} from '../lib/songStems.js';
import { loadBandSongScope } from '../lib/songScope.js';
import { assertUploadWithinQuota } from '../lib/storageQuota.js';
import { param } from '../lib/routeParam.js';

const INVALID_TYPE_MESSAGE = 'Only MP3 and WAV stems are accepted.';

function handleUploadErrors(err: unknown, res: Response): boolean {
  if (!err) return false;
  const asAny = err as { code?: string; message?: string };
  if (asAny.code === 'LIMIT_FILE_SIZE') {
    res.status(400).json({ error: 'Stem is too large. Maximum size is 50MB per stem.' });
    return true;
  }
  if (asAny.message === 'INVALID_FILE_TYPE') {
    res.status(400).json({ error: INVALID_TYPE_MESSAGE });
    return true;
  }
  console.error('Stem upload failed:', err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
  return true;
}

function urlBase(req: Request): string {
  return `/api/bands/${param(req, 'bandId')}/songs/${param(req, 'songId')}/stems`;
}

async function loadStem(req: Request, res: Response, songId: string) {
  const rows = await db
    .select()
    .from(songStems)
    .where(and(eq(songStems.id, param(req, 'id')), eq(songStems.songId, songId)))
    .limit(1);
  if (!rows[0]) {
    res.status(404).json({ error: 'Stem not found.' });
    return null;
  }
  return rows[0];
}

export const bandSongStemsRouter = Router({ mergeParams: true });
bandSongStemsRouter.use(requireAuth, requireBandMember);

bandSongStemsRouter.get('/', async (req, res) => {
  try {
    const scope = await loadBandSongScope(req, res);
    if (!scope) return;
    const rows = await db
      .select()
      .from(songStems)
      .where(eq(songStems.songId, scope.song.id))
      .orderBy(asc(songStems.sortOrder), asc(songStems.name));
    res.json({ stems: rows.map((row) => songStemToApi(row, urlBase(req))) });
  } catch (err) {
    console.error('Failed to list song stems:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

bandSongStemsRouter.get('/:id/download', async (req, res) => {
  try {
    const scope = await loadBandSongScope(req, res);
    if (!scope) return;
    const stem = await loadStem(req, res, scope.song.id);
    if (!stem) return;
    await streamStoredAudio(req, res, localStorageAdapter, stem, 'Stem file not found.');
  } catch (err) {
    console.error('Failed to download song stem:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

/** Uploads one stem by name; an existing stem with that name is replaced in place. */
bandSongStemsRouter.put(
  '/:name',
  requireBandEditor,
  (req: Request, res: Response, next: NextFunction) => {
    if (!STEM_NAME_RE.test(param(req, 'name'))) {
      res.status(400).json({ error: 'Stem names may only use a–z, 0–9, "_" and "-" (max 40 characters).' });
      return;
    }
    stemUpload.single('file')(req, res, (err) => {
      if (handleUploadErrors(err, res)) return;
      next();
    });
  },
  async (req, res) => {
    try {
      const scope = await loadBandSongScope(req, res);
      if (!scope) return;
      const file = req.file;
      if (!file) {
        res.status(400).json({ error: 'No file was uploaded.' });
        return;
      }
      if (!STEM_ACCEPTED_MIME_TYPES.includes(file.mimetype)) {
        res.status(400).json({ error: INVALID_TYPE_MESSAGE });
        return;
      }

      const name = param(req, 'name');
      const [existing] = await db
        .select()
        .from(songStems)
        .where(and(eq(songStems.songId, scope.song.id), eq(songStems.name, name)))
        .limit(1);

      // A replacement only grows usage by the size difference.
      const quotaCheck = await assertUploadWithinQuota(req.userId!, scope.bandId, file.size - (existing?.sizeBytes ?? 0));
      if (!quotaCheck.ok) {
        res.status(413).json({ error: quotaCheck.message });
        return;
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const durationMs = Number(body.durationMs);
      const sortOrder = Number(body.sortOrder);
      const fields = {
        sizeBytes: file.size,
        mimeType: file.mimetype,
        durationMs: Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs) : 0,
        waveformBars: parseWaveformBars(body.waveformBars),
        sortOrder: Number.isFinite(sortOrder) ? Math.round(sortOrder) : (existing?.sortOrder ?? 0),
        uploaderUserId: req.userId!,
      };

      // Every upload gets a fresh key so a replacement never overwrites a file a player may be streaming.
      const fileId = crypto.randomUUID();
      const storageKey = `${scope.song.id}/stems/${name}-${fileId}.${extensionForAudioMimeType(file.mimetype)}`;
      await localStorageAdapter.save(storageKey, file.buffer, file.mimetype);

      let row;
      try {
        [row] = await db
          .insert(songStems)
          .values({ id: fileId, songId: scope.song.id, bandId: scope.bandId, name, storageKey, ...fields })
          .onConflictDoUpdate({
            target: [songStems.songId, songStems.name],
            set: { storageKey, ...fields, createdAt: new Date() },
          })
          .returning();
      } catch (err) {
        await localStorageAdapter.delete(storageKey);
        throw err;
      }

      if (existing && existing.storageKey !== storageKey) {
        await localStorageAdapter.delete(existing.storageKey);
      }

      res.json({ stem: songStemToApi(row, urlBase(req)) });
    } catch (err) {
      console.error('Failed to save song stem:', err);
      res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  },
);

bandSongStemsRouter.delete('/:id', requireBandEditor, async (req, res) => {
  try {
    const scope = await loadBandSongScope(req, res);
    if (!scope) return;
    const stem = await loadStem(req, res, scope.song.id);
    if (!stem) return;
    await db.delete(songStems).where(eq(songStems.id, stem.id));
    await localStorageAdapter.delete(stem.storageKey);
    res.json({});
  } catch (err) {
    console.error('Failed to delete song stem:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

bandSongStemsRouter.delete('/', requireBandEditor, async (req, res) => {
  try {
    const scope = await loadBandSongScope(req, res);
    if (!scope) return;
    const rows = await db
      .delete(songStems)
      .where(eq(songStems.songId, scope.song.id))
      .returning({ storageKey: songStems.storageKey });
    await Promise.all(rows.map((row) => localStorageAdapter.delete(row.storageKey)));
    res.json({ deleted: rows.length });
  } catch (err) {
    console.error('Failed to delete song stems:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});
