import { Router } from 'express';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users, userInvites } from '../db/schema.js';
import { startSession, requireAuth } from '../middleware/session.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { toPublicUser } from '../lib/user.js';
import { resolveOrigin } from '../lib/http.js';
import { DUPLICATE_ACCOUNT_ERROR, validateSignup } from '../lib/accountSignup.js';
import { isUniqueViolation } from '../lib/dbErrors.js';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days, matches band invites

/** Admin-only invite management, mounted at /api/admin/invites. */
export const adminInvitesRouter = Router();
adminInvitesRouter.use(requireAuth, requireAdmin);

adminInvitesRouter.post('/', async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const email = typeof body.email === 'string' && body.email.trim() ? body.email.trim() : null;
    const role = body.role === 'admin' ? 'admin' : 'member';

    const id = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
    await db.insert(userInvites).values({
      id,
      inviterId: req.userId!,
      email,
      role,
      status: 'pending',
      expiresAt,
    });

    const origin = resolveOrigin(req);
    res.json({
      inviteId: id,
      inviteUrl: `${origin}/invite/${id}`,
      expiresAt: expiresAt.toISOString(),
    });
  } catch (err) {
    console.error('Failed to create invite:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

adminInvitesRouter.get('/', async (_req, res) => {
  try {
    const rows = await db.select().from(userInvites).where(eq(userInvites.status, 'pending'));
    res.json({
      invites: rows.map((r) => ({
        id: r.id,
        email: r.email,
        role: r.role,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
        expiresAt: r.expiresAt.toISOString(),
      })),
    });
  } catch (err) {
    console.error('Failed to list invites:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

adminInvitesRouter.delete('/:id', async (req, res) => {
  try {
    const [row] = await db
      .update(userInvites)
      .set({ status: 'revoked' })
      .where(eq(userInvites.id, req.params.id))
      .returning();
    if (!row) {
      res.status(404).json({ error: 'Invite not found.' });
      return;
    }
    res.json({});
  } catch (err) {
    console.error('Failed to revoke invite:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

/** Public invite lookup + acceptance, mounted at /api/invites. */
export const publicInvitesRouter = Router();

publicInvitesRouter.get('/:token', async (req, res) => {
  try {
    const rows = await db.select().from(userInvites).where(eq(userInvites.id, req.params.token)).limit(1);
    const invite = rows[0];
    if (!invite) {
      res.status(404).json({ error: 'Invite not found.' });
      return;
    }
    if (invite.status === 'accepted') {
      res.status(410).json({ error: 'This invite has already been used.' });
      return;
    }
    if (invite.status === 'revoked') {
      res.status(410).json({ error: 'This invite has been revoked.' });
      return;
    }
    if (invite.expiresAt.getTime() < Date.now()) {
      res.status(410).json({ error: 'This invite has expired.' });
      return;
    }
    res.json({
      email: invite.email,
      expiresAt: invite.expiresAt.toISOString(),
      valid: true,
    });
  } catch (err) {
    console.error('Failed to look up invite:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

publicInvitesRouter.post('/:token/accept', async (req, res) => {
  try {
    const rows = await db.select().from(userInvites).where(eq(userInvites.id, req.params.token)).limit(1);
    const invite = rows[0];
    if (!invite) {
      res.status(404).json({ error: 'Invite not found.' });
      return;
    }
    if (invite.status !== 'pending') {
      res.status(410).json({ error: 'This invite is no longer valid.' });
      return;
    }
    if (invite.expiresAt.getTime() < Date.now()) {
      res.status(410).json({ error: 'This invite has expired.' });
      return;
    }

    const validated = await validateSignup(req.body, invite.email);
    if (validated.error !== undefined) {
      res.json({ user: null, error: validated.error });
      return;
    }
    const values = validated.values;
    const id = crypto.randomUUID();

    // Atomically claim the invite: only one concurrent request can flip it from pending.
    // acceptedUserId is left null here — the user row doesn't exist yet, and setting it now
    // would violate the accepted_user_id -> users.id foreign key. It's filled in after insert.
    const [claimed] = await db
      .update(userInvites)
      .set({ status: 'accepted' })
      .where(and(eq(userInvites.id, invite.id), eq(userInvites.status, 'pending')))
      .returning();
    if (!claimed) {
      res.status(410).json({ error: 'This invite is no longer valid.' });
      return;
    }

    let row;
    try {
      [row] = await db
        .insert(users)
        .values({
          id,
          ...values,
          role: invite.role === 'admin' ? 'admin' : 'member',
          invitedById: invite.inviterId,
        })
        .returning();
    } catch (insertErr) {
      // Release the invite so the user can retry with a different email/username.
      await db
        .update(userInvites)
        .set({ status: 'pending', acceptedUserId: null })
        .where(eq(userInvites.id, invite.id));
      if (isUniqueViolation(insertErr)) {
        res.json({ user: null, error: DUPLICATE_ACCOUNT_ERROR });
        return;
      }
      throw insertErr;
    }

    // Now that the user row exists, link it back to the invite.
    await db
      .update(userInvites)
      .set({ acceptedUserId: id })
      .where(eq(userInvites.id, invite.id));

    await startSession(res, id);

    res.json({ user: toPublicUser(row), error: null });
  } catch (err) {
    console.error('Failed to accept invite:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});
