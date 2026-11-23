import { useCallback, useEffect, useState } from 'react';
import {
  deleteAllSongStems,
  deleteSongStem,
  loadSongStems,
  uploadSongStem,
  type SongStem,
} from '../lib/songStems';
import { collectStems, stemLengthsDiffer, type ImportedStem } from '../lib/stemImport';
import { pickSampleRate } from '../lib/stemPlayer';
import { pruneCachedStems } from '../lib/stems/stemCache';
import { StemDecoderClient } from '../lib/stems/stemDecoderProtocol';

/** Bars stored per stem — enough for a full-width card on a tablet. */
export const STEM_WAVEFORM_BARS = 200;

export interface StemImportProgress {
  phase: 'reading' | 'preparing' | 'uploading';
  done: number;
  total: number;
}

export interface StemImportResult {
  imported: number;
  /** File names that couldn't be decoded or uploaded. */
  failed: string[];
  cancelled?: boolean;
}

interface Params {
  bandId: string;
  /** Empty disables loading (e.g. signed out). */
  songId: string;
}

interface PreparedStem {
  stem: ImportedStem;
  sampleRate: number;
  durationMs: number;
  waveformBars: number[];
}

/**
 * Decodes one stem with the player's own decoder (streamed, so even a long WAV never sits in
 * memory as PCM) for its sample rate, length and waveform. A stem that prepares will play.
 */
async function prepareStem(client: StemDecoderClient, stem: ImportedStem): Promise<PreparedStem> {
  const { info, peaks } = await client.analyze(await stem.getFile(), STEM_WAVEFORM_BARS);
  return {
    stem,
    sampleRate: info.sampleRate,
    durationMs: Math.round((info.totalSamples / info.sampleRate) * 1000),
    // Not normalised per file, so a quiet stem looks quiet next to the loud ones.
    waveformBars: peaks.map((v) => Math.round(v * 1000) / 1000),
  };
}

function stemsPath(bandId: string, songId: string): string {
  return `/api/bands/${bandId}/songs/${songId}/stems`;
}

export function useSongStems({ bandId, songId }: Params) {
  const [stems, setStems] = useState<SongStem[]>([]);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<StemImportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!songId || !bandId) {
      setStems([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    loadSongStems(bandId, songId)
      .then((list) => { if (!cancelled) setStems(list); })
      .catch((err) => console.error('Failed to load stems', err))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [bandId, songId]);

  // Forget cached files of stems that were replaced or removed (here or on another device).
  useEffect(() => {
    if (!songId || !bandId || loading) return;
    void pruneCachedStems(stemsPath(bandId, songId), stems.map((s) => s.downloadUrl));
  }, [bandId, songId, stems, loading]);

  /**
   * Imports a stem ZIP or audio files: decodes each stem (one at a time) for its length and
   * waveform, asks `confirmLengthMismatch` when the lengths don't line up, then uploads one
   * stem per request. Stems with the same name are replaced; others are kept.
   */
  const importStems = useCallback(
    async (files: File[], confirmLengthMismatch: (spreadSeconds: number) => Promise<boolean>): Promise<StemImportResult> => {
      setError(null);
      const failed: string[] = [];
      try {
        setProgress({ phase: 'reading', done: 0, total: files.length });
        const collected = await collectStems(files);
        if (collected.length === 0) {
          setError('No audio files found. Pick a stem ZIP or MP3/WAV files.');
          return { imported: 0, failed };
        }

        let prepared: PreparedStem[] = [];
        const client = new StemDecoderClient();
        try {
          for (const [index, stem] of collected.entries()) {
            setProgress({ phase: 'preparing', done: index, total: collected.length });
            try {
              prepared.push(await prepareStem(client, stem));
            } catch (err) {
              console.error(`Failed to decode stem ${stem.fileName}`, err);
              failed.push(stem.fileName);
            }
          }
        } finally {
          client.dispose();
        }

        // Stems only stay sample-locked at one shared sample rate.
        const rate = pickSampleRate(prepared.map((p) => p.sampleRate));
        const offRate = prepared.filter((p) => p.sampleRate !== rate);
        if (offRate.length > 0) {
          failed.push(...offRate.map((p) => p.stem.fileName));
          setError(`Skipped ${offRate.map((p) => p.stem.fileName).join(', ')}: not at ${rate} Hz like the other stems.`);
          prepared = prepared.filter((p) => p.sampleRate === rate);
        }

        const durations = prepared.map((p) => p.durationMs);
        if (stemLengthsDiffer(durations)) {
          const spread = (Math.max(...durations) - Math.min(...durations)) / 1000;
          if (!(await confirmLengthMismatch(spread))) return { imported: 0, failed, cancelled: true };
        }

        let imported = 0;
        for (const [index, item] of prepared.entries()) {
          setProgress({ phase: 'uploading', done: index, total: prepared.length });
          try {
            const file = await item.stem.getFile();
            const saved = await uploadSongStem(bandId, songId, item.stem.name, file, {
              durationMs: item.durationMs,
              waveformBars: item.waveformBars,
              sortOrder: item.stem.sortOrder,
            });
            imported += 1;
            setStems((prev) =>
              [...prev.filter((s) => s.name !== saved.name), saved]
                .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
            );
          } catch (err) {
            console.error(`Failed to upload stem ${item.stem.fileName}`, err);
            failed.push(item.stem.fileName);
            const message = err instanceof Error ? err.message : 'Upload failed';
            setError(message);
            // Quota exhausted: the remaining stems would fail the same way.
            if (/quota/i.test(message)) {
              failed.push(...prepared.slice(index + 1).map((p) => p.stem.fileName));
              break;
            }
          }
        }
        return { imported, failed };
      } catch (err) {
        console.error('Stem import failed', err);
        setError(err instanceof Error ? err.message : 'Import failed');
        return { imported: 0, failed };
      } finally {
        setProgress(null);
      }
    },
    [bandId, songId],
  );

  const deleteStem = useCallback(
    async (stem: SongStem) => {
      try {
        await deleteSongStem(bandId, songId, stem);
        setStems((prev) => prev.filter((s) => s.id !== stem.id));
      } catch (err) {
        console.error('Failed to delete stem', err);
        setError(err instanceof Error ? err.message : 'Failed to delete stem');
      }
    },
    [bandId, songId],
  );

  const deleteAllStems = useCallback(async () => {
    try {
      await deleteAllSongStems(bandId, songId);
      setStems([]);
    } catch (err) {
      console.error('Failed to delete stems', err);
      setError(err instanceof Error ? err.message : 'Failed to delete stems');
    }
  }, [bandId, songId]);

  return { stems, loading, progress, error, importStems, deleteStem, deleteAllStems };
}

export type SongStemsState = ReturnType<typeof useSongStems>;
