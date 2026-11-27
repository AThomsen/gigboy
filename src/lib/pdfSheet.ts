import type { PDFDocumentProxy } from 'pdfjs-dist';

/**
 * Loading for PdfSheet (a song's PDF attachment shown as its chart). pdf.js is imported on
 * first use, so songs without a sheet don't pay for it.
 */

type PdfJs = typeof import('pdfjs-dist');

export type PdfPageSize = { width: number; height: number };

/** An open PDF and its pages' sizes at scale 1 (PDF points), to lay them out before drawing. */
export interface LoadedPdfSheet {
  doc: PDFDocumentProxy;
  sizes: PdfPageSize[];
}

let pdfjsPromise: Promise<PdfJs> | null = null;
function loadPdfJs(): Promise<PdfJs> {
  pdfjsPromise ??= Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ]).then(([pdfjs, worker]) => {
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    return pdfjs;
  }).catch((err: unknown) => {
    pdfjsPromise = null;
    throw err;
  });
  return pdfjsPromise;
}

// Concert Mode moves back and forth between the same few songs: keep their documents open.
const CACHE_SIZE = 8;
const pending = new Map<string, Promise<LoadedPdfSheet>>();
// The loaded ones, for a sheet shown again (a swipe peek, a song come back to) to be laid out
// on its first render — Concert Mode counts its pages from that layout.
const loaded = new Map<string, LoadedPdfSheet>();

async function openSheet(url: string): Promise<LoadedPdfSheet> {
  const pdfjs = await loadPdfJs();
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) throw new Error(`Could not load the PDF (${response.status}).`);
  const data = new Uint8Array(await response.arrayBuffer());
  const doc = await pdfjs.getDocument({ data }).promise;
  const sizes: PdfPageSize[] = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    const { width, height } = (await doc.getPage(i)).getViewport({ scale: 1 });
    sizes.push({ width, height });
  }
  return { doc, sizes };
}

export function loadPdfSheet(url: string): Promise<LoadedPdfSheet> {
  const existing = pending.get(url);
  if (existing) {
    // Most recently used goes last.
    pending.delete(url);
    pending.set(url, existing);
    return existing;
  }
  const promise = openSheet(url);
  pending.set(url, promise);
  promise.then(
    (sheet) => { if (pending.get(url) === promise) loaded.set(url, sheet); },
    () => { if (pending.get(url) === promise) pending.delete(url); },
  );
  while (pending.size > CACHE_SIZE) {
    const [oldestUrl, oldest] = pending.entries().next().value!;
    pending.delete(oldestUrl);
    loaded.delete(oldestUrl);
    void oldest.then((sheet) => sheet.doc.loadingTask.destroy()).catch(() => {});
  }
  return promise;
}

/** The sheet at `url` if it's already loaded. */
export function loadedPdfSheet(url: string): LoadedPdfSheet | null {
  return loaded.get(url) ?? null;
}

/** Starts loading a sheet ahead of showing it (the next song in a set). */
export function preloadPdfSheet(url: string): void {
  void loadPdfSheet(url).catch(() => {});
}
