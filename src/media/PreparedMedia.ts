import type { ConversationIdentity } from '../conversation/conversation-types';

interface PreparedFile {
  readonly blob: Blob;
  readonly filename: string;
}
export type PreparedPhotoInput = PreparedFile & { readonly kind: 'photo'; readonly width: number; readonly height: number; readonly preview?: string };
export type PreparedMediaInput = (PreparedPhotoInput & { readonly photos?: readonly PreparedPhotoInput[] })
  | (PreparedFile & { readonly kind: 'voice'; readonly durationMs: number; readonly waveform?: string });

export interface PreparedMedia {
  readonly kind: PreparedMediaInput['kind'];
}
const files = new WeakMap<PreparedMedia, { readonly identity: ConversationIdentity; readonly file: PreparedMediaInput }>();

export function createPreparedMedia(identity: ConversationIdentity, file: PreparedMediaInput): PreparedMedia {
  const handle = Object.freeze({ kind: file.kind });
  files.set(handle, Object.freeze({ identity: Object.freeze({ ...identity, account: Object.freeze({ ...identity.account }) }),
    file: Object.freeze({ ...file, ...(file.kind === 'photo' && file.photos ? { photos: Object.freeze(file.photos.map(photo => Object.freeze({ ...photo }))) } : {}) }) }));
  return handle;
}

export function preparedMediaFile(handle: PreparedMedia) {
  return files.get(handle);
}
