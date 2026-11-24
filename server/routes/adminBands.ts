import { Router } from 'express';
import { count, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { bandMembers, bands, users } from '../db/schema.js';
import { requireAuth } from '../middleware/session.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { isMemberSignupPolicy, MEMBER_SIGNUP_POLICIES } from '../lib/bandSignup.js';

/** Admin-only band oversight (every band on the server, not just ones the admin is in), mounted at /api/admin/bands. */
export const adminBandsRouter = Router();
adminBandsRouter.use(requireAuth, requireAdmin);

adminBandsRouter.get('/', async (_req, res) => {
  try {
    const rows = await db
      .select({
        id: bands.id,
        name: bands.name,
        memberSignup: bands.memberSignup,
        createdAt: bands.createdAt,
        ownerId: bands.ownerId,
        ownerUsername: users.username,
        ownerFullName: users.fullName,
        ownerEmail: users.email,
      })
      .from(bands)
      .innerJoin(users, eq(bands.ownerId, users.id))
      .orderBy(bands.name);
    const memberCounts = await db
      .select({ bandId: bandMembers.bandId, n: count() })
      .from(bandMembers)
      .groupBy(bandMembers.bandId);
    const countByBand = new Map(memberCounts.map((r) => [r.bandId, Number(r.n)]));

    res.json({
      bands: rows.map((r) => ({
        id: r.id,
        name: r.name,
        memberSignup: r.memberSignup,
        memberCount: countByBand.get(r.id) ?? 0,
        ownerId: r.ownerId,
        ownerName: r.ownerFullName || r.ownerUsername || r.ownerEmail,
        createdAt: r.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    console.error('Failed to list bands:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

/** Sets who in the band may create invite links that let newcomers sign up. */
adminBandsRouter.patch('/:id/member-signup', async (req, res) => {
  try {
    const { memberSignup } = (req.body ?? {}) as Record<string, unknown>;
    if (!isMemberSignupPolicy(memberSignup)) {
      res.status(400).json({ error: `memberSignup must be one of: ${MEMBER_SIGNUP_POLICIES.join(', ')}.` });
      return;
    }
    const [row] = await db
      .update(bands)
      .set({ memberSignup })
      .where(eq(bands.id, req.params.id))
      .returning({ id: bands.id, memberSignup: bands.memberSignup });
    if (!row) {
      res.status(404).json({ error: 'Band not found.' });
      return;
    }
    res.json(row);
  } catch (err) {
    console.error('Failed to update band sign-up policy:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});
