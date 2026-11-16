import { useEffect, useState } from 'react';
import { isDemoMode } from '../lib/demo/demoMode';

// Pings per measurement. The server reads its clock somewhere within the round trip, so a
// reading is off by at most half of it: the quickest one is the best. On mobile data round
// trips vary a lot (the radio waking up, a busy cell), so take several.
const SAMPLES = 8;
// Clocks drift apart (and a device can sleep), so measure again now and then.
const RESYNC_MS = 60_000;
// The best reading of the last few rounds is kept, not just of the latest one, so one slow
// round on a poor connection doesn't knock the beat off. Not longer: the clocks drift.
const KEEP_MS = 3 * 60_000;
// Smaller changes than this aren't worth shifting the beat for.
const MIN_CHANGE_MS = 3;

interface Reading {
  rtt: number;
  offset: number;
  /** When it was taken (performance.now()). */
  at: number;
}

async function measure(): Promise<Reading | null> {
  let best: Reading | null = null;
  for (let i = 0; i < SAMPLES; i += 1) {
    try {
      const sent = performance.now();
      const response = await fetch('/api/time', { cache: 'no-store', credentials: 'omit' });
      const received = performance.now();
      if (!response.ok) continue;
      const { now } = (await response.json()) as { now: number };
      const rtt = received - sent;
      // The server read its clock about halfway through the round trip.
      if (typeof now === 'number' && (!best || rtt < best.rtt)) best = { rtt, offset: now - (sent + received) / 2, at: received };
    } catch {
      // offline or a blip: try the next one
    }
  }
  return best;
}

/**
 * How far the server's clock (epoch ms) is ahead of this page's `performance.now()`, so
 * that `performance.now() + offset` reads the same on every device. null until measured,
 * and while `enabled` is false. Lets devices share a beat without sending it around.
 * In the demo (no server; its sessions are tabs on one device) the device's own clock is it.
 */
export function useServerClockOffset(enabled: boolean): number | null {
  const [offset, setOffset] = useState<number | null>(null);

  useEffect(() => {
    if (!enabled) {
      setOffset(null);
      return;
    }
    if (isDemoMode) {
      setOffset(performance.timeOrigin);
      return;
    }
    let cancelled = false;
    let timer = 0;
    let measuring = false;
    let readings: Reading[] = [];
    const run = async () => {
      if (measuring) return;
      measuring = true;
      window.clearTimeout(timer);
      const reading = await measure();
      measuring = false;
      if (cancelled) return;
      if (reading) {
        readings = [...readings.filter((r) => reading.at - r.at < KEEP_MS), reading];
        const best = readings.reduce((a, b) => (b.rtt < a.rtt ? b : a)).offset;
        setOffset((current) => (current === null || Math.abs(current - best) >= MIN_CHANGE_MS ? best : current));
      }
      timer = window.setTimeout(run, RESYNC_MS);
    };
    // Back from the background (or a locked screen): the clocks may have moved apart, so
    // the readings from before don't count.
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      readings = [];
      void run();
    };
    void run();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled]);

  return offset;
}
