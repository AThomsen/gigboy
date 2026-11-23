import type { StreamInfo } from './streamDecoder';

/** Messages between the main thread and stemDecoder.worker.ts. */
export type DecoderRequest =
  | { type: 'open'; id: number; stems: Array<{ stemId: string; url: string }> }
  | { type: 'decode'; id: number; stemId: string; from: number; count: number }
  | { type: 'analyze'; id: number; file: Blob; bars: number }
  | { type: 'close' };

export interface OpenResult {
  stemId: string;
  info?: StreamInfo;
  error?: string;
}

export type DecoderResponse =
  | { type: 'progress'; id: number; done: number; total: number }
  | { type: 'opened'; id: number; results: OpenResult[] }
  | { type: 'decoded'; id: number; stemId: string; from: number; channels: Float32Array[] }
  | { type: 'analyzed'; id: number; info: StreamInfo; peaks: number[] }
  | { type: 'error'; id: number; message: string };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Promise-based client for the decoder worker. */
export class StemDecoderClient {
  private readonly worker: Worker;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: DecoderResponse) => void; reject: (err: Error) => void; onProgress?: (done: number, total: number) => void }
  >();

  constructor() {
    this.worker = new Worker(new URL('./stemDecoder.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<DecoderResponse>) => {
      const message = event.data;
      const entry = this.pending.get(message.id);
      if (!entry) return;
      if (message.type === 'progress') {
        entry.onProgress?.(message.done, message.total);
        return;
      }
      this.pending.delete(message.id);
      if (message.type === 'error') entry.reject(new Error(message.message));
      else entry.resolve(message);
    };
    this.worker.onerror = (event) => {
      const err = new Error(event.message || 'Stem decoder failed to start.');
      for (const entry of this.pending.values()) entry.reject(err);
      this.pending.clear();
    };
  }

  private call(request: DistributiveOmit<Exclude<DecoderRequest, { type: 'close' }>, 'id'>, onProgress?: (done: number, total: number) => void): Promise<DecoderResponse> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      this.worker.postMessage({ ...request, id });
    });
  }

  async open(stems: Array<{ stemId: string; url: string }>, onProgress?: (done: number, total: number) => void): Promise<OpenResult[]> {
    const response = await this.call({ type: 'open', stems }, onProgress);
    return response.type === 'opened' ? response.results : [];
  }

  async decode(stemId: string, from: number, count: number): Promise<Float32Array[]> {
    const response = await this.call({ type: 'decode', stemId, from, count });
    return response.type === 'decoded' ? response.channels : [];
  }

  async analyze(file: Blob, bars: number): Promise<{ info: StreamInfo; peaks: number[] }> {
    const response = await this.call({ type: 'analyze', file, bars });
    if (response.type !== 'analyzed') throw new Error('Unexpected decoder response.');
    return { info: response.info, peaks: response.peaks };
  }

  dispose(): void {
    this.worker.postMessage({ type: 'close' } satisfies DecoderRequest);
    for (const entry of this.pending.values()) entry.reject(new Error('Stem decoder closed.'));
    this.pending.clear();
  }
}
