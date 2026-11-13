/**
 * Running as an installed app (home-screen PWA): no pinch- or double-tap zoom anywhere,
 * like a native app. In a browser tab, pages stay zoomable as people expect from a website
 * (concert mode blocks zoom there itself).
 *
 * iOS ignores `user-scalable=no` in the viewport meta, so this uses `touch-action` on the
 * root (pinch zoom is the root's default action, so that turns it off for every element)
 * plus Safari's own gesture events, which can still zoom without it.
 */
export function isInstalledApp(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(display-mode: standalone)').matches === true
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export function disableZoomInInstalledApp(): void {
  if (!isInstalledApp()) return;
  document.documentElement.classList.add('no-zoom');
  const block = (e: Event) => e.preventDefault();
  document.addEventListener('gesturestart', block);
  document.addEventListener('gesturechange', block);
}
