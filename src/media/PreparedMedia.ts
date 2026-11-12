import type { ConversationIdentity } from '../conversation/conversation-types';

interface PreparedFile {
  readonly blob: Blob;
  readonly filename: string;
}
export type PreparedMediaInput = PreparedFile & (
  | { readonly kind: 'photo'; readonly width: number; readonly height: number; readonly preview?: string }
  | { readonly kind: 'voice'; readonly durationMs: number; readonly waveform?: string }
);

export interface PreparedMedia {
  readonly kind: PreparedMediaInput['kind'];
}
const files = new WeakMap<PreparedMedia, { readonly identity: ConversationIdentity; readonly file: PreparedMediaInput }>();

export function createPreparedMedia(identity: ConversationIdentity, file: PreparedMediaInput): PreparedMedia {
  const handle = Object.freeze({ kind: file.kind });
  files.set(handle, Object.freeze({ identity: Object.freeze({ ...identity, account: Object.freeze({ ...identity.account }) }),
    file: Object.freeze({ ...file }) }));
  return handle;
}

export function preparedMediaFile(handle: PreparedMedia) {
  return files.get(handle);
}
