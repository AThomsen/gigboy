import { Router } from 'express';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { trashItems } from '../db/schema.js';
import { requireAuth } from '../middleware/session.js';
import { requireBandEditor, requireBandMember, requireBandOwner } from '../middleware/bandAccess.js';
import {
  permanentlyDeleteTrashRow,
  restoreTrashRow,
  sweepExpiredBandTrash,
  trashRowToListItem,
} from '../lib/trash.js';
import { param } from '../lib/routeParam.js';

export const bandTrashRouter = Router({ mergeParams: true });
bandTrashRouter.use(requireAuth);

bandTrashRouter.get('/', requireBandMember, async (req, res) => {
  try {
    await sweepExpiredBandTrash(param(req, 'bandId'));
    const rows = await db
      .select()
      .from(trashItems)
      .where(eq(trashItems.bandId, param(req, 'bandId')))
      .orderBy(desc(trashItems.deletedAt));
    res.json({ items: rows.map(trashRowToListItem) });
  } catch (err) {
    console.error('Failed to list band trash:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

bandTrashRouter.post('/:id/restore', requireBandEditor, async (req, res) => {
  try {
    const existing = await db
      .select()
      .from(trashItems)
      .where(and(eq(trashItems.id, param(req, 'id')), eq(trashItems.bandId, param(req, 'bandId'))))
      .limit(1);
    if (!existing[0]) {
      res.status(404).json({ error: 'Trash item not found.' });
      return;
    }
    const result = await restoreTrashRow(existing[0]);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    await db.delete(trashItems).where(eq(trashItems.id, param(req, 'id')));
    res.json({});
  } catch (err) {
    console.error('Failed to restore band trash item:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

bandTrashRouter.delete('/:id', requireBandOwner, async (req, res) => {
  try {
    const existing = await db
      .select()
      .from(trashItems)
      .where(and(eq(trashItems.id, param(req, 'id')), eq(trashItems.bandId, param(req, 'bandId'))))
      .limit(1);
    if (!existing[0]) {
      res.status(404).json({ error: 'Trash item not found.' });
      return;
    }
    await permanentlyDeleteTrashRow(existing[0]);
    res.json({});
  } catch (err) {
    console.error('Failed to permanently delete band trash item:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

bandTrashRouter.delete('/', requireBandOwner, async (req, res) => {
  try {
    const rows = await db.select().from(trashItems).where(eq(trashItems.bandId, param(req, 'bandId')));
    for (const row of rows) {
      await permanentlyDeleteTrashRow(row);
    }
    res.json({});
  } catch (err) {
    console.error('Failed to empty band trash:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});
