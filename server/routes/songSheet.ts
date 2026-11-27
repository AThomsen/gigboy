import { Router } from 'express';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { attachments, songs } from '../db/schema.js';
import { requireAuth } from '../middleware/session.js';
import { requireBandEditor } from '../middleware/bandAccess.js';
import { loadBandSongScope } from '../lib/songScope.js';
import { SHEET_MIME_TYPES } from '../lib/attachments.js';

/**
 * Which of a song's attachments is shown as its chart, in place of the ChordPro text — one of a
 * type the app can draw (SHEET_MIME_TYPES; PDF for now).
 * Mounted at `/api/bands/:bandId/songs/:songId/sheet`. Body `{ attachmentId: string | null }`;
 * null goes back to the ChordPro chart. Updates only that column: not a song edit, so no
 * revision and no `updatedAt` bump.
 */
export const bandSongSheetRouter = Router({ mergeParams: true });
bandSongSheetRouter.use(requireAuth, requireBandEditor);

bandSongSheetRouter.put('/', async (req, res) => {
  try {
    const scope = await loadBandSongScope(req, res);
    if (!scope) return;
    const raw = (req.body ?? {}).attachmentId;
    if (raw !== null && typeof raw !== 'string') {
      res.status(400).json({ error: 'attachmentId must be a string or null.' });
      return;
    }
    if (raw !== null) {
      const [attachment] = await db
        .select({ id: attachments.id, mimeType: attachments.mimeType })
        .from(attachments)
        .where(and(eq(attachments.id, raw), eq(attachments.songId, scope.song.id)))
        .limit(1);
      if (!attachment) {
        res.status(404).json({ error: 'Attachment not found.' });
        return;
      }
      if (!SHEET_MIME_TYPES.includes(attachment.mimeType)) {
        res.status(400).json({ error: 'This kind of file can not be shown as the chart.' });
        return;
      }
    }
    await db
      .update(songs)
      .set({ sheetAttachmentId: raw })
      .where(and(eq(songs.id, scope.song.id), eq(songs.bandId, scope.bandId)));
    res.json({ sheetAttachmentId: raw });
  } catch (err) {
    console.error('Failed to save song sheet:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});
