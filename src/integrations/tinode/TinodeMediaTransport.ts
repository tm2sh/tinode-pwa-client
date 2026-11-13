import type { TinodeDraftyMediaContent } from 'tinode-sdk';
import type { PreparedMediaInput } from '../../media/PreparedMedia';
import { MediaFailure, MediaResources, inlineMediaByteLimit, mediaByteBudget } from '../../media/MediaResources';
import type { MediaLease, ServerLimits } from '../../media/MediaResources';
import { TinodeSessionFailure } from './TinodeSessionScope';
import type { TinodeSessionScope } from './TinodeSessionScope';

const photoPreviewByteLimit = 32 * 1024;
const downloadTimeoutMs = 30_000;

export type TinodeMediaSource =
  | { readonly kind: 'reference'; readonly family: 'image' | 'audio'; readonly reference: string; readonly mime?: string }
  | { readonly kind: 'inline'; readonly family: 'image' | 'audio'; readonly base64: string; readonly mime: string };

const supported = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/aac', 'audio/mpeg', 'audio/wav',
]);

function mimeEssence(value: string): string {
  const mime = value.split(';', 1)[0]!.trim().toLowerCase();
  if (mime === 'image/jpg') return 'image/jpeg';
  if (mime === 'audio/x-m4a') return 'audio/mp4';
  if (mime === 'audio/x-wav' || mime === 'audio/wave') return 'audio/wav';
  return mime;
}

function checkedMime(source: TinodeMediaSource, header?: string): string {
  const declared = source.mime === undefined ? undefined : mimeEssence(source.mime);
  const response = header === undefined ? undefined : mimeEssence(header);
  // Tinode/S3 may label an audio-only WebM container as video/webm.
  // Accept that header only for an AU explicitly declared as audio/webm;
  // the byte budget, container signature and native audio decoder still apply.
  const normalizedResponse = source.family === 'audio' && declared === 'audio/webm' && response === 'video/webm'
    ? 'audio/webm' : response;
  const specific = normalizedResponse && normalizedResponse !== 'application/octet-stream' ? normalizedResponse : undefined;
  const mime = specific ?? declared;
  if (!mime || !supported.has(mime) || !mime.startsWith(source.family + '/') ||
    (declared !== undefined && declared !== mime)) throw new MediaFailure('unsupported');
  return mime;
}

function asciiAt(bytes: Uint8Array, offset: number, word: string): boolean {
  if (bytes.length < offset + word.length) return false;
  for (let i = 0; i < word.length; i++) if (bytes[offset + i] !== word.charCodeAt(i)) return false;
  return true;
}

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  return magic.every((byte, index) => bytes[index] === byte);
}

// Check the container signature. The decoder determines whether the codec is supported.
function matchesMime(bytes: Uint8Array, mime: string): boolean {
  switch (mime) {
    case 'image/jpeg': return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case 'image/png': return startsWith(bytes, [137, 80, 78, 71, 13, 10, 26, 10]);
    case 'image/webp': return asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WEBP');
    case 'image/gif': return asciiAt(bytes, 0, 'GIF87a') || asciiAt(bytes, 0, 'GIF89a');
    case 'audio/ogg': return asciiAt(bytes, 0, 'OggS') && bytes[4] === 0;
    case 'audio/webm': return startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3]);
    case 'audio/mp4': return bytes.length >= 12 && asciiAt(bytes, 4, 'ftyp');
    case 'audio/wav': return asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WAVE');
    case 'audio/aac': return bytes.length >= 7 && bytes[0] === 0xff && (bytes[1]! & 0xf6) === 0xf0;
    case 'audio/mpeg': return asciiAt(bytes, 0, 'ID3') || (bytes.length >= 4 && bytes[0] === 0xff &&
      (bytes[1]! & 0xe0) === 0xe0 && (bytes[1]! & 0x06) !== 0);
    default: return false;
  }
}

function decodeInline(source: Extract<TinodeMediaSource, { kind: 'inline' }>, reserve: (size: number) => void): Blob {
  const mime = checkedMime(source);
  const encoded = source.base64;
  if (encoded.length > Math.ceil(inlineMediaByteLimit / 3) * 4) throw new MediaFailure('tooLarge');
  if (!encoded.length || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new MediaFailure('invalidResponse');
  }
  const size = encoded.length / 4 * 3 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
  if (size > inlineMediaByteLimit) throw new MediaFailure('tooLarge');
  reserve(size);
  let binary: string;
  try { binary = atob(encoded); } catch { throw new MediaFailure('invalidResponse'); }
  if (binary.length !== size) throw new MediaFailure('invalidResponse');
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = binary.charCodeAt(i);
  if (!matchesMime(bytes, mime)) throw new MediaFailure('invalidResponse');
  return new Blob([bytes], { type: mime });
}

async function readMedia(response: Response, source: TinodeMediaSource, signal: AbortSignal,
  reserve: (size: number) => void): Promise<Blob> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const cancel = () => { void reader?.cancel().catch(() => {}); };
  try {
    if (!response.ok || response.type === 'opaque' || response.redirected || response.status === 206) {
      throw new MediaFailure('unavailable', response.status);
    }
    if (!response.body) throw new MediaFailure('invalidResponse');
    const mime = checkedMime(source, response.headers.get('content-type') ?? undefined);
    const length = response.headers.get('content-length');
    if (length !== null) {
      if (!/^\d+$/.test(length)) throw new MediaFailure('invalidResponse');
      const advertised = Number(length);
      if (advertised > mediaByteBudget) throw new MediaFailure('tooLarge');
      if (advertised === 0) throw new MediaFailure('invalidResponse');
      reserve(advertised);
    }

    reader = response.body.getReader();
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) throw new MediaFailure('aborted');
    const chunks: BlobPart[] = [];
    const signature = new Uint8Array(16);
    let size = 0;
    while (true) {
      const part = await reader.read();
      if (signal.aborted) throw new MediaFailure('aborted');
      if (part.done) break;
      const nextSize = size + part.value.byteLength;
      reserve(nextSize);
      if (size < signature.length) {
        signature.set(part.value.subarray(0, signature.length - size), size);
        if (nextSize >= signature.length && !matchesMime(signature, mime)) throw new MediaFailure('invalidResponse');
      }
      size = nextSize;
      chunks.push(part.value.slice());
    }
    if (size < signature.length && !matchesMime(signature.subarray(0, size), mime)) {
      throw new MediaFailure('invalidResponse');
    }
    return new Blob(chunks, { type: mime });
  } catch (reason: unknown) {
    if (reader) cancel();
    else void response.body?.cancel().catch(() => {});
    throw reason;
  } finally {
    signal.removeEventListener('abort', cancel);
    reader?.releaseLock();
  }
}

function uploadReference(origin: string, value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 1024) throw new MediaFailure('invalidResponse');
  const url = new URL(value, origin + '/v0/file/s/');
  if (url.origin !== origin || url.username || url.password || url.search || url.hash ||
    !/^\/v0\/file\/s\/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(url.pathname)) {
    throw new MediaFailure('invalidResponse');
  }
  return url.pathname;
}

function uploadReply(origin: string, value: unknown): string {
  if (typeof value !== 'object' || value === null) throw new MediaFailure('invalidResponse');
  const ctrl = value as Record<string, unknown>;
  if (typeof ctrl.code !== 'number' || !Number.isInteger(ctrl.code) || ctrl.code < 200 || ctrl.code >= 300 ||
    typeof ctrl.params !== 'object' || ctrl.params === null) throw new MediaFailure('invalidResponse');
  return uploadReference(origin, (ctrl.params as Record<string, unknown>).url);
}

function uploadStatus(value: unknown): number | undefined {
  const code = typeof value === 'object' && value !== null ? (value as Record<string, unknown>).code : undefined;
  return typeof code === 'number' && Number.isInteger(code) && code >= 400 && code < 600 ? code : undefined;
}

const uploadIdleMs = 30_000;
const uploadTotalMs = 300_000;
function boundedBase64(value: string, limit: number): boolean {
  if (!value || value.length > Math.ceil(limit / 3) * 4 || value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  return value.length / 4 * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0) <= limit;
}
function positive(value: number): boolean { return Number.isSafeInteger(value) && value > 0; }

// Photos and voice messages share the same budget within a session.
export class TinodeMediaTransport {
  static readonly #instances = new WeakMap<TinodeSessionScope, TinodeMediaTransport>();

  static forScope(scope: TinodeSessionScope): TinodeMediaTransport {
    if (!scope.active) throw new MediaFailure('closed');
    let transport = this.#instances.get(scope);
    if (!transport) {
      transport = new TinodeMediaTransport(scope);
      this.#instances.set(scope, transport);
    }
    return transport;
  }

  readonly #resources = new MediaResources();

  readonly #scope: TinodeSessionScope;

  private constructor(scope: TinodeSessionScope) {
    this.#scope = scope;
    scope.onClose(() => this.#resources.dispose());
  }

  get limits(): ServerLimits {
    if (!this.#scope.active) throw new MediaFailure('closed');
    return this.#scope.mediaLimits();
  }

  async preparePublication(file: PreparedMediaInput, signal: AbortSignal,
    onProgress?: (fraction: number) => void): Promise<{ content: TinodeDraftyMediaContent; reference?: string }> {
    if (signal.aborted) throw new MediaFailure('aborted');
    const { maxFileUploadSize, maxMessageSize, maxInlineMediaSize } = this.limits;
    const byteLimit = maxInlineMediaSize ?? maxFileUploadSize;
    if (byteLimit.state !== 'known' || maxMessageSize.state !== 'known') throw new TinodeSessionFailure('limitsUnavailable');
    if (!(file.blob instanceof Blob) || file.blob.size === 0) throw new MediaFailure('invalidResponse');
    if (file.blob.size > byteLimit.value) throw new MediaFailure('tooLarge');
    const mime = mimeEssence(file.blob.type);
    if (!supported.has(mime) || !mime.startsWith(file.kind === 'photo' ? 'image/' : 'audio/')) {
      throw new MediaFailure('unsupported');
    }
    const filename = file.filename.trim();
    if (!filename || filename.length > 255 || /[\\/\u0000-\u001f\u007f]/u.test(filename)) throw new MediaFailure('invalidResponse');
    const data: Record<string, string | number> = { mime, size: file.blob.size, name: filename };
    if (file.kind === 'photo') {
      if (!positive(file.width) || !positive(file.height) || Math.max(file.width, file.height) > 2048) throw new MediaFailure('invalidResponse');
      data.width = file.width;
      data.height = file.height;
      if (!maxInlineMediaSize && file.preview !== undefined) {
        if (!boundedBase64(file.preview, photoPreviewByteLimit)) throw new MediaFailure('invalidResponse');
        decodeInline({ kind: 'inline', family: 'image', mime, base64: file.preview }, () => {});
        data.val = file.preview;
      }
    } else {
      if (!positive(file.durationMs) || (file.waveform !== undefined && !boundedBase64(file.waveform, 256))) throw new MediaFailure('invalidResponse');
      data.duration = file.durationMs;
      if (file.waveform !== undefined) data.preview = file.waveform;
    }
    const content: TinodeDraftyMediaContent = { txt: ' ', fmt: [{ at: 0, len: 1, key: 0 }],
      ent: [{ tp: file.kind === 'photo' ? 'IM' : 'AU', data }] };
    // The scope checks the final packet size, including ref and extra, before publishing.
    if (new TextEncoder().encode(JSON.stringify(content)).byteLength > maxMessageSize.value) throw new MediaFailure('tooLarge');
    const signature = new Uint8Array(await file.blob.slice(0, 16).arrayBuffer());
    if (signal.aborted) throw new MediaFailure('aborted');
    if (!matchesMime(signature, mime)) throw new MediaFailure('invalidResponse');
    if (maxInlineMediaSize) {
      const bytes = new Uint8Array(await file.blob.arrayBuffer());
      if (signal.aborted) throw new MediaFailure('aborted');
      if (!this.#scope.active) throw new MediaFailure('closed');
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 8192) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      }
      data.val = btoa(binary);
      return { content };
    }
    const reference = await this.#upload(new File([file.blob], filename, { type: mime }), signal, onProgress);
    data.ref = reference;
    return { content, reference };
  }

  #upload(file: Blob, signal: AbortSignal, onProgress?: (fraction: number) => void): Promise<string> {
    const server = new URL(this.#scope.account.serverId);
    if (!this.#scope.active) return Promise.reject(new MediaFailure('closed'));
    if (signal.aborted) return Promise.reject(new MediaFailure('aborted'));
    if (server.protocol !== 'wss:') return Promise.reject(new MediaFailure('invalidResponse'));
    server.protocol = 'https:';
    const origin = server.origin;
    const helper = this.#scope.createMediaUpload();
    return new Promise((resolve, reject) => {
      let settled = false, progress = -1;
      let reply: string | undefined, result: string | undefined;
      let idle: ReturnType<typeof setTimeout>, total: ReturnType<typeof setTimeout>;
      let detachScope: () => void = () => {};
      const finish = (value: string | MediaFailure) => {
        if (settled) return;
        settled = true;
        clearTimeout(idle);
        clearTimeout(total);
        signal.removeEventListener('abort', abort);
        detachScope();
        if (typeof value === 'string') resolve(value);
        else {
          reject(value);
          try { helper.cancel(); } catch { /* SDK cancellation is best effort. */ }
        }
      };
      const abort = () => finish(new MediaFailure('aborted'));
      const timeout = () => finish(new MediaFailure('timeout'));
      const rearm = () => { clearTimeout(idle); idle = setTimeout(timeout, uploadIdleMs); };
      const confirm = () => {
        if (!this.#scope.active) finish(new MediaFailure('closed'));
        else if (reply !== undefined && result !== undefined) {
          finish(reply === result ? reply : new MediaFailure('invalidResponse'));
        }
      };
      rearm();
      total = setTimeout(timeout, uploadTotalMs);
      signal.addEventListener('abort', abort, { once: true });
      detachScope = this.#scope.onClose(() => finish(new MediaFailure('closed')));
      if (settled) return;
      try {
        const pending = helper.uploadWithBaseUrl(this.#scope.mediaUploadOrigin(), file, undefined, (fraction) => {
          if (settled || !Number.isFinite(fraction) || fraction < 0 || fraction > 1 || fraction <= progress) return;
          if (!this.#scope.active) { finish(new MediaFailure('closed')); return; }
          progress = fraction;
          rearm();
          try { onProgress?.(fraction); } catch { /* UI callback does not own the upload. */ }
        }, (ctrl) => {
          if (settled) return;
          try { reply = uploadReply(origin, ctrl); confirm(); }
          catch { finish(new MediaFailure('invalidResponse')); }
        }, (ctrl) => finish(new MediaFailure('unavailable', uploadStatus(ctrl))));
        void pending.then((value) => {
          if (settled) return;
          try { result = uploadReference(origin, value); confirm(); }
          catch { finish(new MediaFailure('invalidResponse')); }
        }, (reason: unknown) => finish(new MediaFailure('unavailable', uploadStatus(reason))));
      } catch (reason: unknown) {
        finish(new MediaFailure('unavailable', uploadStatus(reason)));
      }
    });
  }

  async acquire(resourceId: string, source: TinodeMediaSource, signal?: AbortSignal): Promise<MediaLease> {
    return this.#acquire(resourceId, source, signal, false);
  }

  async acquirePhoto(resourceId: string, source: TinodeMediaSource, signal: AbortSignal): Promise<MediaLease> {
    return this.#acquire(resourceId, source, signal, false, true);
  }

  async acquirePhotoPreview(resourceId: string, source: Extract<TinodeMediaSource, { kind: 'inline' }>,
    signal: AbortSignal): Promise<MediaLease> {
    return this.#acquire(resourceId, source, signal, true);
  }

  async #acquire(resourceId: string, source: TinodeMediaSource, signal: AbortSignal | undefined, preview: boolean, fullPhoto = false): Promise<MediaLease> {
    if (!this.#scope.active) throw new MediaFailure('closed');
    return this.#resources.acquire(resourceId, async (lifetime, reserve) => {
      if (source.kind === 'inline') {
        const blob = decodeInline(source, bytes => {
          if (preview && bytes > photoPreviewByteLimit) throw new MediaFailure('tooLarge');
          reserve(bytes);
        });
        if (preview) {
          const { checkPhotoPreview } = await import('../../media/PhotoPreparation');
          await checkPhotoPreview(blob, lifetime);
        }
        if (fullPhoto) {
          const { checkPhotoDisplay } = await import('../../media/PhotoPreparation');
          await checkPhotoDisplay(blob, lifetime);
        }
        return blob;
      }
      const controller = new AbortController();
      const abort = () => controller.abort();
      lifetime.addEventListener('abort', abort, { once: true });
      if (lifetime.aborted) abort();
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; abort(); }, downloadTimeoutMs);
      try {
        const response = await this.#scope.fetchMediaResponse(source.reference, controller.signal);
        const blob = await readMedia(response, source, controller.signal, reserve);
        if (!this.#scope.active) throw new MediaFailure('closed');
        if (controller.signal.aborted) throw new MediaFailure('aborted');
        if (fullPhoto) {
          const { checkPhotoDisplay } = await import('../../media/PhotoPreparation');
          await checkPhotoDisplay(blob, controller.signal);
        }
        return blob;
      } catch (reason: unknown) {
        if (!this.#scope.active) throw new MediaFailure('closed');
        if (lifetime.aborted) throw new MediaFailure('aborted');
        if (timedOut) throw new MediaFailure('timeout');
        if (reason instanceof MediaFailure) throw reason;
        if (reason instanceof TinodeSessionFailure && reason.reason === 'invalidResponse') throw new MediaFailure('invalidResponse');
        throw new MediaFailure('unavailable');
      } finally {
        clearTimeout(timer);
        lifetime.removeEventListener('abort', abort);
      }
    }, signal);
  }
}
