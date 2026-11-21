// @vitest-environment node
/**
 * A song's band-wide autoscroll time: editors save it from Concert Mode through its own
 * endpoint, which isn't a song edit (no revision); a song-form save leaves it alone. Same
 * PGlite-over-real-migrations setup as permissions.test.ts.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  process.env.ATTACHMENTS_DIR ??= '/tmp/gigboy-test-attachments';
  return {
    ready: null as unknown as Promise<void>,
    query: null as unknown as (sql: string) => Promise<{ rows: Record<string, unknown>[] }>,
  };
});

vi.mock('../db/client.js', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const schema = await import('../db/schema.js');
  const client = new PGlite();
  const db = drizzle(client, { schema: schema as unknown as Record<string, unknown> });
  h.query = (sql) => client.query(sql) as Promise<{ rows: Record<string, unknown>[] }>;
  h.ready = (async () => {
    const dir = join(process.cwd(), 'server/db/migrations');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      for (const stmt of readFileSync(join(dir, file), 'utf8').split('--> statement-breakpoint')) {
        if (stmt.trim()) await client.exec(stmt);
      }
    }
    await client.exec(`
      INSERT INTO users (id, email, email_lower, username, password_hash) VALUES
        ('editor', 'e@x', 'e@x', 'editor', 'x'),
        ('viewer', 'v@x', 'v@x', 'viewer', 'x'),
        ('other',  'o@x', 'o@x', 'other',  'x');
      INSERT INTO bands (id, name, owner_id) VALUES ('b1', 'One', 'editor'), ('b2', 'Other', 'other');
      INSERT INTO band_members (band_id, user_id, role) VALUES
        ('b1', 'editor', 'editor'), ('b1', 'viewer', 'viewer'), ('b2', 'other', 'editor');
      INSERT INTO songs (id, band_id, title, language, chordpro) VALUES
        ('song1', 'b1', 'Song', 'en', '[C]La');
    `);
  })();
  return { db };
});

const { bandSongScrollRouter } = await import('./songScroll.js');
const { bandSongsRouter } = await import('./bandSongs.js');

let base: string;
let server: ReturnType<express.Express['listen']>;

async function call(method: string, path: string, user?: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(user ? { 'x-user-id': user } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = JSON.parse(text); } catch { /* plain text */ }
  return { status: res.status, json };
}

async function songRow() {
  const { rows } = await h.query(`SELECT scroll_seconds, updated_at FROM songs WHERE id = 'song1'`);
  return rows[0] as { scroll_seconds: number | null; updated_at: Date };
}

async function revisionCount() {
  const { rows } = await h.query(`SELECT count(*)::int AS n FROM song_revisions WHERE song_id = 'song1'`);
  return (rows[0] as { n: number }).n;
}

beforeAll(async () => {
  await h.ready;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const u = req.header('x-user-id');
    if (u) (req as unknown as { userId?: string }).userId = u;
    next();
  });
  app.use('/api/bands/:bandId/songs/:songId/scroll', bandSongScrollRouter);
  app.use('/api/bands/:bandId/songs', bandSongsRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('song scroll time', () => {
  it('lets only editors of the band save it', async () => {
    expect((await call('PUT', '/api/bands/b1/songs/song1/scroll', undefined, { scrollSeconds: 200 })).status).toBe(401);
    expect((await call('PUT', '/api/bands/b1/songs/song1/scroll', 'viewer', { scrollSeconds: 200 })).status).toBe(403);
    expect((await call('PUT', '/api/bands/b1/songs/song1/scroll', 'other', { scrollSeconds: 200 })).status).toBe(403);
    expect((await call('PUT', '/api/bands/b2/songs/song1/scroll', 'other', { scrollSeconds: 200 })).status).toBe(404);
    expect((await songRow()).scroll_seconds).toBeNull();
  });

  it('saves it without a revision or a new updatedAt, clamped', async () => {
    const before = await songRow();
    const revisions = await revisionCount();
    const res = await call('PUT', '/api/bands/b1/songs/song1/scroll', 'editor', { scrollSeconds: 214.6 });
    expect(res.status).toBe(200);
    expect(res.json.scrollSeconds).toBe(215);
    const after = await songRow();
    expect(after.scroll_seconds).toBe(215);
    expect(after.updated_at).toEqual(before.updated_at);
    expect(await revisionCount()).toBe(revisions);

    expect((await call('PUT', '/api/bands/b1/songs/song1/scroll', 'editor', { scrollSeconds: 1 })).json.scrollSeconds).toBe(10);
    expect((await call('PUT', '/api/bands/b1/songs/song1/scroll', 'editor', { scrollSeconds: 'x' })).status).toBe(400);
    await call('PUT', '/api/bands/b1/songs/song1/scroll', 'editor', { scrollSeconds: 215 });
  });

  it('is listed with the song, and a song save leaves it alone', async () => {
    const list = await call('GET', '/api/bands/b1/songs', 'viewer');
    expect(list.json.songs.find((s: { id: string }) => s.id === 'song1').scrollSeconds).toBe(215);

    const saved = await call('PUT', '/api/bands/b1/songs/song1', 'editor', { title: 'Song', language: 'en', chordpro: '[G]La', scrollSeconds: 999 });
    expect(saved.status).toBe(200);
    expect((await songRow()).scroll_seconds).toBe(215);
  });
});
