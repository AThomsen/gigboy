import multer from 'multer';
import type { songStems } from '../db/schema.js';
import { removeNullish } from './serialize.js';

/** Per-stem upload cap. A 5-minute stereo WAV is ~50MB; compressed stems are far smaller. */
export const STEM_MAX_SIZE_BYTES = 50 * 1024 * 1024;

/** Formats the stem player decodes (src/lib/stems/streamDecoder.ts): MP3 and WAV. */
export const STEM_ACCEPTED_MIME_TYPES = [
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/vnd.wave',
];

/** Stem keys are short slugs (`vocals`, `lead_vocals`, `click`) — they appear in URLs. */
export const STEM_NAME_RE = /^[a-z0-9_-]{1,40}$/;

/** Upper bound on stored waveform bars per stem; the client sends ~200. */
export const STEM_MAX_WAVEFORM_BARS = 1000;

type SongStemRow = typeof songStems.$inferSelect;

export const stemUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: STEM_MAX_SIZE_BYTES },
  fileFilter: (_req, file, cb) => {
    if (!STEM_ACCEPTED_MIME_TYPES.includes(file.mimetype)) {
      cb(new Error('INVALID_FILE_TYPE'));
      return;
    }
    cb(null, true);
  },
});

/** Parses the `waveformBars` multipart field (a JSON array) into bars clamped to 0..1, or null. */
export function parseWaveformBars(raw: unknown): number[] | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const bars = parsed
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
      .slice(0, STEM_MAX_WAVEFORM_BARS)
      .map((v) => Math.min(1, Math.max(0, v)));
    return bars.length ? bars : null;
  } catch {
    return null;
  }
}

/** Maps a DB row to the wire shape `SongStem` (src/lib/songStems.ts) expects. */
export function songStemToApi(row: SongStemRow, urlBase: string) {
  return removeNullish({
    id: row.id,
    name: row.name,
    // Downloads are cached as immutable; replacing a stem keeps its id, so the URL carries a version.
    downloadUrl: `${urlBase}/${row.id}/download?v=${row.createdAt.getTime()}`,
    durationMs: row.durationMs,
    sizeBytes: row.sizeBytes,
    mimeType: row.mimeType,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
    waveformBars: Array.isArray(row.waveformBars) && row.waveformBars.length ? row.waveformBars : undefined,
  });
}
