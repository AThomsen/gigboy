import { Router, type Request } from 'express';
import { and, count, eq } from 'drizzle-orm';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { db } from '../db/client.js';
import { passkeys, users } from '../db/schema.js';
import { requireAuth, startSession } from '../middleware/session.js';
import { getAuthConfig, readPasskeyConfig } from '../lib/authConfig.js';
import { toPublicUser } from '../lib/user.js';

const CHALLENGE_TTL_MS = 5 * 60_000;
const NAME_MAX = 60;

/**
 * Outstanding WebAuthn challenges, each usable once. Kept in memory: the server is a single
 * process, and a restart only cancels ceremonies that are mid-flight.
 */
const challenges = new Map<string, { purpose: 'login' | 'register'; userId: string | null; expiresAt: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [challenge, entry] of challenges) {
    if (entry.expiresAt < now) challenges.delete(challenge);
  }
}, 60_000).unref();

function rememberChallenge(challenge: string, purpose: 'login' | 'register', userId: string | null): void {
  challenges.set(challenge, { purpose, userId, expiresAt: Date.now() + CHALLENGE_TTL_MS });
}

/** Returns a checker for verify*Response's expectedChallenge that consumes the challenge. */
function consumeChallenge(purpose: 'login' | 'register', userId: string | null) {
  return (challenge: string): boolean => {
    const entry = challenges.get(challenge);
    if (!entry) return false;
    challenges.delete(challenge);
    return entry.purpose === purpose && entry.userId === userId && entry.expiresAt >= Date.now();
  };
}

/** A readable default name for a new passkey, from the browser's user agent. */
function defaultPasskeyName(req: Request): string {
  const ua = req.get('user-agent') ?? '';
  const device =
    /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) ? 'iPad'
    : /Android/.test(ua) ? 'Android'
    : /Macintosh|Mac OS X/.test(ua) ? 'Mac'
    : /Windows/.test(ua) ? 'Windows'
    : /CrOS/.test(ua) ? 'Chromebook'
    : /Linux/.test(ua) ? 'Linux'
    : null;
  return device ? `Passkey on ${device}` : 'Passkey';
}

function serializePasskey(row: typeof passkeys.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
  };
}

/** Passkey sign-in and management, mounted at /api/auth/passkeys. */
export const passkeysRouter = Router();

passkeysRouter.use((_req, res, next) => {
  if (!getAuthConfig().passkeys) {
    res.status(404).json({ error: 'Passkeys are not enabled on this server.' });
    return;
  }
  next();
});

// --- Sign-in (signed out) ---------------------------------------------------------------

/** Options for a usernameless sign-in: the browser offers whichever passkeys it holds for us. */
passkeysRouter.post('/login/options', async (_req, res) => {
  try {
    const { rpID } = readPasskeyConfig()!;
    const options = await generateAuthenticationOptions({ rpID, userVerification: 'preferred' });
    rememberChallenge(options.challenge, 'login', null);
    res.json({ options });
  } catch (err) {
    console.error('Failed to create passkey sign-in options:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

passkeysRouter.post('/login/verify', async (req, res) => {
  const failed = 'That passkey isn’t registered on this server. Sign in another way, then add it in your profile.';
  try {
    const response = (req.body ?? {}).response as AuthenticationResponseJSON | undefined;
    if (!response || typeof response.id !== 'string') {
      res.json({ user: null, error: failed });
      return;
    }

    const [passkey] = await db.select().from(passkeys).where(eq(passkeys.id, response.id)).limit(1);
    if (!passkey) {
      res.json({ user: null, error: failed });
      return;
    }

    const { rpID, origin } = readPasskeyConfig()!;
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: consumeChallenge('login', null),
        expectedOrigin: origin,
        expectedRPID: rpID,
        credential: {
          id: passkey.id,
          publicKey: Buffer.from(passkey.publicKey, 'base64url'),
          counter: passkey.counter,
          transports: passkey.transports,
        },
        requireUserVerification: false,
      });
    } catch (err) {
      console.warn('Passkey sign-in rejected:', err instanceof Error ? err.message : err);
      res.json({ user: null, error: 'Passkey sign-in failed. Please try again.' });
      return;
    }
    if (!verification.verified) {
      res.json({ user: null, error: 'Passkey sign-in failed. Please try again.' });
      return;
    }

    await db
      .update(passkeys)
      .set({ counter: verification.authenticationInfo.newCounter, lastUsedAt: new Date() })
      .where(eq(passkeys.id, passkey.id));

    const [user] = await db.select().from(users).where(eq(users.id, passkey.userId)).limit(1);
    if (!user) {
      res.json({ user: null, error: failed });
      return;
    }
    await startSession(res, user.id);
    res.json({ user: toPublicUser(user), error: null });
  } catch (err) {
    console.error('Passkey sign-in failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// --- Management (signed in) -------------------------------------------------------------

passkeysRouter.get('/', requireAuth, async (req, res) => {
  try {
    const rows = await db.select().from(passkeys).where(eq(passkeys.userId, req.userId!)).orderBy(passkeys.createdAt);
    res.json({ passkeys: rows.map(serializePasskey) });
  } catch (err) {
    console.error('Failed to list passkeys:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

passkeysRouter.post('/register/options', requireAuth, async (req, res) => {
  try {
    const [user] = await db.select().from(users).where(eq(users.id, req.userId!)).limit(1);
    if (!user) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    const existing = await db.select({ id: passkeys.id, transports: passkeys.transports }).from(passkeys).where(eq(passkeys.userId, user.id));
    const { rpID } = readPasskeyConfig()!;
    const options = await generateRegistrationOptions({
      rpName: 'Gigboy',
      rpID,
      userName: user.email,
      userDisplayName: user.fullName || user.username || user.email,
      userID: new TextEncoder().encode(user.id),
      attestationType: 'none',
      // Don't let the same authenticator be registered twice.
      excludeCredentials: existing.map((p) => ({ id: p.id, transports: p.transports })),
      // Discoverable, so sign-in works without typing an email first.
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    });
    rememberChallenge(options.challenge, 'register', user.id);
    res.json({ options });
  } catch (err) {
    console.error('Failed to create passkey registration options:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

passkeysRouter.post('/register/verify', requireAuth, async (req, res) => {
  try {
    const response = (req.body ?? {}).response as RegistrationResponseJSON | undefined;
    if (!response || typeof response.id !== 'string') {
      res.json({ passkey: null, error: 'Passkey setup failed. Please try again.' });
      return;
    }

    const { rpID, origin } = readPasskeyConfig()!;
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: consumeChallenge('register', req.userId!),
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: false,
      });
    } catch (err) {
      console.warn('Passkey registration rejected:', err instanceof Error ? err.message : err);
      res.json({ passkey: null, error: 'Passkey setup failed. Please try again.' });
      return;
    }
    if (!verification.verified) {
      res.json({ passkey: null, error: 'Passkey setup failed. Please try again.' });
      return;
    }

    const { credential } = verification.registrationInfo;
    const [row] = await db
      .insert(passkeys)
      .values({
        id: credential.id,
        userId: req.userId!,
        publicKey: Buffer.from(credential.publicKey).toString('base64url'),
        counter: credential.counter,
        transports: credential.transports ?? [],
        name: defaultPasskeyName(req),
      })
      .onConflictDoNothing()
      .returning();
    if (!row) {
      res.json({ passkey: null, error: 'This passkey is already registered.' });
      return;
    }
    res.json({ passkey: serializePasskey(row), error: null });
  } catch (err) {
    console.error('Passkey registration failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

passkeysRouter.patch('/:id', requireAuth, async (req, res) => {
  try {
    const name = (req.body ?? {}).name;
    if (typeof name !== 'string' || !name.trim() || name.trim().length > NAME_MAX) {
      res.status(400).json({ error: `Name must be 1–${NAME_MAX} characters.` });
      return;
    }
    const [row] = await db
      .update(passkeys)
      .set({ name: name.trim() })
      .where(and(eq(passkeys.id, req.params.id), eq(passkeys.userId, req.userId!)))
      .returning();
    if (!row) {
      res.status(404).json({ error: 'Passkey not found.' });
      return;
    }
    res.json({ passkey: serializePasskey(row) });
  } catch (err) {
    console.error('Failed to rename passkey:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

passkeysRouter.delete('/:id', requireAuth, async (req, res) => {
  try {
    const config = getAuthConfig();
    const [user] = await db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, req.userId!)).limit(1);
    const [{ total }] = await db.select({ total: count() }).from(passkeys).where(eq(passkeys.userId, req.userId!));
    // Emailed sign-in is always a way back in; otherwise a password has to be.
    const hasOtherWayIn = config.magicLinks || (config.passwords && Boolean(user?.passwordHash));
    if (total <= 1 && !hasOtherWayIn) {
      res.status(400).json({ error: 'This is your only way to sign in. Set a password before removing it.' });
      return;
    }
    const [row] = await db
      .delete(passkeys)
      .where(and(eq(passkeys.id, req.params.id), eq(passkeys.userId, req.userId!)))
      .returning();
    if (!row) {
      res.status(404).json({ error: 'Passkey not found.' });
      return;
    }
    res.json({});
  } catch (err) {
    console.error('Failed to delete passkey:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});
