import JSZip from 'jszip';

/**
 * Turns what an editor picks for "Import stems…" — a stem ZIP (as exported by StemDeck or other
 * source separators) or a handful of audio files — into named stems ready to upload. Pure apart
 * from reading the files; no audio decoding happens here.
 */

/** Known stem keys, in mixer order. Matching tries longer keys first (`lead_vocals` before `vocals`). */
export const KNOWN_STEMS = [
  'lead_vocals',
  'vocals',
  'backing_vocals',
  'drums',
  'bass',
  'guitar',
  'piano',
  'other',
  'click',
  'original',
  'mix',
] as const;

const STEM_COLORS: Record<string, string> = {
  lead_vocals: '#e0566b',
  vocals: '#e0566b',
  backing_vocals: '#e88a9a',
  drums: '#e8963a',
  bass: '#8a63d2',
  guitar: '#3aa676',
  piano: '#3d8bd9',
  other: '#9a8f84',
  click: '#c9a227',
  original: '#6b7c8f',
  mix: '#6b7c8f',
};

const FALLBACK_COLORS = ['#2fa7b8', '#b8579e', '#7a9a2f', '#c96a3a', '#5a6fd1'];

/** Stems that duplicate the full song; they start muted in the player. */
export const FULL_MIX_STEMS = new Set(['original', 'mix']);

const MATCH_ORDER = [...KNOWN_STEMS].sort((a, b) => b.length - a.length);

/** Formats the stem player decodes (src/lib/stems/streamDecoder.ts). */
const MIME_BY_EXTENSION: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
};

export const STEM_IMPORT_ACCEPT = `.zip,audio/mpeg,audio/wav,${Object.keys(MIME_BY_EXTENSION).map((ext) => `.${ext}`).join(',')}`;

/**
 * Stems of one song have the same length (to the sample, once encoder delay is trimmed); lengths
 * further apart than this mean the files aren't one song's stems, or weren't exported together.
 */
export const STEM_LENGTH_TOLERANCE_MS = 10;

export interface ImportedStem {
  /** Stem key, e.g. `vocals`. Unique within one import. */
  name: string;
  /** Original file name inside the ZIP or on disk, for display. */
  fileName: string;
  sortOrder: number;
  /** Reads the file (lazily, so a ZIP of large WAVs isn't held in memory all at once). */
  getFile: () => Promise<File>;
}

function extensionOf(fileName: string): string {
  const base = fileName.split('/').pop() ?? fileName;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

function baseName(fileName: string): string {
  const base = fileName.split('/').pop() ?? fileName;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/** MIME type for an audio file name, or null when the extension isn't a supported audio format. */
export function mimeForAudioFile(fileName: string): string | null {
  return MIME_BY_EXTENSION[extensionOf(fileName)] ?? null;
}

function isSkippedPath(path: string): boolean {
  return path.split('/').some((part) => part.startsWith('.') || part === '__MACOSX');
}

/** Lowercase slug with `_` separators: "Cadillac Ranch - Vocals" → "cadillac_ranch_vocals". */
export function slugifyStemName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** The known stem key a slug ends with (`cadillac_ranch_lead_vocals` → `lead_vocals`), or null. */
export function knownStemSuffix(slug: string): string | null {
  for (const key of MATCH_ORDER) {
    if (slug === key || slug.endsWith(`_${key}`)) return key;
  }
  return null;
}

/** Longest common `_`-terminated prefix of the slugs (the song name StemDeck puts in front). */
function commonSlugPrefix(slugs: string[]): string {
  if (slugs.length < 2) return '';
  let prefix = slugs[0];
  for (const slug of slugs.slice(1)) {
    while (prefix && !slug.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  const cut = prefix.lastIndexOf('_');
  return cut >= 0 ? prefix.slice(0, cut + 1) : '';
}

/**
 * Stem key for each file name. StemDeck names files `<song>_<stem>.<ext>`; known stems are
 * recognised by suffix, anything else keeps what follows the shared song prefix.
 */
export function stemNamesForFiles(fileNames: string[]): string[] {
  const slugs = fileNames.map((name) => slugifyStemName(baseName(name)));
  const prefix = commonSlugPrefix(slugs);
  const used = new Map<string, number>();
  return slugs.map((slug) => {
    const known = knownStemSuffix(slug);
    let name = known ?? (prefix && slug.length > prefix.length ? slug.slice(prefix.length) : slug);
    name = name.slice(0, 36).replace(/_+$/, '') || 'stem';
    const count = (used.get(name) ?? 0) + 1;
    used.set(name, count);
    return count > 1 ? `${name}_${count}` : name;
  });
}

/** Mixer position for a stem key: known stems in KNOWN_STEMS order, others between `other` and `click`. */
export function stemSortOrder(name: string): number {
  const index = (KNOWN_STEMS as readonly string[]).indexOf(name);
  if (index >= 0) return index * 10;
  return (KNOWN_STEMS as readonly string[]).indexOf('other') * 10 + 5;
}

/** Display colour for a stem key; unknown stems get a stable colour from their name. */
export function stemColor(name: string): string {
  if (STEM_COLORS[name]) return STEM_COLORS[name];
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return FALLBACK_COLORS[hash % FALLBACK_COLORS.length];
}

/** True when the durations differ by more than STEM_LENGTH_TOLERANCE_MS. */
export function stemLengthsDiffer(durationsMs: number[]): boolean {
  const known = durationsMs.filter((d) => d > 0);
  if (known.length < 2) return false;
  return Math.max(...known) - Math.min(...known) > STEM_LENGTH_TOLERANCE_MS;
}

interface Candidate {
  fileName: string;
  read: () => Promise<Uint8Array | Blob>;
}

async function candidatesFromZip(zipFile: Blob): Promise<Candidate[]> {
  const zip = await JSZip.loadAsync(zipFile);
  return Object.values(zip.files)
    .filter((entry) => !entry.dir && !isSkippedPath(entry.name) && mimeForAudioFile(entry.name))
    .map((entry) => ({ fileName: entry.name.split('/').pop() ?? entry.name, read: () => entry.async('uint8array') }));
}

/**
 * Collects the audio files from the picked files (ZIPs are opened; other non-audio files such
 * as REAPER `.rpp` projects or `beats.json` are skipped) and names, orders and types them.
 */
export async function collectStems(files: File[]): Promise<ImportedStem[]> {
  const candidates: Candidate[] = [];
  for (const file of files) {
    if (extensionOf(file.name) === 'zip') {
      candidates.push(...(await candidatesFromZip(file)));
    } else if (mimeForAudioFile(file.name)) {
      candidates.push({ fileName: file.name, read: async () => file });
    }
  }

  const names = stemNamesForFiles(candidates.map((c) => c.fileName));
  return candidates
    .map((candidate, i): ImportedStem => ({
      name: names[i],
      fileName: candidate.fileName,
      sortOrder: stemSortOrder(names[i]),
      getFile: async () => {
        const data = await candidate.read();
        // Blobs from a ZIP carry no type, and browsers disagree on audio MIME types (audio/x-m4a,
        // audio/x-flac…), so the type always comes from the extension.
        const type = mimeForAudioFile(candidate.fileName) ?? 'application/octet-stream';
        return new File([data as BlobPart], candidate.fileName, { type });
      },
    }))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}
