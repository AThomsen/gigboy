// @vitest-environment node
/** Sliding session expiry in attachSession, against PGlite with the real migrations. */
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  process.env.SESSION_SECRET = 'test-secret';
  return { ready: null as unknown as Promise<void> };
});

vi.mock('../db/client.js', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const { migrate } = await import('drizzle-orm/pglite/migrator');
  const schema = await import('../db/schema.js');
  const db = drizzle(new PGlite(), { schema });
  const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../db/migrations');
  h.ready = (async () => {
    await migrate(db, { migrationsFolder });
    await db.insert(schema.users).values({ id: 'u1', email: 'a@example.com', emailLower: 'a@example.com', username: 'a' });
  })();
  return { db };
});

const { attachSession, startSession } = await import('./session.js');
const { db } = await import('../db/client.js');
const { sessions } = await import('../db/schema.js');
const { eq } = await import('drizzle-orm');

const DAY = 24 * 60 * 60 * 1000;
let baseUrl: string;
let server: ReturnType<express.Express['listen']>;

beforeAll(async () => {
  await h.ready;
  const app = express();
  app.use(cookieParser(process.env.SESSION_SECRET));
  app.post('/login', async (_req, res) => {
    await startSession(res, 'u1');
    res.json({});
  });
  app.use(attachSession);
  app.get('/whoami', (req, res) => {
    res.json({ userId: req.userId ?? null });
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
});

async function signIn(): Promise<{ cookie: string; token: string }> {
  const before = new Set((await db.select({ token: sessions.token }).from(sessions)).map((r) => r.token));
  const res = await fetch(`${baseUrl}/login`, { method: 'POST' });
  const cookie = res.headers.get('set-cookie')!.split(';')[0];
  const created = (await db.select({ token: sessions.token }).from(sessions)).find((r) => !before.has(r.token))!;
  return { cookie, token: created.token };
}

async function setExpiry(token: string, expiresAt: Date) {
  await db.update(sessions).set({ expiresAt }).where(eq(sessions.token, token));
}

async function getExpiry(token: string): Promise<number> {
  const [row] = await db.select().from(sessions).where(eq(sessions.token, token));
  return row.expiresAt.getTime();
}

async function whoami(cookie: string) {
  const res = await fetch(`${baseUrl}/whoami`, { headers: { cookie } });
  return { userId: ((await res.json()) as { userId: string | null }).userId, setCookie: res.headers.get('set-cookie') };
}

describe('sliding session expiry', () => {
  it('pushes the expiry back to 30 days when the session is used', async () => {
    const { cookie, token } = await signIn();
    await setExpiry(token, new Date(Date.now() + 5 * DAY));

    const res = await whoami(cookie);
    expect(res.userId).toBe('u1');
    expect(await getExpiry(token)).toBeGreaterThan(Date.now() + 29.9 * DAY);
    expect(res.setCookie).toMatch(/^session=/);
    // The reissued cookie expires with the session.
    const cookieExpiry = Date.parse(/Expires=([^;]+)/.exec(res.setCookie!)![1]);
    expect(cookieExpiry).toBeGreaterThan(Date.now() + 29.9 * DAY);
  });

  it('leaves a session refreshed within the last day alone', async () => {
    const { cookie, token } = await signIn();
    const recent = Date.now() + 29.5 * DAY;
    await setExpiry(token, new Date(recent));

    const res = await whoami(cookie);
    expect(res.userId).toBe('u1');
    expect(await getExpiry(token)).toBe(recent);
    expect(res.setCookie).toBeNull();
  });

  it('does not revive an expired session', async () => {
    const { cookie, token } = await signIn();
    const expired = Date.now() - 1000;
    await setExpiry(token, new Date(expired));

    const res = await whoami(cookie);
    expect(res.userId).toBeNull();
    expect(await getExpiry(token)).toBe(expired);
  });
});
