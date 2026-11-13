export const mediaByteBudget = 32 * 1024 * 1024;
export const inlineMediaByteLimit = 256 * 1024;
const maxConcurrentLoads = 2;

export type ServerLimit = { readonly state: 'known'; readonly value: number } | { readonly state: 'unknown' };
export interface ServerLimits {
  readonly maxMessageSize: ServerLimit;
  readonly maxFileUploadSize: ServerLimit;
  readonly maxInlineMediaSize?: ServerLimit;
}

export type MediaFailureReason = 'closed' | 'aborted' | 'busy' | 'capacity' | 'tooLarge' |
  'unsupported' | 'invalidResponse' | 'unavailable' | 'timeout';

export class MediaFailure extends Error {
  readonly reason: MediaFailureReason;
  readonly status?: number;

  constructor(reason: MediaFailureReason, status?: number) {
    super('Media: ' + reason);
    this.name = 'MediaFailure';
    this.reason = reason;
    this.status = status;
  }
}

export interface MediaLease {
  readonly resourceId: string;
  readonly url: string;
  readonly mime: string;
  readonly size: number;
  readonly release: (options?: { readonly discard?: boolean }) => void;
}

interface Entry {
  readonly size: number;
  readonly mime: string;
  readonly url: string;
  pins: number;
  discardWhenUnused?: boolean;
}

type ReadMedia = (signal: AbortSignal, reserve: (totalBytes: number) => void) => Promise<Blob>;

// Create one instance per session and dispose of it on sign-out.
// The budget covers both completed blobs and reservations for reads in progress.
export class MediaResources {
  #entries = new Map<string, Entry>();
  #loading = new Map<string, AbortController>();
  #cached = 0;
  #reserved = 0;
  #closed = false;

  async acquire(resourceId: string, read: ReadMedia, signal?: AbortSignal): Promise<MediaLease> {
    if (this.#closed) throw new MediaFailure('closed');
    if (signal?.aborted) throw new MediaFailure('aborted');
    if (!resourceId) throw new MediaFailure('invalidResponse');
    const cached = this.#entries.get(resourceId);
    if (cached) {
      // Map iteration order is the eviction order. Reacquiring makes this the newest entry.
      this.#entries.delete(resourceId);
      this.#entries.set(resourceId, cached);
      return this.#pin(resourceId, cached);
    }
    if (this.#loading.size >= maxConcurrentLoads || this.#loading.has(resourceId)) throw new MediaFailure('busy');
    if (this.#cached + this.#reserved >= mediaByteBudget && ![...this.#entries.values()].some(entry => entry.pins === 0)) {
      throw new MediaFailure('capacity');
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    this.#loading.set(resourceId, controller);
    let reserved = 0;
    const check = () => {
      if (this.#closed) throw new MediaFailure('closed');
      if (controller.signal.aborted) throw new MediaFailure('aborted');
    };
    const reserve = (totalBytes: number) => {
      check();
      if (!Number.isSafeInteger(totalBytes) || totalBytes < 0) throw new MediaFailure('invalidResponse');
      if (totalBytes > mediaByteBudget) throw new MediaFailure('tooLarge');
      if (totalBytes <= reserved) return;
      const additional = totalBytes - reserved;
      this.#makeRoom(additional);
      this.#reserved += additional;
      reserved = totalBytes;
    };

    try {
      const blob = await read(controller.signal, reserve);
      check();
      if (blob.size === 0) throw new MediaFailure('invalidResponse');
      reserve(blob.size);
      const entry: Entry = { size: blob.size, mime: blob.type, url: URL.createObjectURL(blob), pins: 0 };
      this.#entries.set(resourceId, entry);
      this.#cached += blob.size;
      return this.#pin(resourceId, entry);
    } catch (reason: unknown) {
      check();
      if (reason instanceof MediaFailure) throw reason;
      throw new MediaFailure('unavailable');
    } finally {
      this.#reserved -= reserved;
      this.#loading.delete(resourceId);
      signal?.removeEventListener('abort', abort);
    }
  }

  #pin(resourceId: string, entry: Entry): MediaLease {
    entry.pins++;
    let released = false;
    return Object.freeze({ resourceId, url: entry.url, mime: entry.mime, size: entry.size,
      release: (options?: { readonly discard?: boolean }) => {
        if (released) return;
        released = true;
        entry.discardWhenUnused ||= options?.discard;
        entry.pins--;
        if (entry.pins === 0 && entry.discardWhenUnused && this.#entries.get(resourceId) === entry) this.#evict(resourceId);
      } });
  }

  #makeRoom(additional: number): void {
    let needed = this.#cached + this.#reserved + additional - mediaByteBudget;
    if (needed <= 0) return;
    const candidates: string[] = [];
    for (const [id, entry] of this.#entries) {
      if (entry.pins > 0) continue;
      candidates.push(id);
      needed -= entry.size;
      if (needed <= 0) break;
    }
    if (needed > 0) throw new MediaFailure('capacity');
    for (const id of candidates) this.#evict(id);
  }

  #evict(id: string): void {
    const entry = this.#entries.get(id);
    if (!entry) return;
    this.#entries.delete(id);
    this.#cached -= entry.size;
    URL.revokeObjectURL(entry.url);
  }

  dispose(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const controller of this.#loading.values()) controller.abort();
    for (const id of this.#entries.keys()) this.#evict(id);
  }
}
