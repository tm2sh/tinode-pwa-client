import { MediaFailure } from './MediaResources';
import type { PreparedMediaInput } from './PreparedMedia';

const maxInputBytes = 32 * 1024 * 1024;
const maxInputPixels = 25_000_000;
const maxOutputEdge = 2048;
const maxPreviewBytes = 32 * 1024;
const headerWindow = 16 * 1024;

type EncodedPhotoMime = 'image/jpeg' | 'image/png';
type PhotoMime = EncodedPhotoMime | 'image/heic';
type PreparedPhoto = Extract<PreparedMediaInput, { kind: 'photo' }>;
type Size = { width: number; height: number };

const failureMessages = {
  busy: 'conversationPhotoPreparationBusy',
  tooLarge: 'conversationMediaTooLarge',
  unsupported: 'conversationMediaUnsupported',
  invalidResponse: 'conversationPhotoPreparationFailed',
  unavailable: 'conversationPhotoPreparationFailed',
} as const;

export class PhotoPreparationFailure extends MediaFailure {
  readonly messageCode: (typeof failureMessages)[keyof typeof failureMessages];

  constructor(reason: keyof typeof failureMessages) {
    super(reason);
    this.messageCode = failureMessages[reason];
  }
}

export function checkPhotoAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new MediaFailure('aborted');
}

function checkSize({ width, height }: Size, maxEdge?: number): void {
  if (width <= 0 || height <= 0) throw new PhotoPreparationFailure('invalidResponse');
  if (width * height > maxInputPixels || (maxEdge !== undefined && Math.max(width, height) > maxEdge)) {
    throw new PhotoPreparationFailure('tooLarge');
  }
}

class PhotoHeader {
  readonly #file: Blob;
  readonly #signal?: AbortSignal;
  #window?: DataView;
  #offset = 0;

  constructor(file: Blob, signal?: AbortSignal) {
    this.#file = file;
    this.#signal = signal;
  }

  async read(offset: number, count: number): Promise<DataView> {
    checkPhotoAborted(this.#signal);
    if (offset + count > this.#file.size) throw new PhotoPreparationFailure('invalidResponse');
    const window = this.#window;
    if (!window || offset < this.#offset || offset + count > this.#offset + window.byteLength) {
      this.#window = new DataView(await this.#file.slice(offset, offset + Math.max(headerWindow, count)).arrayBuffer());
      this.#offset = offset;
      checkPhotoAborted(this.#signal);
    }
    return new DataView(this.#window!.buffer, offset - this.#offset, count);
  }
}

async function checkJpeg(header: PhotoHeader, length: number, maxEdge?: number): Promise<void> {
  let offset = 2;
  // Skip EXIF/ICC segments by length without loading their contents.
  for (let segment = 0; offset + 4 <= length && segment < 4096; segment++) {
    const marker = await header.read(offset, 2);
    if (marker.getUint8(0) !== 0xff) break;
    const code = marker.getUint8(1);
    if (code === 0xff) { offset++; continue; }
    if (code === 0xda || code === 0xd9 || code === 0) break;
    if (code === 0x01) { offset += 2; continue; }
    const segmentSize = (await header.read(offset + 2, 2)).getUint16(0);
    if (segmentSize < 2 || offset + 2 + segmentSize > length) break;
    if (code >= 0xc0 && code <= 0xcf && code !== 0xc4 && code !== 0xc8 && code !== 0xcc) {
      if (segmentSize < 8) break;
      const frame = await header.read(offset + 5, 4);
      checkSize({ width: frame.getUint16(2), height: frame.getUint16(0) }, maxEdge);
      return;
    }
    offset += 2 + segmentSize;
  }
  throw new PhotoPreparationFailure('invalidResponse');
}

function fourCC(view: DataView, offset: number): string {
  return String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1),
    view.getUint8(offset + 2), view.getUint8(offset + 3));
}

const heicBrands = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs']);

async function checkHeicExtents(header: PhotoHeader, start: number, end: number, parent?: string): Promise<void> {
  let offset = start;
  for (let boxes = 0; offset + 8 <= end && boxes < 4096; boxes++) {
    const box = await header.read(offset, 8);
    const type = fourCC(box, 4);
    const shortSize = box.getUint32(0);
    const headerSize = shortSize === 1 ? 16 : 8;
    const size = shortSize === 1 ? Number((await header.read(offset + 8, 8)).getBigUint64(0))
      : shortSize || end - offset;
    if (!Number.isSafeInteger(size) || size < headerSize || size > end - offset) {
      throw new PhotoPreparationFailure('invalidResponse');
    }
    const payload = offset + headerSize;
    const next = offset + size;
    if (parent === undefined && type === 'meta') {
      await checkHeicExtents(header, payload + 4, next, type);
    } else if ((parent === 'meta' && type === 'iprp') || (parent === 'iprp' && type === 'ipco')) {
      await checkHeicExtents(header, payload, next, type);
    } else if (parent === 'ipco' && type === 'ispe') {
      if (next - payload < 12) throw new PhotoPreparationFailure('invalidResponse');
      const extent = await header.read(payload + 4, 8);
      checkSize({ width: extent.getUint32(0), height: extent.getUint32(4) });
    }
    offset = next;
  }
  if (offset !== end) throw new PhotoPreparationFailure('invalidResponse');
}

async function inspectPhoto(file: Blob, signal?: AbortSignal, maxEdge?: number): Promise<PhotoMime> {
  const header = new PhotoHeader(file, signal);
  const first = await header.read(0, Math.min(12, file.size));
  if (first.byteLength >= 2 && first.getUint16(0) === 0xffd8) {
    await checkJpeg(header, file.size, maxEdge);
    return 'image/jpeg';
  }
  if (first.byteLength >= 8 && first.getUint32(0) === 0x89504e47 && first.getUint32(4) === 0x0d0a1a0a) {
    const png = await header.read(8, 16);
    if (png.getUint32(0) !== 13 || fourCC(png, 4) !== 'IHDR') {
      throw new PhotoPreparationFailure('invalidResponse');
    }
    checkSize({ width: png.getUint32(8), height: png.getUint32(12) }, maxEdge);
    return 'image/png';
  }
  if (maxEdge === undefined && first.byteLength >= 12 && fourCC(first, 4) === 'ftyp') {
    const size = first.getUint32(0);
    if (size < 16 || size > headerWindow || size % 4 !== 0) throw new PhotoPreparationFailure('unsupported');
    const brands = await header.read(0, size);
    let heic = heicBrands.has(fourCC(brands, 8));
    for (let offset = 16; !heic && offset < size; offset += 4) {
      heic = heicBrands.has(fourCC(brands, offset));
    }
    if (heic) {
      await checkHeicExtents(header, size, file.size);
      return 'image/heic';
    }
  }
  throw new PhotoPreparationFailure('unsupported');
}

// Header preflight precedes native full-image decoding.
export async function checkPhotoDisplay(blob: Blob, signal: AbortSignal): Promise<void> {
  if (blob.type === 'image/gif') {
    const header = new DataView(await blob.slice(0, 10).arrayBuffer());
    checkPhotoAborted(signal);
    if (header.byteLength !== 10) throw new PhotoPreparationFailure('invalidResponse');
    checkSize({ width: header.getUint16(6, true), height: header.getUint16(8, true) });
    return;
  }
  if (blob.type === 'image/webp') {
    const header = new DataView(await blob.slice(0, 30).arrayBuffer());
    checkPhotoAborted(signal);
    if (header.byteLength < 25) throw new PhotoPreparationFailure('invalidResponse');
    // https://developers.google.com/speed/webp/docs/riff_container
    const chunk = fourCC(header, 12);
    let size: Size;
    if (chunk === 'VP8X' && header.byteLength >= 30) {
      const uint24 = (offset: number) => header.getUint8(offset) + header.getUint8(offset + 1) * 256 + header.getUint8(offset + 2) * 65536;
      size = { width: uint24(24) + 1, height: uint24(27) + 1 };
    } else if (chunk === 'VP8L' && header.getUint8(20) === 0x2f) {
      const bits = header.getUint32(21, true);
      size = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    } else if (chunk === 'VP8 ' && header.byteLength >= 30 &&
      header.getUint8(23) === 0x9d && header.getUint8(24) === 0x01 && header.getUint8(25) === 0x2a) {
      size = { width: header.getUint16(26, true) & 0x3fff, height: header.getUint16(28, true) & 0x3fff };
    } else throw new PhotoPreparationFailure('invalidResponse');
    checkSize(size);
    return;
  }
  const detected = await inspectPhoto(blob, signal);
  if (detected !== blob.type) throw new PhotoPreparationFailure('invalidResponse');
}

export async function checkPhotoPreview(blob: Blob, signal: AbortSignal): Promise<void> {
  const detected = await inspectPhoto(blob, signal, 320);
  if (detected !== blob.type) throw new PhotoPreparationFailure('invalidResponse');
}

function fit({ width, height }: Size, edge: number): Size {
  const scale = Math.min(1, edge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export async function encodePhotoCanvas(canvas: HTMLCanvasElement, mime: EncodedPhotoMime, quality?: number): Promise<Blob> {
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, mime, quality));
  if (!blob || blob.size === 0 || blob.type !== mime) throw new PhotoPreparationFailure('unavailable');
  return blob;
}

async function base64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return btoa(String.fromCharCode(...bytes));
}

function filename(original: string, mime: EncodedPhotoMime): string {
  const name = original.replace(/\.[^.]+$/u, '').replace(/[\\/\u0000-\u001f\u007f]/gu, '_').trim();
  const base = [...name].slice(0, 120).join('') || 'photo';
  return base + (mime === 'image/png' ? '.png' : '.jpg');
}

let preparing = false;

export async function withDecodedPhoto<T>(file: File, signal: AbortSignal | undefined, use: (
  image: HTMLImageElement, context: CanvasRenderingContext2D, mime: EncodedPhotoMime,
) => Promise<T>): Promise<T> {
  checkPhotoAborted(signal);
  if (preparing) throw new PhotoPreparationFailure('busy');
  if (file.size === 0) throw new PhotoPreparationFailure('invalidResponse');
  if (file.size > maxInputBytes) throw new PhotoPreparationFailure('tooLarge');

  preparing = true;
  let image: HTMLImageElement | undefined;
  let url: string | undefined;
  let canvas: HTMLCanvasElement | undefined;
  const stopDecode = () => image?.removeAttribute('src');
  try {
    const sourceMime = await inspectPhoto(file, signal);
    checkPhotoAborted(signal);
    image = new Image();
    url = URL.createObjectURL(file.type === sourceMime ? file : file.slice(0, file.size, sourceMime));
    signal?.addEventListener('abort', stopDecode, { once: true });
    image.src = url;
    try {
      // The native image decoder applies EXIF orientation and HEIC transforms.
      await image.decode();
    } catch {
      checkPhotoAborted(signal);
      throw new PhotoPreparationFailure(sourceMime === 'image/heic' ? 'unsupported' : 'invalidResponse');
    }
    signal?.removeEventListener('abort', stopDecode);
    checkPhotoAborted(signal);
    checkSize({ width: image.naturalWidth, height: image.naturalHeight });
    canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new PhotoPreparationFailure('unavailable');
    return await use(image, context, sourceMime === 'image/png' ? 'image/png' : 'image/jpeg');
  } catch (error: unknown) {
    checkPhotoAborted(signal);
    if (error instanceof MediaFailure) throw error;
    throw new PhotoPreparationFailure('unavailable');
  } finally {
    signal?.removeEventListener('abort', stopDecode);
    stopDecode();
    if (url !== undefined) URL.revokeObjectURL(url);
    if (canvas) { canvas.width = 0; canvas.height = 0; }
    preparing = false;
  }
}

export function preparePhoto(file: File, signal?: AbortSignal, maxOutputBytes?: number, previewByteLimit = maxPreviewBytes): Promise<PreparedPhoto> {
  return withDecodedPhoto(file, signal, async (image, context, mime) => {
    const canvas = context.canvas;
    const input = { width: image.naturalWidth, height: image.naturalHeight };
    let output = fit(input, maxOutputEdge);
    const draw = ({ width, height }: Size) => {
      canvas.width = width;
      canvas.height = height;
      context.imageSmoothingQuality = 'high';
      context.drawImage(image, 0, 0, width, height);
    };

    draw(output);
    let blob = await encodePhotoCanvas(canvas, mime, 0.86);
    checkPhotoAborted(signal);
    if (maxOutputBytes !== undefined) {
      while (blob.size > maxOutputBytes && Math.max(output.width, output.height) > 1) {
        const edge = Math.max(1, Math.floor(Math.max(output.width, output.height) * 0.7));
        output = fit(input, edge);
        draw(output);
        blob = await encodePhotoCanvas(canvas, mime, 0.86);
        checkPhotoAborted(signal);
      }
      if (blob.size > maxOutputBytes) throw new PhotoPreparationFailure('tooLarge');
    }

    let preview: string | undefined;
    for (const edge of [320, 160, 80, 40]) {
      const size = fit(input, edge);
      if (size.width === output.width && size.height === output.height && blob.size <= previewByteLimit) {
        preview = await base64(blob);
        break;
      }
      draw(size);
      const thumbnail = await encodePhotoCanvas(canvas, mime, 0.72);
      checkPhotoAborted(signal);
      if (thumbnail.size <= previewByteLimit) {
        preview = await base64(thumbnail);
        break;
      }
    }
    checkPhotoAborted(signal);
    return { kind: 'photo', blob, filename: filename(file.name, mime), ...output, preview };
  });
}
