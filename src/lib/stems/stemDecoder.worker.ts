/**
 * Decoder worker for the stem player: opens stem files (from the Cache API), decodes requested
 * sample ranges off the main thread and hands the PCM back as transferable buffers. Also analyses
 * picked files at import time (length, sample rate and waveform) with the same decoders, so a
 * stem that imports is one the player can play.
 */
import { createPeakAccumulator } from '../../utils/waveform';
import { getCachedStem } from './stemCache';
import { blobSource, openStreamDecoder, type StreamDecoder } from './streamDecoder';
import type { DecoderRequest, DecoderResponse } from './stemDecoderProtocol';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<DecoderRequest>) => void) | null;
  postMessage(message: DecoderResponse, transfer?: Transferable[]): void;
  close(): void;
};

const decoders = new Map<string, StreamDecoder>();
/** Requests per stem run one after another, so a decoder never sees interleaved ranges. */
const queues = new Map<string, Promise<unknown>>();

function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(task, task);
  queues.set(key, run.catch(() => undefined));
  return run;
}

const ANALYZE_BLOCK = 44100 * 10;

async function handle(request: DecoderRequest): Promise<void> {
  switch (request.type) {
    case 'open': {
      let done = 0;
      const results = [];
      for (const stem of request.stems) {
        try {
          decoders.get(stem.stemId)?.free();
          const decoder = await openStreamDecoder(blobSource(await getCachedStem(stem.url)));
          decoders.set(stem.stemId, decoder);
          if (decoder.info.warning) console.warn(`[stems] ${stem.stemId}: ${decoder.info.warning}`);
          results.push({ stemId: stem.stemId, info: decoder.info });
        } catch (err) {
          results.push({ stemId: stem.stemId, error: err instanceof Error ? err.message : String(err) });
        }
        done += 1;
        scope.postMessage({ type: 'progress', id: request.id, done, total: request.stems.length });
      }
      scope.postMessage({ type: 'opened', id: request.id, results });
      return;
    }
    case 'decode': {
      const channels = await enqueue(request.stemId, async () => {
        const decoder = decoders.get(request.stemId);
        if (!decoder) throw new Error(`Stem ${request.stemId} is not open.`);
        return decoder.decodeRange(request.from, request.count);
      });
      scope.postMessage(
        { type: 'decoded', id: request.id, stemId: request.stemId, from: request.from, channels },
        channels.map((c) => c.buffer),
      );
      return;
    }
    case 'analyze': {
      const decoder = await openStreamDecoder(blobSource(request.file));
      try {
        const { totalSamples } = decoder.info;
        const peaks = createPeakAccumulator(totalSamples, request.bars, { normalize: false });
        for (let from = 0; from < totalSamples; from += ANALYZE_BLOCK) {
          peaks.add(await decoder.decodeRange(from, ANALYZE_BLOCK), from);
        }
        scope.postMessage({ type: 'analyzed', id: request.id, info: decoder.info, peaks: peaks.result() });
      } finally {
        decoder.free();
      }
      return;
    }
    case 'close': {
      for (const decoder of decoders.values()) decoder.free();
      decoders.clear();
      scope.close();
      return;
    }
  }
}

scope.onmessage = (event) => {
  const request = event.data;
  handle(request).catch((err: unknown) => {
    scope.postMessage({ type: 'error', id: 'id' in request ? request.id : -1, message: err instanceof Error ? err.message : String(err) });
  });
};
