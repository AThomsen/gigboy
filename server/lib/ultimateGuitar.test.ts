// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  PAID_VERSION_MESSAGE,
  createUltimateGuitarService,
  readUltimateGuitarMaxRequestsPerHour,
  readUltimateGuitarSearchEnabled,
  extractPageData,
  fetchPageData,
  normalizeTabUrl,
  parseSearchPage,
  parseTabPage,
} from './ultimateGuitar.js';

/** A page shaped like UG's: page data as HTML-escaped JSON in the js-store div. */
function ugPage(data: unknown): string {
  const json = JSON.stringify({ store: { page: { data } } })
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<!doctype html><html><body><div class="js-store" data-content="${json}"></div></body></html>`;
}

// Test songs are public-domain hymns: "Amazing Grace" (John Newton, 1779), and in Danish
// "Der er et yndigt land" (Adam Oehlenschläger, 1819) and "I østen stiger solen op"
// (N. F. S. Grundtvig, 1815).
const TAB_DATA = {
  tab: { song_name: 'Amazing Grace', artist_name: 'John Newton', type: 'Chords', tonality_name: 'G', tab_url: 'https://tabs.ultimate-guitar.com/tab/john-newton/amazing-grace-chords-1' },
  tab_view: {
    meta: { capo: 2, tonality: 'G' },
    wiki_tab: { content: "[Verse 1]\r\n[tab][ch]G[/ch]       [ch]C[/ch]\r\nAmazing grace, how sweet the sound[/tab]" },
  },
};

const SEARCH_DATA = {
  pagination: { current: 1, total: 3 },
  results: [
    { song_name: 'Amazing Grace', artist_name: 'John Newton', marketing_type: 'official', tab_url: 'https://www.ultimate-guitar.com/pro/?tab_id=9' },
    { song_name: 'Amazing Grace', artist_name: 'John Newton', marketing_type: 'TabPro', tab_url: 'https://www.ultimate-guitar.com/pro/?tab_id=9' },
    { song_name: 'Amazing Grace', artist_name: 'John Newton', type: 'Chords', version: 1, rating: 4.5, votes: 40, tab_url: 'https://tabs.ultimate-guitar.com/tab/x/amazing-grace-chords-1' },
    { song_name: 'Amazing Grace', artist_name: 'John Newton', type: 'Video', tab_url: 'https://tabs.ultimate-guitar.com/tab/x/amazing-grace-video-2' },
    { song_name: 'Amazing Grace', artist_name: 'John Newton', type: 'Tabs', version: 2, rating: 4.9, votes: 900, tab_url: 'https://tabs.ultimate-guitar.com/tab/x/amazing-grace-tabs-3' },
  ],
};

describe('extractPageData', () => {
  it('decodes the embedded page data, entities included', () => {
    const data = extractPageData(ugPage(TAB_DATA));
    expect(data).toEqual(TAB_DATA);
  });

  it('returns null for a page without it, like a bot challenge', () => {
    expect(extractPageData('<html><title>Just a moment...</title></html>')).toBeNull();
  });
});

describe('parseSearchPage', () => {
  it('keeps song versions, labels paid ones, and lists free ones first by votes', () => {
    const page = parseSearchPage(SEARCH_DATA);
    expect(page.results.map((r) => [r.type, r.paid])).toEqual([
      ['Tabs', false],
      ['Chords', false],
      ['Official', true],
    ]);
    expect(page.results[0]).toMatchObject({ title: 'Amazing Grace', artist: 'John Newton', rating: 4.9, votes: 900, version: 2 });
    expect(page).toMatchObject({ page: 1, totalPages: 3 });
  });
});

describe('parseTabPage', () => {
  it('returns the song with UG markup and metadata', () => {
    expect(parseTabPage(TAB_DATA, 'fallback')).toEqual({
      title: 'Amazing Grace',
      artist: 'John Newton',
      key: 'G',
      capo: 2,
      type: 'Chords',
      content: "[Verse 1]\n[tab][ch]G[/ch]       [ch]C[/ch]\nAmazing grace, how sweet the sound[/tab]",
      url: 'https://tabs.ultimate-guitar.com/tab/john-newton/amazing-grace-chords-1',
    });
  });

  it('treats capo 0 as no capo', () => {
    const data = { ...TAB_DATA, tab_view: { ...TAB_DATA.tab_view, meta: { capo: 0 } } };
    expect(parseTabPage(data, 'x').capo).toBeNull();
  });

  it('explains paid versions, whose content UG leaves out', () => {
    const data = { tab: TAB_DATA.tab, tab_view: { meta: {} } };
    expect(() => parseTabPage(data, 'x')).toThrow(PAID_VERSION_MESSAGE);
  });
});

describe('HTML entities in UG text', () => {
  // UG HTML-escapes its text inside the JSON as well as the JSON itself: ø arrives as &oslash;
  // after the attribute layer is decoded.
  const DANISH_TAB = {
    tab: { song_name: 'Der er et yndigt land', artist_name: 'Adam Oehlenschl&auml;ger', type: 'Chords', tab_url: 'https://tabs.ultimate-guitar.com/tab/x/y-chords-1' },
    tab_view: { meta: {}, wiki_tab: { content: '[ch]G[/ch]\nDer er et yndigt land,\ndet st&aring;r med brede b&oslash;ge\nn&aelig;r salten &oslash;sterstrand &ndash;' } },
  };

  it('decodes them in the song: artist and lyrics', () => {
    const tab = parseTabPage(extractPageData(ugPage(DANISH_TAB))!, 'x');
    expect(tab.artist).toBe('Adam Oehlenschläger');
    expect(tab.content).toBe('[ch]G[/ch]\nDer er et yndigt land,\ndet står med brede bøge\nnær salten østerstrand –');
  });

  it('decodes them in search results', () => {
    const page = parseSearchPage(extractPageData(ugPage({
      results: [{ song_name: 'I &oslash;sten stiger solen op', artist_name: 'N. F. S. Grundtvig', type: 'Chords', votes: 1, tab_url: 'https://tabs.ultimate-guitar.com/tab/x/y-chords-1' }],
    }))!);
    expect(page.results[0].title).toBe('I østen stiger solen op');
  });
});

describe('normalizeTabUrl', () => {
  it.each([
    ['https://tabs.ultimate-guitar.com/tab/x/song-chords-1?app=ios', 'https://tabs.ultimate-guitar.com/tab/x/song-chords-1'],
    ['tabs.ultimate-guitar.com/tab/x/song-chords-1', 'https://tabs.ultimate-guitar.com/tab/x/song-chords-1'],
    ['http://ultimate-guitar.com/tab/x/song-chords-1', 'https://www.ultimate-guitar.com/tab/x/song-chords-1'],
    ['  https://www.ultimate-guitar.com/tab/x/song-chords-1  ', 'https://www.ultimate-guitar.com/tab/x/song-chords-1'],
  ])('accepts %s', (input, expected) => {
    expect(normalizeTabUrl(input)).toBe(expected);
  });

  it.each([
    'https://evil.example/tab/x',
    'https://ultimate-guitar.com.evil.example/tab/x',
    'https://tabs.ultimate-guitar.com@evil.example/tab/x',
    'file:///etc/passwd',
    'https://tabs.ultimate-guitar.com/search.php?value=x',
    'not a url at all',
  ])('rejects %s', (input) => {
    expect(() => normalizeTabUrl(input)).toThrow();
  });

  it('points paid (/pro/) links to the UG app', () => {
    expect(() => normalizeTabUrl('https://www.ultimate-guitar.com/pro/?tab_id=9')).toThrow(PAID_VERSION_MESSAGE);
  });
});

describe('fetchPageData', () => {
  function fakeFetch(routes: Record<string, () => Response>): typeof fetch {
    return (async (input: string | URL | Request) => {
      const key = String(input instanceof Request ? input.url : input);
      const route = routes[key];
      if (!route) throw new Error(`unexpected fetch of ${key}`);
      return route();
    }) as typeof fetch;
  }

  it('follows redirects that stay on Ultimate Guitar', async () => {
    const data = await fetchPageData(
      'https://tabs.ultimate-guitar.com/tab/a',
      fakeFetch({
        'https://tabs.ultimate-guitar.com/tab/a': () => new Response(null, { status: 301, headers: { location: '/tab/b' } }),
        'https://tabs.ultimate-guitar.com/tab/b': () => new Response(ugPage(TAB_DATA)),
      }),
    );
    expect(data).toEqual(TAB_DATA);
  });

  it('refuses a redirect off Ultimate Guitar', async () => {
    await expect(
      fetchPageData(
        'https://tabs.ultimate-guitar.com/tab/a',
        fakeFetch({
          'https://tabs.ultimate-guitar.com/tab/a': () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }),
        }),
      ),
    ).rejects.toThrow(/unexpected redirect/);
  });

  it('reports being blocked when UG answers with something else', async () => {
    await expect(
      fetchPageData(
        'https://www.ultimate-guitar.com/search.php',
        fakeFetch({ 'https://www.ultimate-guitar.com/search.php': () => new Response('<title>Just a moment...</title>', { status: 403 }) }),
      ),
    ).rejects.toThrow(/blocked the request/);
  });

  it('refuses to fetch other hosts at all', async () => {
    await expect(fetchPageData('https://evil.example/', fakeFetch({}))).rejects.toThrow(/unexpected redirect/);
  });
});

describe('readUltimateGuitarSearchEnabled', () => {
  it('defaults to on, and accepts true/false', () => {
    expect(readUltimateGuitarSearchEnabled({})).toBe(true);
    expect(readUltimateGuitarSearchEnabled({ ULTIMATE_GUITAR_SEARCH: 'false' })).toBe(false);
    expect(readUltimateGuitarSearchEnabled({ ULTIMATE_GUITAR_SEARCH: 'TRUE' })).toBe(true);
  });

  it('rejects anything else, so a typo stops startup', () => {
    expect(() => readUltimateGuitarSearchEnabled({ ULTIMATE_GUITAR_SEARCH: 'off' })).toThrow(/must be "true" or "false"/);
  });
});

describe('createUltimateGuitarService', () => {
  function setup(maxRequestsPerHour: number) {
    let clock = 0;
    const requests: string[] = [];
    const service = createUltimateGuitarService({
      now: () => clock,
      maxRequestsPerHour,
      fetchImpl: (async (input: string | URL | Request) => {
        requests.push(String(input));
        return new Response(ugPage(SEARCH_DATA));
      }) as typeof fetch,
    });
    return { service, requests, advance: (ms: number) => { clock += ms; } };
  }

  it('lets requests through again as the hour rolls on', async () => {
    const { service, advance } = setup(1);
    await service.search('amazing grace', 1);
    advance(30 * 60 * 1000);
    await expect(service.search('newton', 1)).rejects.toThrow(/Too many/);
    advance(31 * 60 * 1000);
    await expect(service.search('newton', 1)).resolves.toMatchObject({ page: 1 });
  });

  it('expires cached searches after a day', async () => {
    const { service, requests, advance } = setup(10);
    await service.search('amazing grace', 1);
    advance(23 * 60 * 60 * 1000);
    await service.search('amazing grace', 1);
    expect(requests).toHaveLength(1);
    advance(2 * 60 * 60 * 1000);
    await service.search('amazing grace', 1);
    expect(requests).toHaveLength(2);
  });

  it('caches per page', async () => {
    const { service, requests } = setup(10);
    await service.search('amazing grace', 1);
    await service.search('amazing grace', 2);
    expect(requests).toHaveLength(2);
  });
});

describe('readUltimateGuitarMaxRequestsPerHour', () => {
  it('defaults to 60, and takes a whole number of at least 1', () => {
    expect(readUltimateGuitarMaxRequestsPerHour({})).toBe(60);
    expect(readUltimateGuitarMaxRequestsPerHour({ ULTIMATE_GUITAR_MAX_REQUESTS_PER_HOUR: ' 200 ' })).toBe(200);
  });

  it.each(['0', '-5', '1.5', 'lots'])('rejects %s', (value) => {
    expect(() => readUltimateGuitarMaxRequestsPerHour({ ULTIMATE_GUITAR_MAX_REQUESTS_PER_HOUR: value })).toThrow(/whole number/);
  });
});
