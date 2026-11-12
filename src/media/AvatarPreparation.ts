import { groupCreationPacketBytes, groupCreationParams } from '../groups/group-creation-packet';
import { groupPublicSetBytes, groupPublicSetParams, maxGroupAvatarBytes } from '../chat-info/group-public-patch';
import { maxOwnAvatarBytes, ownProfileSetBytes, ownProfileSetParams } from '../profile/own-profile-patch';
import type { ErrorMessageCode } from '../i18n/resources';
import { MediaFailure } from './MediaResources';
import type { ServerLimit } from './MediaResources';
import { checkPhotoAborted, encodePhotoCanvas, withDecodedPhoto } from './PhotoPreparation';

const avatarEdges = [512, 384, 256, 192, 128, 96, 64] as const;

const messages = {
  busy: 'chatInfoAvatarPreparationBusy',
  unsupported: 'chatInfoAvatarUnsupported',
  inputTooLarge: 'chatInfoAvatarInputTooLarge',
  tooLarge: 'chatInfoAvatarTooLarge',
  unavailable: 'chatInfoAvatarPreparationFailed',
  limitsUnavailable: 'chatInfoAvatarLimitUnavailable',
} as const satisfies Record<string, ErrorMessageCode>;

type AvatarFailure = keyof typeof messages;

export class AvatarPreparationFailure extends MediaFailure {
  readonly messageCode: (typeof messages)[AvatarFailure];

  constructor(failure: AvatarFailure) {
    super(failure === 'inputTooLarge' ? 'tooLarge' : failure === 'limitsUnavailable' ? 'unavailable' : failure);
    this.messageCode = messages[failure];
  }
}

export interface PreparedAvatar {
  readonly blob: Blob;
  readonly edge: number;
  readonly photoType: 'jpeg' | 'png';
}

interface AvatarPreparationOptions {
  readonly topicKey: string;
  readonly creationTitle?: string;
  readonly maxMessageSize: ServerLimit;
}

// Tinode's set envelope for a photo-only update. Reserve a full safe-integer
// request ID. The write path checks the actual packet, including a title if present.
function photoByteBudget(topicKey: string, limit: number, type: PreparedAvatar['photoType'], creationTitle?: string): number {
  const photo = { type, data: '' };
  const own = topicKey === 'me';
  const overhead = own ? ownProfileSetBytes(ownProfileSetParams({ photo }))
    : creationTitle === undefined ? groupPublicSetBytes(topicKey, groupPublicSetParams({ photo }))
      : groupCreationPacketBytes(groupCreationParams(creationTitle, '0'.repeat(36), photo), topicKey === 'nch' ? 'channel' : 'group');
  // Every three raw bytes require four ASCII characters in photo.data.
  return Math.min(own ? maxOwnAvatarBytes : maxGroupAvatarBytes, 3 * Math.floor((limit - overhead) / 4));
}

export async function prepareAvatar(
  file: File, { topicKey, creationTitle, maxMessageSize }: AvatarPreparationOptions, signal?: AbortSignal,
): Promise<PreparedAvatar> {
  checkPhotoAborted(signal);
  if (topicKey !== 'me' && !/^(?:grp|chn)[A-Za-z0-9_-]+$/.test(topicKey) &&
    !((topicKey === 'new' || topicKey === 'nch') && creationTitle !== undefined)) throw new AvatarPreparationFailure('unavailable');
  if (maxMessageSize.state !== 'known' || !Number.isSafeInteger(maxMessageSize.value) || maxMessageSize.value <= 0) {
    throw new AvatarPreparationFailure('limitsUnavailable');
  }
  const limit = maxMessageSize.value;
  try {
    return await withDecodedPhoto(file, signal, async (image, context, mime) => {
      const photoType = mime === 'image/png' ? 'png' : 'jpeg';
      const budget = photoByteBudget(topicKey, limit, photoType, creationTitle);
      if (budget <= 0) throw new AvatarPreparationFailure('tooLarge');
      const { naturalWidth: width, naturalHeight: height } = image;
      const crop = Math.min(width, height);
      const startEdge = Math.min(crop, avatarEdges[0]);
      const canvas = context.canvas;
      const qualities = photoType === 'png' ? [undefined] : [0.86, 0.68];
      for (const edge of [startEdge, ...avatarEdges.filter(edge => edge < startEdge)]) {
        canvas.width = canvas.height = edge;
        context.imageSmoothingQuality = 'high';
        context.drawImage(image, (width - crop) / 2, (height - crop) / 2, crop, crop, 0, 0, edge, edge);
        for (const quality of qualities) {
          const blob = await encodePhotoCanvas(canvas, mime, quality);
          checkPhotoAborted(signal);
          if (blob.size <= budget) return Object.freeze({ blob, edge, photoType });
        }
      }
      throw new AvatarPreparationFailure('tooLarge');
    });
  } catch (reason: unknown) {
    if (reason instanceof MediaFailure) {
      if (reason.reason === 'aborted' || reason instanceof AvatarPreparationFailure) throw reason;
      if (reason.reason === 'tooLarge') throw new AvatarPreparationFailure('inputTooLarge');
      if (reason.reason === 'unsupported' || reason.reason === 'busy') throw new AvatarPreparationFailure(reason.reason);
    }
    throw new AvatarPreparationFailure('unavailable');
  }
}
