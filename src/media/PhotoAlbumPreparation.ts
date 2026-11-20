import { mediaByteBudget } from './MediaResources';
import type { ServerLimits } from './MediaResources';
import type { PreparedMediaInput, PreparedPhotoInput } from './PreparedMedia';
import { preparePhoto, PhotoPreparationFailure, checkPhotoAborted } from './PhotoPreparation';
export { PhotoPreparationFailure } from './PhotoPreparation';

export async function preparePhotoAlbum(files: readonly File[], limits: ServerLimits, signal: AbortSignal,
  onPhoto: (index: number, photo: PreparedPhotoInput) => void): Promise<PreparedMediaInput> {
  if (!files.length) throw new PhotoPreparationFailure('invalidResponse');
  const inline = limits.maxInlineMediaSize;
  let outputBudget = inline?.state === 'known' ? inline.value : undefined;
  let previewBudget = 32 * 1024;
  if (files.length > 1) {
    if (limits.maxMessageSize.state !== 'known') throw new PhotoPreparationFailure('unavailable');
    // Reserve the publication envelope and worst-case UTF-8 filenames before dividing the packet.
    const available = limits.maxMessageSize.value - 2048 - files.length * 1536;
    const perPhoto = Math.floor(Math.floor(available / 4) * 3 / files.length);
    if (perPhoto < 256) throw new PhotoPreparationFailure('tooLarge');
    previewBudget = Math.min(previewBudget, perPhoto);
    if (inline) outputBudget = Math.min(outputBudget ?? perPhoto, perPhoto);
  }
  const prepared: PreparedPhotoInput[] = [];
  let bytes = 0;
  for (let index = 0; index < files.length; index++) {
    checkPhotoAborted(signal);
    const photo = await preparePhoto(files[index]!, signal, outputBudget, previewBudget);
    bytes += photo.blob.size;
    if (bytes > mediaByteBudget) throw new PhotoPreparationFailure('tooLarge');
    prepared.push(photo);
    onPhoto(index, photo);
  }
  checkPhotoAborted(signal);
  return prepared.length === 1 ? prepared[0]! : { ...prepared[0]!, photos: Object.freeze(prepared) };
}
