// @vitest-environment node
/**
 * A song's PDF sheet: editors pick one of its PDF attachments to show as the chart, through its
 * own endpoint, which isn't a song edit (no revision); a song-form save leaves it alone, and
 * deleting the attachment clears it. Same PGlite-over-real-migrations setup as songScroll.test.ts.
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
        ('song1', 'b1', 'Song', 'en', '[C]La'), ('song2', 'b1', 'Other song', 'en', '[C]La');
      INSERT INTO attachments (id, song_id, name, storage_key, size_bytes, mime_type, uploader_user_id) VALUES
        ('pdf1', 'song1', 'Lead sheet.pdf', 'song1/pdf1.pdf', 10, 'application/pdf', 'editor'),
        ('pdf2', 'song2', 'Elsewhere.pdf', 'song2/pdf2.pdf', 10, 'application/pdf', 'editor'),
        ('zip1', 'song1', 'Stems.zip', 'song1/zip1.zip', 10, 'application/zip', 'editor');
    `);
  })();
  return { db };
});

const { bandSongSheetRouter } = await import('./songSheet.js');
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
  const { rows } = await h.query(`SELECT sheet_attachment_id, updated_at FROM songs WHERE id = 'song1'`);
  return rows[0] as { sheet_attachment_id: string | null; updated_at: Date };
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
  app.use('/api/bands/:bandId/songs/:songId/sheet', bandSongSheetRouter);
  app.use('/api/bands/:bandId/songs', bandSongsRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const SHEET = '/api/bands/b1/songs/song1/sheet';

describe('song sheet', () => {
  it('lets only editors of the band set it', async () => {
    expect((await call('PUT', SHEET, undefined, { attachmentId: 'pdf1' })).status).toBe(401);
    expect((await call('PUT', SHEET, 'viewer', { attachmentId: 'pdf1' })).status).toBe(403);
    expect((await call('PUT', SHEET, 'other', { attachmentId: 'pdf1' })).status).toBe(403);
    expect((await call('PUT', '/api/bands/b2/songs/song1/sheet', 'other', { attachmentId: 'pdf1' })).status).toBe(404);
    expect((await songRow()).sheet_attachment_id).toBeNull();
  });

  it("only takes one of the song's own attachments", async () => {
    expect((await call('PUT', SHEET, 'editor', { attachmentId: 'pdf2' })).status).toBe(404);
    expect((await call('PUT', SHEET, 'editor', { attachmentId: 42 })).status).toBe(400);
    expect((await call('PUT', SHEET, 'editor', { attachmentId: 'zip1' })).status).toBe(400);
    expect((await songRow()).sheet_attachment_id).toBeNull();
  });

  it('saves it without a revision or a new updatedAt, and lists it with the song', async () => {
    const before = await songRow();
    const revisions = await revisionCount();
    const res = await call('PUT', SHEET, 'editor', { attachmentId: 'pdf1' });
    expect(res.status).toBe(200);
    expect(res.json.sheetAttachmentId).toBe('pdf1');
    const after = await songRow();
    expect(after.sheet_attachment_id).toBe('pdf1');
    expect(after.updated_at).toEqual(before.updated_at);
    expect(await revisionCount()).toBe(revisions);

    const list = await call('GET', '/api/bands/b1/songs', 'viewer');
    expect(list.json.songs.find((s: { id: string }) => s.id === 'song1').sheetAttachmentId).toBe('pdf1');
  });

  it('is left alone by a song save', async () => {
    const saved = await call('PUT', '/api/bands/b1/songs/song1', 'editor', { title: 'Song', language: 'en', chordpro: '', sheetAttachmentId: null });
    expect(saved.status).toBe(200);
    expect((await songRow()).sheet_attachment_id).toBe('pdf1');
  });

  it('is cleared with null, and when the attachment goes', async () => {
    expect((await call('PUT', SHEET, 'editor', { attachmentId: null })).json.sheetAttachmentId).toBeNull();
    expect((await songRow()).sheet_attachment_id).toBeNull();

    await call('PUT', SHEET, 'editor', { attachmentId: 'pdf1' });
    await h.query(`DELETE FROM attachments WHERE id = 'pdf1'`);
    expect((await songRow()).sheet_attachment_id).toBeNull();
  });
});
