import type { AvatarImageSource, AvatarResource } from '../../chats/chat-list-types';
import { tinodeAvatarByteLimit } from './TinodeSessionScope';
import type { TinodeSessionScope } from './TinodeSessionScope';

const missing = Object.freeze({ state: 'missing' } as const);
const pending = Object.freeze({ state: 'pending' } as const);
const unavailable = Object.freeze({ state: 'unavailable' } as const);
const maxImageSide = 4096;
const avatarTimeoutMs = 15_000;

type AvatarSource = { readonly kind: 'ref'; readonly value: string }
  | { readonly kind: 'data'; readonly value: string; readonly mime: string };
interface AvatarEntry {
  readonly owners: Set<string>;
  readonly abort: AbortController;
  readonly promise: Promise<AvatarResource>;
  result?: AvatarResource;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function imageMime(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  let mime = value.toLowerCase().split(';', 1)[0]!.trim();
  if (!mime.startsWith('image/')) mime = 'image/' + mime;
  if (mime === 'image/jpg') mime = 'image/jpeg';
  return ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mime) ? mime : undefined;
}

function sourceOf(profile: unknown): AvatarSource | AvatarResource {
  const photo = isRecord(profile) ? profile.photo : undefined;
  if (photo === undefined || photo === null || photo === '␡') return missing;
  if (!isRecord(photo)) return unavailable;
  // As in the SDK's TheCard, ref takes priority over inline data and a missing type defaults to jpeg.
  if (typeof photo.ref === 'string' && photo.ref.trim() !== '' && photo.ref !== '␡') {
    // Do not cache or pass along a URL that already contains credentials.
    try {
      const url = new URL(photo.ref, 'https://avatar.invalid/');
      if (url.protocol !== 'https:' || url.username || url.password ||
        [...url.searchParams.keys()].some((key) => /^(?:auth|secret|apikey|token|access_token)$/i.test(key))) return unavailable;
    } catch { return unavailable; }
    return { kind: 'ref', value: photo.ref };
  }
  if (typeof photo.data !== 'string' || photo.data === '' || photo.data === '␡') return unavailable;
  const mime = imageMime(photo.type ?? 'jpeg');
  if (!mime || photo.data.length > Math.ceil(tinodeAvatarByteLimit / 3) * 4 ||
    photo.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(photo.data)) return unavailable;
  return { kind: 'data', value: photo.data, mime };
}

function sniffImage(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(String.fromCharCode(...bytes.subarray(0, 6)))) return 'image/gif';
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') return 'image/webp';
  return undefined;
}

function checkDecoded(blob: Blob, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('Avatar cancelled.')); return; }
    if (typeof Image !== 'function') { reject(new Error('Avatar decoder unavailable.')); return; }
    const image = new Image();
    const url = URL.createObjectURL(blob);
    const finish = (valid: boolean) => {
      image.onload = null;
      image.onerror = null;
      signal.removeEventListener('abort', abort);
      image.src = '';
      URL.revokeObjectURL(url);
      if (valid) resolve(); else reject(new Error('Avatar image unavailable.'));
    };
    const abort = () => finish(false);
    image.onload = () => finish(image.naturalWidth > 0 && image.naturalHeight > 0 &&
      image.naturalWidth <= maxImageSide && image.naturalHeight <= maxImageSide);
    image.onerror = () => finish(false);
    signal.addEventListener('abort', abort, { once: true });
    try { image.src = url; } catch { finish(false); }
  });
}

async function validatedImage(blob: Blob, signal: AbortSignal): Promise<AvatarResource> {
  if (blob.size === 0 || blob.size > tinodeAvatarByteLimit) return unavailable;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const mime = sniffImage(bytes);
  if (!mime || imageMime(blob.type) !== mime || signal.aborted) return unavailable;
  await checkDecoded(new Blob([bytes], { type: mime }), signal);
  if (signal.aborted) return unavailable;
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  const imageSource = ('data:' + mime + ';base64,' + btoa(binary)) as AvatarImageSource;
  return Object.freeze({ state: 'ready', imageSource });
}

// All owners receive inline data, so revoking a temporary URL cannot break an image already on screen.
export class TinodeAvatarLoader {
  #scope: TinodeSessionScope;
  #closed = false;
  #entries = new Map<string, AvatarEntry>();
  #owners = new Map<string, string>();
  #detachScope: () => void = () => {};

  constructor(scope: TinodeSessionScope) {
    this.#scope = scope;
    this.#detachScope = scope.onClose(() => this.dispose());
  }

  state(profile: unknown): AvatarResource {
    const source = sourceOf(profile);
    return 'state' in source ? source : pending;
  }

  load(owner: string, profile: unknown): Promise<AvatarResource> {
    if (this.#closed || !this.#scope.active) return Promise.resolve(unavailable);
    const source = sourceOf(profile);
    if ('state' in source) { this.release(owner); return Promise.resolve(source); }
    const key = source.kind + ':' + (source.kind === 'data' ? source.mime + ':' : '') + source.value;
    if (this.#owners.get(owner) !== key) this.release(owner);
    let entry = this.#entries.get(key);
    const owners = entry?.owners ?? new Set<string>();
    if (entry?.result?.state === 'unavailable') {
      entry.abort.abort();
      this.#entries.delete(key);
      entry = undefined;
    }
    if (!entry) {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), avatarTimeoutMs);
      const promise = this.#read(source, abort.signal).catch(() => unavailable)
        .finally(() => clearTimeout(timer));
      const created: AvatarEntry = { owners, abort, promise };
      entry = created;
      this.#entries.set(key, entry);
      void promise.then((result) => { created.result = result; });
    }
    this.#owners.set(owner, key);
    entry.owners.add(owner);
    return entry.promise;
  }

  async #read(source: AvatarSource, signal: AbortSignal): Promise<AvatarResource> {
    let blob: Blob;
    if (source.kind === 'ref') blob = await this.#scope.fetchAvatar(source.value, signal);
    else {
      const binary = atob(source.value);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      blob = new Blob([bytes], { type: source.mime });
    }
    return validatedImage(blob, signal);
  }

  release(owner: string): void {
    const key = this.#owners.get(owner);
    if (key === undefined) return;
    this.#owners.delete(owner);
    const entry = this.#entries.get(key);
    if (!entry) return;
    entry.owners.delete(owner);
    if (entry.owners.size === 0) {
      entry.abort.abort();
      this.#entries.delete(key);
    }
  }

  // Cancel unfinished loads from the old snapshot. Completed inline resources remain usable.
  cancelPending(): void {
    for (const [key, entry] of this.#entries) if (entry.result === undefined) {
      entry.abort.abort();
      this.#entries.delete(key);
      for (const owner of entry.owners) if (this.#owners.get(owner) === key) this.#owners.delete(owner);
    }
  }

  // Ending the me subscription clears pending loads while keeping the loader reusable.
  clear(): void {
    for (const entry of this.#entries.values()) entry.abort.abort();
    this.#owners.clear();
    this.#entries.clear();
  }

  dispose(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#detachScope();
    this.#detachScope = () => {};
    this.clear();
  }
}
