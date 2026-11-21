import { decodeHTML } from 'entities';

/**
 * Reading songs from Ultimate Guitar (UG). UG pages can't be read from the browser (no CORS), so
 * the server fetches them. Both search and song pages embed their data as JSON in a
 * `<div class="js-store" data-content="…">` element, which is what's parsed here. The JSON is
 * HTML-escaped as an attribute, and UG's text inside it (titles, artists, lyrics) is HTML-escaped
 * once more, e.g. `Br&oslash;drene`, so both layers are decoded.
 *
 * Only free versions can be read: requests are anonymous, so UG never includes the content of
 * paid (Pro/Official) versions. Those are imported from the UG app's share file instead.
 */

const ALLOWED_HOSTS = new Set(['www.ultimate-guitar.com', 'tabs.ultimate-guitar.com']);
const FETCH_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 3 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const USER_AGENT = 'Gigboy (self-hosted song import; +https://github.com/blindpassasjer/gigboy)';

export const PAID_VERSION_MESSAGE =
  'That’s a paid (Pro/Official) version, which can only be read with a UG license. In the Ultimate Guitar app, open it and use Share → Save to Files, then import that file here.';

/** An error whose message is meant for the user. */
export class UltimateGuitarError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'UltimateGuitarError';
  }
}

export interface UltimateGuitarSearchResult {
  title: string;
  artist: string;
  /** "Chords", "Tabs", "Ukulele Chords", "Bass Tabs", or "Official"/"Pro" for paid versions. */
  type: string;
  version: number | null;
  rating: number | null;
  votes: number | null;
  url: string;
  /** Pro/Official versions: listed, but their content can't be fetched. */
  paid: boolean;
}

export interface UltimateGuitarSearchPage {
  results: UltimateGuitarSearchResult[];
  page: number;
  totalPages: number;
}

export interface UltimateGuitarTab {
  title: string;
  artist: string;
  key: string | null;
  capo: number | null;
  type: string;
  /** UG's own markup: `[ch]…[/ch]` chords, `[tab]…[/tab]` blocks, `[Verse]` section headers. */
  content: string;
  url: string;
}

const FREE_TYPES = new Set(['Chords', 'Tabs', 'Ukulele Chords', 'Bass Tabs']);

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** UG's text values are HTML-escaped (`&oslash;`, `&ndash;`, `&#039;`): decode to plain text. */
function asText(value: unknown): string | null {
  const raw = asString(value);
  return raw === null ? null : decodeHTML(raw).trim() || null;
}

/** Returns the page data (`store.page.data`) embedded in a UG page, or null if there is none. */
export function extractPageData(html: string): Json | null {
  const tag = /<div[^>]*\bclass="js-store"[^>]*>/.exec(html)?.[0];
  const encoded = tag ? /\bdata-content="([^"]*)"/.exec(tag)?.[1] : undefined;
  if (!encoded) return null;
  try {
    const store = JSON.parse(decodeHTML(encoded)) as unknown;
    const page = asObject(asObject(asObject(store)?.store)?.page);
    return asObject(page?.data);
  } catch {
    return null;
  }
}

/**
 * Normalizes a link to a UG song page (with or without scheme, www or tabs host) to its https
 * URL. Throws for anything else, so the server never fetches arbitrary URLs.
 */
export function normalizeTabUrl(input: string): string {
  const trimmed = input.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    throw new UltimateGuitarError('That isn’t a link to an Ultimate Guitar song.', 400);
  }
  const host = url.hostname.toLowerCase().replace(/^ultimate-guitar\.com$/, 'www.ultimate-guitar.com');
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !ALLOWED_HOSTS.has(host)) {
    throw new UltimateGuitarError('That isn’t a link to an Ultimate Guitar song.', 400);
  }
  if (url.pathname.startsWith('/pro/')) throw new UltimateGuitarError(PAID_VERSION_MESSAGE, 422);
  if (!url.pathname.startsWith('/tab/')) {
    throw new UltimateGuitarError('That link isn’t a song page. Open the song on Ultimate Guitar and copy its link.', 400);
  }
  return `https://${host}${url.pathname}`;
}

export function buildSearchUrl(query: string, page: number): string {
  const url = new URL('https://www.ultimate-guitar.com/search.php');
  url.searchParams.set('search_type', 'title');
  url.searchParams.set('value', query);
  if (page > 1) url.searchParams.set('page', String(page));
  return url.toString();
}

export function parseSearchPage(data: Json): UltimateGuitarSearchPage {
  const raw = Array.isArray(data.results) ? data.results : [];
  const seen = new Set<string>();
  const results: UltimateGuitarSearchResult[] = [];

  for (const entry of raw) {
    const item = asObject(entry);
    const url = asString(item?.tab_url);
    const title = asText(item?.song_name);
    if (!item || !url || !title || seen.has(url)) continue;

    const marketingType = asString(item.marketing_type);
    const paid = Boolean(marketingType) || url.includes('/pro/');
    const type = paid ? (marketingType?.toLowerCase() === 'official' ? 'Official' : 'Pro') : asText(item.type);
    if (!type || (!paid && !FREE_TYPES.has(type))) continue;

    seen.add(url);
    results.push({
      title,
      artist: asText(item.artist_name) ?? '',
      type,
      version: asNumber(item.version),
      rating: asNumber(item.rating),
      votes: asNumber(item.votes),
      url,
      paid,
    });
  }

  // Free versions first, most-voted first; paid ones last, as pointers to the UG app.
  results.sort((a, b) => Number(a.paid) - Number(b.paid) || (b.votes ?? 0) - (a.votes ?? 0));

  const pagination = asObject(data.pagination);
  return {
    results,
    page: asNumber(pagination?.current) ?? 1,
    totalPages: asNumber(pagination?.total) ?? 1,
  };
}

export function parseTabPage(data: Json, fallbackUrl: string): UltimateGuitarTab {
  const tab = asObject(data.tab);
  const view = asObject(data.tab_view);
  const meta = asObject(view?.meta);
  const content = asText(asObject(view?.wiki_tab)?.content);
  if (!tab) {
    throw new UltimateGuitarError('Ultimate Guitar didn’t return a song for that link.', 502);
  }
  if (!content) throw new UltimateGuitarError(PAID_VERSION_MESSAGE, 422);

  return {
    title: asText(tab.song_name) ?? '',
    artist: asText(tab.artist_name) ?? '',
    key: asText(tab.tonality_name) ?? asText(meta?.tonality),
    capo: asNumber(meta?.capo) || null,
    type: asText(tab.type) ?? 'Chords',
    content: content.replace(/\r\n?/g, '\n'),
    url: asString(tab.tab_url) ?? fallbackUrl,
  };
}

function assertAllowed(url: URL): void {
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname.toLowerCase())) {
    throw new UltimateGuitarError('Ultimate Guitar sent an unexpected redirect.', 502);
  }
}

async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new UltimateGuitarError('Ultimate Guitar sent an unexpectedly large page.', 502);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Fetches a page from Ultimate Guitar and returns its embedded data. Only the two UG hosts are
 * ever requested, including on redirects.
 */
export async function fetchPageData(target: string, fetchImpl: typeof fetch = fetch): Promise<Json> {
  let url = new URL(target);
  assertAllowed(url);

  for (let redirects = 0; ; redirects += 1) {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
      });
    } catch {
      throw new UltimateGuitarError('Ultimate Guitar didn’t respond. Please try again.', 504);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location || redirects >= MAX_REDIRECTS) {
        throw new UltimateGuitarError('Ultimate Guitar sent an unexpected redirect.', 502);
      }
      url = new URL(location, url);
      assertAllowed(url);
      continue;
    }

    if (response.status === 404) {
      throw new UltimateGuitarError('Ultimate Guitar has no song at that link.', 404);
    }
    const html = response.ok ? await readCapped(response) : '';
    const data = html ? extractPageData(html) : null;
    if (!data) {
      // Anything else (403, 429, a bot challenge page) means UG won't serve this server.
      throw new UltimateGuitarError(
        'Ultimate Guitar blocked the request from this server. Import the song from the UG app (Share → Save to Files), or copy the chords and paste them into the song form.',
        502,
      );
    }
    return data;
  }
}

// --- Search toggle, cache and request cap --------------------------------------------------

/**
 * `ULTIMATE_GUITAR_SEARCH` (default true) switches the server's lookups on UG (search and link
 * import) on or off. Importing the UG app's share file never contacts UG and works either way.
 */
export function readUltimateGuitarSearchEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.ULTIMATE_GUITAR_SEARCH?.trim().toLowerCase();
  if (!raw) return true;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new Error(`ULTIMATE_GUITAR_SEARCH must be "true" or "false" (got "${env.ULTIMATE_GUITAR_SEARCH}").`);
}

/**
 * `ULTIMATE_GUITAR_MAX_REQUESTS_PER_HOUR` (default 60): how many requests the server may send UG
 * in a rolling hour, across all users. Cached answers don't count.
 */
export function readUltimateGuitarMaxRequestsPerHour(env: Record<string, string | undefined> = process.env): number {
  const raw = env.ULTIMATE_GUITAR_MAX_REQUESTS_PER_HOUR?.trim();
  if (!raw) return 60;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`ULTIMATE_GUITAR_MAX_REQUESTS_PER_HOUR must be a whole number of at least 1 (got "${raw}").`);
  }
  return value;
}

const HOUR_MS = 60 * 60 * 1000;

/** A size-capped cache with per-entry expiry. The oldest entry goes first when it's full. */
class ExpiringCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();

  constructor(private readonly maxEntries: number, private readonly now: () => number) {}

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V, ttlMs: number): void {
    this.entries.delete(key);
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
  }
}

export interface UltimateGuitarServiceOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Requests to UG allowed per rolling hour, across all users. Cache hits don't count. */
  maxRequestsPerHour?: number;
}

/**
 * Search and song lookups with a cache and a server-wide cap, so a self-hosted server never
 * sends UG more than a trickle of requests (and repeats none of them).
 */
export function createUltimateGuitarService({
  fetchImpl = fetch,
  now = Date.now,
  maxRequestsPerHour = readUltimateGuitarMaxRequestsPerHour(),
}: UltimateGuitarServiceOptions = {}) {
  const searches = new ExpiringCache<UltimateGuitarSearchPage>(300, now);
  const tabs = new ExpiringCache<UltimateGuitarTab>(500, now);
  const recentRequests: number[] = [];

  async function fetchCapped(url: string): Promise<Json> {
    const cutoff = now() - HOUR_MS;
    while (recentRequests.length > 0 && recentRequests[0] <= cutoff) recentRequests.shift();
    if (recentRequests.length >= maxRequestsPerHour) {
      throw new UltimateGuitarError(
        'Too many Ultimate Guitar lookups from this server in the last hour. Try again later, or import the song from the UG app (Share → Save to Files).',
        429,
      );
    }
    recentRequests.push(now());
    return fetchPageData(url, fetchImpl);
  }

  return {
    async search(query: string, page: number): Promise<UltimateGuitarSearchPage> {
      const key = `${query.trim().toLowerCase()}\n${page}`;
      const cached = searches.get(key);
      if (cached) return cached;
      const result = parseSearchPage(await fetchCapped(buildSearchUrl(query.trim(), page)));
      searches.set(key, result, 24 * HOUR_MS);
      return result;
    },

    /** `link` is any link to a UG song page; it's normalized (and checked) first. */
    async getTab(link: string): Promise<UltimateGuitarTab> {
      const url = normalizeTabUrl(link);
      const cached = tabs.get(url);
      if (cached) return cached;
      const tab = parseTabPage(await fetchCapped(url), url);
      tabs.set(url, tab, 30 * 24 * HOUR_MS);
      return tab;
    },
  };
}
