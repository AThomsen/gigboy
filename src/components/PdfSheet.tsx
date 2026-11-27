import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RenderTask } from 'pdfjs-dist';
import { loadedPdfSheet, loadPdfSheet, type LoadedPdfSheet } from '../lib/pdfSheet';

/**
 * A song's PDF sheet (lead sheet, sheet music) drawn page by page in place of the ChordPro
 * chart. Pages are as wide as the sheet, or — with `maxPageHeight` — also no taller than that,
 * so Concert Mode's page view shows one whole PDF page per screen.
 */

interface Props {
  url: string;
  /** Fit each page within this height as well as the width (Concert Mode's page view). */
  maxPageHeight?: number;
}

// Mobile Safari refuses canvases much past 16M pixels (and draws nothing).
const MAX_CANVAS_PIXELS = 16_000_000;

export default function PdfSheet({ url, maxPageHeight }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([]);
  const [loaded, setLoaded] = useState<(LoadedPdfSheet & { url: string }) | null>(null);
  const [failure, setFailure] = useState<{ url: string; message: string } | null>(null);
  const error = failure?.url === url ? failure.message : null;
  const [width, setWidth] = useState(0);
  // This stays mounted from song to song: never lay out another song's sheet meanwhile.
  const cached = loadedPdfSheet(url);
  const current = loaded?.url === url ? loaded : cached;
  const doc = current?.doc ?? null;
  const sizes = current?.sizes ?? [];

  useEffect(() => {
    let cancelled = false;
    loadPdfSheet(url)
      .then((sheet) => {
        if (!cancelled) setLoaded({ url, ...sheet });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.error('Failed to load PDF sheet', err);
        setFailure({
          url,
          message: err instanceof Error && err.message.startsWith('Could not') ? err.message : 'Could not show this PDF.',
        });
      });
    return () => { cancelled = true; };
  }, [url]);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setWidth(Math.floor(el.clientWidth));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Each page's size on screen, in CSS pixels.
  const layout = sizes.map((size) => {
    let scale = width / size.width;
    if (maxPageHeight && maxPageHeight > 0) scale = Math.min(scale, maxPageHeight / size.height);
    return { width: Math.floor(size.width * scale), height: Math.floor(size.height * scale), scale };
  });
  const layoutKey = layout.map((page) => `${page.width}x${page.height}`).join(',');

  useEffect(() => {
    if (!doc || width <= 0 || layout.length === 0) return;
    let cancelled = false;
    let task: RenderTask | null = null;
    // Draw new pages straight away; redrawing on every resize step would be wasted, so wait
    // for the size to settle.
    const redraw = canvasRefs.current.slice(0, layout.length).every((canvas) => canvas?.dataset.drawn);
    const timer = window.setTimeout(() => {
      void (async () => {
        const dpr = window.devicePixelRatio || 1;
        for (let i = 0; i < layout.length; i += 1) {
          const canvas = canvasRefs.current[i];
          if (cancelled || !canvas) return;
          const page = await doc.getPage(i + 1);
          if (cancelled) return;
          const { scale } = layout[i];
          let pixelScale = scale * dpr;
          const base = page.getViewport({ scale: 1 });
          const pixels = base.width * base.height * pixelScale * pixelScale;
          if (pixels > MAX_CANVAS_PIXELS) pixelScale *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);
          const viewport = page.getViewport({ scale: pixelScale });
          // Draw off-screen, then swap in, so a redraw doesn't blank the page meanwhile.
          const offscreen = document.createElement('canvas');
          offscreen.width = Math.floor(viewport.width);
          offscreen.height = Math.floor(viewport.height);
          task = page.render({ canvas: offscreen, viewport });
          try {
            await task.promise;
          } catch {
            return; // cancelled
          }
          if (cancelled) return;
          canvas.width = offscreen.width;
          canvas.height = offscreen.height;
          canvas.getContext('2d')?.drawImage(offscreen, 0, 0);
          canvas.dataset.drawn = 'true';
        }
      })();
    }, redraw ? 120 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      task?.cancel();
    };
    // layoutKey stands for layout's contents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, layoutKey]);

  return (
    <div className="pdf-sheet" ref={containerRef}>
      {error ? (
        <p className="pdf-sheet-message pdf-sheet-message--error">{error}</p>
      ) : layout.length === 0 ? (
        <p className="pdf-sheet-message">Loading sheet…</p>
      ) : (
        layout.map((page, i) => (
          <div
            // Fresh canvases for another song's sheet, so its pages never show meanwhile.
            key={`${url}#${i}`}
            className="pdf-sheet-page"
            style={{ width: page.width, height: page.height }}
            data-page-number={i + 1}
          >
            <canvas
              ref={(el) => { canvasRefs.current[i] = el; }}
              aria-label={`Page ${i + 1} of the sheet`}
              role="img"
            />
          </div>
        ))
      )}
    </div>
  );
}
