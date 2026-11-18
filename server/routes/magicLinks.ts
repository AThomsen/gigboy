import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { and, eq, gt, lt, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { loginCodes, users } from '../db/schema.js';
import { startSession } from '../middleware/session.js';
import { getAuthConfig, readPublicOrigin } from '../lib/authConfig.js';
import { sendSignInEmail } from '../lib/mailer.js';
import { toPublicUser } from '../lib/user.js';

const CODE_TTL_MINUTES = 15;
const MAX_CODE_ATTEMPTS = 5;
/** A repeat request inside this window doesn't send another email (stops inbox flooding). */
const RESEND_INTERVAL_MS = 30_000;

const WRONG_CODE = 'That code is wrong or has expired. Request a new one.';
const WRONG_LINK = 'This sign-in link has expired or was already used. Request a new one.';

function hashLinkToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Keyed so a leaked database row can't be brute-forced offline into a working code. */
function hashCode(rowId: string, code: string): string {
  return createHmac('sha256', process.env.SESSION_SECRET!).update(`${rowId}:${code}`).digest('hex');
}

function codesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

function normalizeCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const digits = value.replace(/\D/g, '');
  return digits.length === 6 ? digits : null;
}

/** Emailed one-time sign-in (link + code), mounted at /api/auth/magic-link. */
export const magicLinkRouter = Router();

magicLinkRouter.use((_req, res, next) => {
  if (!getAuthConfig().magicLinks) {
    res.status(404).json({ error: 'Email sign-in is not enabled on this server.' });
    return;
  }
  next();
});

/**
 * Sends a sign-in email if the address belongs to an account. Always answers the same way, and
 * sends in the background, so neither the response nor its timing reveals who has an account.
 */
magicLinkRouter.post('/', async (req, res) => {
  const email = (req.body ?? {}).email;
  if (typeof email !== 'string' || !email.includes('@')) {
    res.json({ error: 'Enter a valid email address.' });
    return;
  }
  res.json({ error: null });

  try {
    const [user] = await db.select().from(users).where(eq(users.emailLower, email.trim().toLowerCase())).limit(1);
    if (!user) return;

    const [pending] = await db.select().from(loginCodes).where(eq(loginCodes.userId, user.id)).limit(1);
    if (pending && Date.now() - pending.createdAt.getTime() < RESEND_INTERVAL_MS) return;

    const id = crypto.randomUUID();
    const linkToken = randomBytes(32).toString('base64url');
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const values = {
      id,
      userId: user.id,
      linkTokenHash: hashLinkToken(linkToken),
      codeHash: hashCode(id, code),
      attempts: 0,
      expiresAt: new Date(Date.now() + CODE_TTL_MINUTES * 60_000),
      createdAt: new Date(),
    };
    // One pending sign-in per user: a new request replaces the old link and code.
    await db.insert(loginCodes).values(values).onConflictDoUpdate({ target: loginCodes.userId, set: values });

    // The token travels in the fragment, so it never reaches server logs or a Referer header.
    const link = `${readPublicOrigin()}/login/link#${linkToken}`;
    await sendSignInEmail(user.email, link, code, CODE_TTL_MINUTES);
  } catch (err) {
    console.error('Failed to send sign-in email:', err);
  }
});

/** Signs in with the token from an emailed link. Single use. */
magicLinkRouter.post('/verify-link', async (req, res) => {
  try {
    const token = (req.body ?? {}).token;
    if (typeof token !== 'string' || token.length < 20) {
      res.json({ user: null, error: WRONG_LINK });
      return;
    }
    // Deleting is the claim: of two concurrent uses, only one gets the row back.
    const [claimed] = await db
      .delete(loginCodes)
      .where(and(eq(loginCodes.linkTokenHash, hashLinkToken(token)), gt(loginCodes.expiresAt, new Date())))
      .returning();
    if (!claimed) {
      res.json({ user: null, error: WRONG_LINK });
      return;
    }
    const [user] = await db.select().from(users).where(eq(users.id, claimed.userId)).limit(1);
    if (!user) {
      res.json({ user: null, error: WRONG_LINK });
      return;
    }
    await startSession(res, user.id);
    res.json({ user: toPublicUser(user), error: null });
  } catch (err) {
    console.error('Sign-in link verification failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

/** Signs in with the 6-digit code from the email — the path an installed PWA uses. */
magicLinkRouter.post('/verify-code', async (req, res) => {
  try {
    const { email } = (req.body ?? {}) as Record<string, unknown>;
    const code = normalizeCode((req.body ?? {}).code);
    if (typeof email !== 'string' || !code) {
      res.json({ user: null, error: 'Enter the 6-digit code from the email.' });
      return;
    }

    const [user] = await db.select().from(users).where(eq(users.emailLower, email.trim().toLowerCase())).limit(1);
    if (!user) {
      res.json({ user: null, error: WRONG_CODE });
      return;
    }

    // Every guess spends an attempt up front, atomically, so parallel guesses can't exceed the cap.
    const [pending] = await db
      .update(loginCodes)
      .set({ attempts: sql`${loginCodes.attempts} + 1` })
      .where(and(
        eq(loginCodes.userId, user.id),
        gt(loginCodes.expiresAt, new Date()),
        lt(loginCodes.attempts, MAX_CODE_ATTEMPTS),
      ))
      .returning();
    if (!pending || !codesMatch(hashCode(pending.id, code), pending.codeHash)) {
      res.json({ user: null, error: WRONG_CODE });
      return;
    }

    const [claimed] = await db.delete(loginCodes).where(eq(loginCodes.id, pending.id)).returning();
    if (!claimed) {
      res.json({ user: null, error: WRONG_CODE });
      return;
    }
    await startSession(res, user.id);
    res.json({ user: toPublicUser(user), error: null });
  } catch (err) {
    console.error('Sign-in code verification failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});
