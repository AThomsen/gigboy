import { Router } from 'express';
import { requireAuth } from '../middleware/session.js';
import {
  UltimateGuitarError,
  createUltimateGuitarService,
  readUltimateGuitarSearchEnabled,
} from '../lib/ultimateGuitar.js';

/** Song search and import from Ultimate Guitar, mounted at /api/ultimate-guitar. */
export function createUltimateGuitarRouter({
  enabled = readUltimateGuitarSearchEnabled(),
  service = createUltimateGuitarService(),
}: { enabled?: boolean; service?: ReturnType<typeof createUltimateGuitarService> } = {}): Router {
  const router = Router();
  router.use(requireAuth);

  /** Whether search and link import are on, so the app shows or hides them. */
  router.get('/status', (_req, res) => {
    res.json({ searchEnabled: enabled });
  });

  router.use((_req, res, next) => {
    if (!enabled) {
      res.status(404).json({ error: 'Ultimate Guitar search is turned off on this server.' });
      return;
    }
    next();
  });

  function sendError(res: import('express').Response, err: unknown, what: string): void {
    if (err instanceof UltimateGuitarError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error(`Ultimate Guitar ${what} failed:`, err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }

  router.get('/search', async (req, res) => {
    try {
      const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      if (query.length < 2 || query.length > 100) {
        res.status(400).json({ error: 'Type at least 2 characters to search.' });
        return;
      }
      const pageParam = Number(req.query.page);
      const page = Number.isInteger(pageParam) && pageParam >= 1 && pageParam <= 50 ? pageParam : 1;
      res.json(await service.search(query, page));
    } catch (err) {
      sendError(res, err, 'search');
    }
  });

  router.get('/tab', async (req, res) => {
    try {
      const link = typeof req.query.url === 'string' ? req.query.url : '';
      res.json({ tab: await service.getTab(link) });
    } catch (err) {
      sendError(res, err, 'tab fetch');
    }
  });

  return router;
}
