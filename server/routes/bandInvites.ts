import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { bandInvites, bandMembers, bands, users } from '../db/schema.js';
import { startSession } from '../middleware/session.js';
import { toPublicUser } from '../lib/user.js';
import { DUPLICATE_ACCOUNT_ERROR, validateSignup } from '../lib/accountSignup.js';
import { isUniqueViolation } from '../lib/dbErrors.js';
import { canInviteWithSignup } from '../lib/bandSignup.js';

type BandInviteRow = typeof bandInvites.$inferSelect;

/** Loads a band invite, or describes why it can't be used (as an HTTP status + message). */
async function usableInvite(
  id: string,
): Promise<{ invite: BandInviteRow; status?: never; error?: never } | { invite?: never; status: number; error: string }> {
  const [invite] = await db.select().from(bandInvites).where(eq(bandInvites.id, id)).limit(1);
  if (!invite) return { status: 404, error: 'Invite not found.' };
  if (invite.status === 'revoked') return { status: 410, error: 'This invite has been revoked.' };
  if (invite.expiresAt.getTime() < Date.now()) return { status: 410, error: 'This invite has expired.' };
  return { invite };
}

/**
 * Public band-invite lookup and sign-up, mounted at /api/band-invites (rate-limited like auth).
 * Accepting as an existing, signed-in user stays at POST /api/bands/invites/:id/accept.
 */
export const publicBandInvitesRouter = Router();

/** What the invite landing page shows before anyone signs in: the band, who's inviting, and
 * whether the link lets a newcomer create an account. */
publicBandInvitesRouter.get('/:id', async (req, res) => {
  try {
    const found = await usableInvite(req.params.id);
    if (!found.invite) {
      res.status(found.status).json({ error: found.error });
      return;
    }
    const { invite } = found;
    const [band] = await db.select({ name: bands.name }).from(bands).where(eq(bands.id, invite.bandId)).limit(1);
    if (!band) {
      res.status(404).json({ error: 'Band not found.' });
      return;
    }
    const [inviter] = await db
      .select({ username: users.username, fullName: users.fullName })
      .from(users)
      .where(eq(users.id, invite.inviterId))
      .limit(1);
    res.json({
      bandName: band.name,
      inviterName: inviter ? (inviter.fullName || inviter.username) : null,
      role: invite.role,
      allowSignup: invite.allowSignup && (await canInviteWithSignup(invite.bandId, invite.inviterId)),
      expiresAt: invite.expiresAt.toISOString(),
    });
  } catch (err) {
    console.error('Failed to look up band invite:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

/**
 * Creates an account from a band invite that allows sign-up, adds it to the band and signs it in.
 * The link stays reusable (like accepting it as an existing user), and both the account and the
 * band membership record the invite's creator as the one who invited them.
 */
publicBandInvitesRouter.post('/:id/signup', async (req, res) => {
  try {
    const found = await usableInvite(req.params.id);
    if (!found.invite) {
      res.status(found.status).json({ error: found.error });
      return;
    }
    const { invite } = found;
    if (!invite.allowSignup || !(await canInviteWithSignup(invite.bandId, invite.inviterId))) {
      res.status(403).json({ error: 'This invite is for existing accounts. Sign in to join the band.' });
      return;
    }

    const validated = await validateSignup(req.body, null);
    if (validated.error !== undefined) {
      res.json({ user: null, bandId: null, error: validated.error });
      return;
    }

    const id = crypto.randomUUID();
    let row;
    try {
      row = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(users)
          .values({ id, ...validated.values, role: 'member', invitedById: invite.inviterId })
          .returning();
        await tx
          .insert(bandMembers)
          .values({ bandId: invite.bandId, userId: id, role: invite.role, invitedById: invite.inviterId });
        return created;
      });
    } catch (insertErr) {
      if (isUniqueViolation(insertErr)) {
        res.json({ user: null, bandId: null, error: DUPLICATE_ACCOUNT_ERROR });
        return;
      }
      throw insertErr;
    }

    await startSession(res, id);
    res.json({ user: toPublicUser(row), bandId: invite.bandId, error: null });
  } catch (err) {
    console.error('Failed to sign up from band invite:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});
