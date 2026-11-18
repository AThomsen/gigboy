// @vitest-environment node
/**
 * Emailed sign-in (server/routes/magicLinks.ts) end to end: a real Express app over HTTP, backed
 * by PGlite with the real migrations applied. Only the mail transport is replaced, to capture
 * what would have been sent.
 */
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  Object.assign(process.env, {
    SESSION_SECRET: 'test-secret',
    AUTH_PASSWORDS: 'false',
    AUTH_MAGIC_LINKS: 'true',
    SMTP_HOST: 'smtp.test',
    SMTP_FROM: 'gigboy@test',
    PUBLIC_ORIGIN: 'https://gigboy.test',
  });
  return {
    ready: null as unknown as Promise<void>,
    sent: [] as { to: string; link: string; code: string }[],
  };
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
    await db.insert(schema.users).values({ id: 'u1', email: 'Ann@Example.com', emailLower: 'ann@example.com', username: 'ann' });
  })();
  return { db };
});

vi.mock('../lib/mailer.js', () => ({
  sendSignInEmail: async (to: string, link: string, code: string) => {
    h.sent.push({ to, link, code });
  },
}));

const { magicLinkRouter } = await import('./magicLinks.js');
const { db } = await import('../db/client.js');
const { loginCodes } = await import('../db/schema.js');

let baseUrl: string;
let server: ReturnType<express.Express['listen']>;

beforeAll(async () => {
  await h.ready;
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.SESSION_SECRET));
  app.use('/api/auth/magic-link', magicLinkRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/auth/magic-link`;
});

afterAll(() => {
  server?.close();
});

beforeEach(async () => {
  h.sent.length = 0;
  await db.delete(loginCodes);
});

async function post(pathname: string, body: unknown) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, cookie: res.headers.get('set-cookie'), body: (await res.json()) as Record<string, unknown> };
}

/** The email is sent after the response; wait for it to land. */
async function requestEmail(email: string) {
  const before = h.sent.length;
  const res = await post('', { email });
  await vi.waitFor(() => expect(h.sent.length).toBeGreaterThan(before), { timeout: 2000 });
  return { res, mail: h.sent[h.sent.length - 1] };
}

describe('emailed sign-in', () => {
  it('answers the same for unknown addresses, and sends nothing', async () => {
    const res = await post('', { email: 'nobody@example.com' });
    expect(res.body).toEqual({ error: null });
    await new Promise((r) => setTimeout(r, 100));
    expect(h.sent).toHaveLength(0);
  });

  it('emails a link on PUBLIC_ORIGIN and a 6-digit code', async () => {
    const { res, mail } = await requestEmail('ANN@example.com');
    expect(res.body).toEqual({ error: null });
    expect(mail.to).toBe('Ann@Example.com');
    expect(mail.link).toMatch(/^https:\/\/gigboy\.test\/login\/link#[\w-]{40,}$/);
    expect(mail.code).toMatch(/^\d{6}$/);
  });

  it('signs in with the code, once', async () => {
    const { mail } = await requestEmail('ann@example.com');
    const ok = await post('/verify-code', { email: 'ann@example.com', code: `${mail.code.slice(0, 3)} ${mail.code.slice(3)}` });
    expect(ok.body.error).toBeNull();
    expect((ok.body.user as { id: string }).id).toBe('u1');
    expect(ok.cookie).toMatch(/^session=/);

    const again = await post('/verify-code', { email: 'ann@example.com', code: mail.code });
    expect(again.body.user).toBeNull();
    expect(again.cookie).toBeNull();
  });

  it('signs in with the link token, once — and that spends the code too', async () => {
    const { mail } = await requestEmail('ann@example.com');
    const token = mail.link.split('#')[1];
    const ok = await post('/verify-link', { token });
    expect((ok.body.user as { id: string }).id).toBe('u1');
    expect(ok.cookie).toMatch(/^session=/);

    expect((await post('/verify-link', { token })).body.user).toBeNull();
    expect((await post('/verify-code', { email: 'ann@example.com', code: mail.code })).body.user).toBeNull();
  });

  it('locks the code after 5 wrong guesses, even if the 6th is right', async () => {
    const { mail } = await requestEmail('ann@example.com');
    const wrong = mail.code === '000000' ? '111111' : '000000';
    const guesses = await Promise.all(
      Array.from({ length: 5 }, () => post('/verify-code', { email: 'ann@example.com', code: wrong })),
    );
    expect(guesses.every((g) => g.body.user === null)).toBe(true);
    const right = await post('/verify-code', { email: 'ann@example.com', code: mail.code });
    expect(right.body.user).toBeNull();
    expect(right.cookie).toBeNull();
  });

  it('rejects an expired code', async () => {
    const { mail } = await requestEmail('ann@example.com');
    await db.update(loginCodes).set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await post('/verify-code', { email: 'ann@example.com', code: mail.code })).body.user).toBeNull();
  });

  it('a new request replaces the old code, but not within 30 seconds', async () => {
    const first = await requestEmail('ann@example.com');
    await post('', { email: 'ann@example.com' });
    await new Promise((r) => setTimeout(r, 100));
    expect(h.sent).toHaveLength(1);

    await db.update(loginCodes).set({ createdAt: new Date(Date.now() - 60_000) });
    const second = await requestEmail('ann@example.com');
    expect((await post('/verify-link', { token: first.mail.link.split('#')[1] })).body.user).toBeNull();
    expect((await post('/verify-code', { email: 'ann@example.com', code: second.mail.code })).body.user).not.toBeNull();
  });
});
