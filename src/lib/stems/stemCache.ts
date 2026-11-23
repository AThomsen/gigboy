/**
 * Stem files kept compressed in the Cache API, so a song opened once plays without the network
 * and never downloads the same stem twice. Stem download URLs are versioned
 * (`…/download?v=<createdAt>`) and immutable, so a cached entry never needs revalidating: a
 * replaced stem simply gets a new URL. Works in a worker and on the main thread.
 */

const CACHE_NAME = 'gigboy-stems-v1';

/** Cache Storage only holds http(s) responses; demo-mode stems are in-memory blob: URLs. */
function cacheable(url: string): boolean {
  return typeof caches !== 'undefined' && !/^(blob|data):/.test(url);
}

async function download(url: string): Promise<Response> {
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) throw new Error(`Download failed (HTTP ${response.status})`);
  return response;
}

/**
 * The stem file at `url` as a Blob, served from the cache when present, otherwise downloaded and
 * cached. An entry the browser has evicted is simply downloaded again.
 */
export async function getCachedStem(url: string): Promise<Blob> {
  if (!cacheable(url)) return (await download(url)).blob();
  try {
    const cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(url);
    if (hit) return await hit.blob();
    const response = await download(url);
    try {
      await cache.put(url, response.clone());
      // Read back from the cache so the Blob is backed by stored data rather than kept in memory.
      const stored = await cache.match(url);
      if (stored) return await stored.blob();
    } catch (err) {
      console.warn('[stemCache] Could not cache stem (storage full?):', err);
    }
    return await response.blob();
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Download failed')) throw err;
    // Cache storage unusable (e.g. private browsing quirks) — fall back to the network.
    return (await download(url)).blob();
  }
}

/**
 * Removes cached stems of one song that are no longer current (deleted or replaced).
 * `songStemsPath` is the song's stems API path, e.g. `/api/bands/b/songs/s/stems`.
 */
export async function pruneCachedStems(songStemsPath: string, currentUrls: string[]): Promise<void> {
  if (typeof caches === 'undefined') return;
  try {
    const cache = await caches.open(CACHE_NAME);
    const keep = new Set(currentUrls.map((url) => new URL(url, self.location.href).href));
    const prefix = new URL(`${songStemsPath}/`, self.location.href).href;
    for (const request of await cache.keys()) {
      if (request.url.startsWith(prefix) && !keep.has(request.url)) await cache.delete(request);
    }
  } catch (err) {
    console.warn('[stemCache] Could not prune cached stems:', err);
  }
}

let persistRequested = false;

/** Asks the browser to keep cached stems through storage pressure (main thread only). */
export function requestPersistentStorage(): void {
  if (persistRequested || typeof navigator === 'undefined' || !navigator.storage?.persist) return;
  persistRequested = true;
  void navigator.storage.persist().catch(() => {});
}
