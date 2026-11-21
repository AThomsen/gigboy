// @vitest-environment node
/** /api/ultimate-guitar over real HTTP, with Ultimate Guitar itself replaced by a fake fetch. */
import type { AddressInfo } from 'node:net';
import express, { type RequestHandler } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The session middleware imports the database client; these routes never touch it.
vi.mock('../db/client.js', () => ({ db: {} }));

const { createUltimateGuitarRouter } = await import('./ultimateGuitar.js');
const { createUltimateGuitarService } = await import('../lib/ultimateGuitar.js');

/** A page shaped like UG's: page data as HTML-escaped JSON in the js-store div. */
function ugPage(data: unknown): string {
  const json = JSON.stringify({ store: { page: { data } } }).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return `<div class="js-store" data-content="${json}"></div>`;
}

// "Amazing Grace" (John Newton, 1779) is in the public domain.
const ugRequests: string[] = [];
const fakeUltimateGuitar = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  ugRequests.push(url);
  if (url.includes('/search.php')) {
    return new Response(ugPage({
      pagination: { current: 1, total: 1 },
      results: [{ song_name: 'Amazing Grace', artist_name: 'John Newton', type: 'Chords', votes: 3, tab_url: 'https://tabs.ultimate-guitar.com/tab/x/amazing-grace-chords-1' }],
    }));
  }
  return new Response(ugPage({
    tab: { song_name: 'Amazing Grace', artist_name: 'John Newton', type: 'Chords', tab_url: url },
    tab_view: { meta: { capo: 3 }, wiki_tab: { content: '[ch]G[/ch]\nAmazing grace' } },
  }));
}) as typeof fetch;

let baseUrl: string;
let server: ReturnType<express.Express['listen']>;
// Each test mounts a fresh router (and so a fresh cache and request cap).
let router: RequestHandler;

function mount(options: { enabled?: boolean; maxRequestsPerHour?: number } = {}) {
  router = createUltimateGuitarRouter({
    enabled: options.enabled ?? true,
    service: createUltimateGuitarService({ fetchImpl: fakeUltimateGuitar, maxRequestsPerHour: options.maxRequestsPerHour }),
  });
}

beforeAll(async () => {
  const app = express();
  app.use((req, _res, next) => {
    const user = req.header('x-user-id');
    if (user) req.userId = user;
    next();
  });
  app.use('/api/ultimate-guitar', (req, res, next) => router(req, res, next));
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ultimate-guitar`;
});

beforeEach(() => {
  ugRequests.length = 0;
  mount();
});

afterAll(() => {
  server?.close();
});

async function get(path: string, signedIn = true) {
  const res = await fetch(`${baseUrl}${path}`, { headers: signedIn ? { 'x-user-id': 'u1' } : {} });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const SONG_LINK = `/tab?url=${encodeURIComponent('tabs.ultimate-guitar.com/tab/x/amazing-grace-chords-1')}`;

describe('/api/ultimate-guitar', () => {
  it('requires sign-in', async () => {
    expect((await get('/search?q=amazing', false)).status).toBe(401);
    expect((await get('/status', false)).status).toBe(401);
    expect(ugRequests).toHaveLength(0);
  });

  it('searches by title', async () => {
    const res = await get('/search?q=amazing%20grace');
    expect(res.status).toBe(200);
    expect((res.body.results as unknown[])).toHaveLength(1);
    expect(ugRequests[0]).toBe('https://www.ultimate-guitar.com/search.php?search_type=title&value=amazing+grace');
  });

  it('rejects a too-short search without asking UG', async () => {
    expect((await get('/search?q=r')).status).toBe(400);
    expect(ugRequests).toHaveLength(0);
  });

  it('fetches a song by link', async () => {
    const res = await get(SONG_LINK);
    expect(res.status).toBe(200);
    expect(res.body.tab).toMatchObject({ title: 'Amazing Grace', capo: 3, content: '[ch]G[/ch]\nAmazing grace' });
    expect(ugRequests).toEqual(['https://tabs.ultimate-guitar.com/tab/x/amazing-grace-chords-1']);
  });

  it('never fetches a link to another site', async () => {
    const res = await get(`/tab?url=${encodeURIComponent('http://127.0.0.1:6168/api/admin/users')}`);
    expect(res.status).toBe(400);
    expect(ugRequests).toHaveLength(0);
  });

  it('answers repeats from its cache', async () => {
    await get('/search?q=amazing%20grace');
    await get('/search?q=Amazing%20Grace');
    await get(SONG_LINK);
    // The same song, linked differently: normalized to the same cache entry.
    await get(`/tab?url=${encodeURIComponent('https://tabs.ultimate-guitar.com/tab/x/amazing-grace-chords-1?app=ios')}`);
    expect(ugRequests).toHaveLength(2);
  });

  it('caps requests to UG per hour, but still serves the cache', async () => {
    mount({ maxRequestsPerHour: 2 });
    expect((await get('/search?q=one')).status).toBe(200);
    expect((await get('/search?q=two')).status).toBe(200);
    const capped = await get('/search?q=three');
    expect(capped.status).toBe(429);
    expect(capped.body.error).toMatch(/Too many Ultimate Guitar lookups/);
    expect((await get('/search?q=one')).status).toBe(200);
    expect(ugRequests).toHaveLength(2);
  });

  it('reports its status, and turns search and link import off when disabled', async () => {
    expect((await get('/status')).body).toEqual({ searchEnabled: true });

    mount({ enabled: false });
    expect((await get('/status')).body).toEqual({ searchEnabled: false });
    expect((await get('/search?q=amazing')).status).toBe(404);
    expect((await get(SONG_LINK)).status).toBe(404);
    expect(ugRequests).toHaveLength(0);
  });
});
