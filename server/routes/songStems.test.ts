// @vitest-environment node
/**
 * Song stems: editor-only uploads by name (replace in place), listing, ranged downloads, deletes,
 * quota and file cleanup — real Express app over HTTP, backed by an in-memory Postgres (PGlite)
 * built from the real drizzle migrations. Auth is shimmed to an `x-user-id` header.
 */
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  // trash.ts (pulled in by the CRUD builder) imports the storage adapter, which insists on this being set.
  process.env.ATTACHMENTS_DIR = `/tmp/gigboy-stems-${process.pid}`; // hoisted code can't use the imports below
  return { ready: null as unknown as Promise<void>, exec: null as unknown as (sql: string) => Promise<unknown> };
});

vi.mock('../db/client.js', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const schema = await import('../db/schema.js');
  const client = new PGlite();
  const db = drizzle(client, { schema: schema as unknown as Record<string, unknown> });
  h.exec = (sql) => client.exec(sql);
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
        ('other',  'o@x', 'o@x', 'other',  'x'), ('ed2', 'e2@x', 'e2@x', 'ed2', 'x');
      INSERT INTO users (id, email, email_lower, username, password_hash, role) VALUES ('admin', 'a@x', 'a@x', 'admin', 'x', 'admin'), ('admin2', 'a2@x', 'a2@x', 'admin2', 'x', 'admin');
      INSERT INTO bands (id, name, owner_id) VALUES ('b1', 'Band; One', 'editor'), ('b2', 'Other', 'other');
      INSERT INTO band_members (band_id, user_id, role) VALUES
        ('b1', 'editor', 'editor'), ('b1', 'viewer', 'viewer'), ('b2', 'other', 'editor');
      INSERT INTO songs (id, band_id, title, language, chordpro) VALUES
        ('song1', 'b1', 'Song One', 'en', '{title: Song One}'), ('song2', 'b2', 'Foreign', 'en', '');
      INSERT INTO band_members (band_id, user_id, role) VALUES ('b1', 'ed2', 'editor');
      INSERT INTO setlists (id, band_id, name) VALUES ('s1', 'b1', 'Set One'), ('s2', 'b2', 'Foreign Set');
    `);
  })();
  return { db };
});

const { bandSongStemsRouter } = await import('./songStems.js');
const { getBandStorageBreakdown } = await import('../lib/storageQuota.js');
const { deleteSongFiles } = await import('../lib/songFiles.js');

let base: string;
let server: ReturnType<express.Express['listen']>;
const filesDir = process.env.ATTACHMENTS_DIR!;

async function call(method: string, path: string, user?: string, body?: FormData, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(user ? { 'x-user-id': user } : {}), ...headers },
    body,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json: Record<string, any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = JSON.parse(buf.toString('utf8')); } catch { /* binary */ }
  return { status: res.status, json, buf, headers: res.headers };
}

const stemForm = (bytes: Buffer, type = 'audio/mpeg', extra: Record<string, string> = {}) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(extra)) f.append(k, v);
  f.append('file', new Blob([new Uint8Array(bytes)], { type }), 'stem.mp3');
  return f;
};

const S = '/api/bands/b1/songs/song1/stems';
const stemFiles = () => (existsSync(join(filesDir, 'song1', 'stems')) ? readdirSync(join(filesDir, 'song1', 'stems')) : []);

beforeAll(async () => {
  await h.ready;
  const app = express();
  app.use((req, _res, next) => {
    const u = req.header('x-user-id');
    if (u) (req as unknown as { userId?: string }).userId = u;
    next();
  });
  app.use('/api/bands/:bandId/songs/:songId/stems', bandSongStemsRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => { server.close(); rmSync(filesDir, { recursive: true, force: true }); });

describe('song stems', () => {
  const vocals = Buffer.from('vocals-audio-0123456789');
  const drums = Buffer.from('drums-audio');

  it('lets editors upload stems by name with duration, waveform and order', async () => {
    const up = await call('PUT', `${S}/vocals`, 'editor', stemForm(vocals, 'audio/mpeg', {
      durationMs: '183093.4', sortOrder: '10', waveformBars: JSON.stringify([0.5, 2, -1, 'x', 0.25]),
    }));
    expect(up.status).toBe(200);
    expect(up.json.stem).toMatchObject({ name: 'vocals', durationMs: 183093, sortOrder: 10, sizeBytes: vocals.length, mimeType: 'audio/mpeg' });
    expect(up.json.stem.waveformBars).toEqual([0.5, 1, 0, 0.25]);
    expect(up.json.stem.downloadUrl).toMatch(new RegExp(`^${S}/${up.json.stem.id}/download\\?v=\\d+$`));

    const dr = await call('PUT', `${S}/drums`, 'editor', stemForm(drums, 'audio/wav', { sortOrder: '30' }));
    expect(dr.status).toBe(200);
    expect(stemFiles().some((f) => f.startsWith('drums-') && f.endsWith('.wav'))).toBe(true);
  });

  it('lists stems for any member in mixer order', async () => {
    const list = await call('GET', S, 'viewer');
    expect(list.status).toBe(200);
    expect(list.json.stems.map((s: { name: string }) => s.name)).toEqual(['vocals', 'drums']);
  });

  it('rejects viewers, strangers, anonymous callers, bad names, non-audio and empty uploads', async () => {
    expect((await call('PUT', `${S}/bass`, 'viewer', stemForm(drums))).status).toBe(403);
    expect((await call('PUT', `${S}/bass`, 'other', stemForm(drums))).status).toBe(403);
    expect((await call('PUT', `${S}/bass`, undefined, stemForm(drums))).status).toBe(401);
    expect((await call('PUT', `${S}/Bad%20Name`, 'editor', stemForm(drums))).status).toBe(400);
    expect((await call('PUT', `${S}/bass`, 'editor', stemForm(drums, 'text/plain'))).status).toBe(400);
    expect((await call('PUT', `${S}/bass`, 'editor', stemForm(drums, 'audio/mp4'))).status).toBe(400); // AAC: not playable
    expect((await call('PUT', `${S}/bass`, 'editor', new FormData())).status).toBe(400);
    expect((await call('GET', S, 'other')).status).toBe(403);
    expect((await call('GET', '/api/bands/b1/songs/song2/stems', 'editor')).status).toBe(404);
    const list = await call('GET', S, 'editor');
    const id = list.json.stems[0].id;
    expect((await call('DELETE', `${S}/${id}`, 'viewer')).status).toBe(403);
    expect((await call('DELETE', S, 'viewer')).status).toBe(403);
  });

  it('serves stems with Range support', async () => {
    const list = await call('GET', S, 'viewer');
    const stem = list.json.stems.find((s: { name: string }) => s.name === 'vocals');
    const full = await call('GET', stem.downloadUrl, 'viewer');
    expect(full.status).toBe(200);
    expect(full.buf.equals(vocals)).toBe(true);
    expect(full.headers.get('content-type')).toBe('audio/mpeg');
    const part = await call('GET', stem.downloadUrl, 'viewer', undefined, { range: 'bytes=0-5' });
    expect(part.status).toBe(206);
    expect(part.buf.toString()).toBe('vocals');
  });

  it('replaces a stem with the same name in place and removes the old file', async () => {
    const before = (await call('GET', S, 'editor')).json.stems.find((s: { name: string }) => s.name === 'vocals');
    const oldFiles = stemFiles().filter((f) => f.startsWith('vocals-'));
    expect(oldFiles).toHaveLength(1);

    const replacement = Buffer.from('new-vocals');
    const up = await call('PUT', `${S}/vocals`, 'editor', stemForm(replacement, 'audio/wav', { sortOrder: '10' }));
    expect(up.status).toBe(200);
    expect(up.json.stem.id).toBe(before.id);
    expect(up.json.stem.downloadUrl).not.toBe(before.downloadUrl);

    const vocalFiles = stemFiles().filter((f) => f.startsWith('vocals-'));
    expect(vocalFiles).toHaveLength(1);
    expect(vocalFiles[0]).not.toBe(oldFiles[0]);
    expect(vocalFiles[0].endsWith('.wav')).toBe(true);
    expect((await call('GET', S, 'editor')).json.stems).toHaveLength(2);
    expect((await call('GET', up.json.stem.downloadUrl, 'viewer')).buf.equals(replacement)).toBe(true);
  });

  it('counts stems in the band storage breakdown and enforces the quota with 413', async () => {
    const breakdown = await getBandStorageBreakdown('b1');
    expect(breakdown.stemBytes).toBe(Buffer.from('new-vocals').length + drums.length);

    await h.exec("UPDATE users SET storage_quota_bytes = 30 WHERE id = 'editor'");
    const res = await call('PUT', `${S}/bass`, 'editor', stemForm(Buffer.alloc(20)));
    expect(res.status).toBe(413);
    expect(res.json.error).toMatch(/quota/i);
    // Replacing only counts the size difference, so a same-size replacement still fits.
    expect((await call('PUT', `${S}/drums`, 'editor', stemForm(Buffer.from('drums-again')))).status).toBe(200);
    await h.exec("UPDATE users SET storage_quota_bytes = NULL WHERE id = 'editor'");
  });

  it('deletes one stem, then all of them, with their files', async () => {
    const stems = (await call('GET', S, 'editor')).json.stems;
    const del = await call('DELETE', `${S}/${stems[0].id}`, 'editor');
    expect(del.status).toBe(200);
    expect((await call('GET', S, 'editor')).json.stems).toHaveLength(1);
    expect(stemFiles()).toHaveLength(1);

    await call('PUT', `${S}/bass`, 'editor', stemForm(drums));
    const all = await call('DELETE', S, 'editor');
    expect(all.json.deleted).toBe(2);
    expect((await call('GET', S, 'editor')).json.stems).toHaveLength(0);
    expect(stemFiles()).toHaveLength(0);
  });

  it('removes stem files when the song is deleted', async () => {
    await call('PUT', `${S}/vocals`, 'editor', stemForm(vocals));
    expect(stemFiles()).toHaveLength(1);
    await deleteSongFiles('song1');
    expect(stemFiles()).toHaveLength(0);
  });
});
