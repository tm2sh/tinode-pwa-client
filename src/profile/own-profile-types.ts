import type { AccountScope, CurrentUserProfile } from '../chats/chat-list-types';
import type { PreparedAvatar } from '../media/AvatarPreparation';
import type { ServerLimit } from '../media/MediaResources';

export type ConfirmedOwnProfile = Extract<CurrentUserProfile, { readonly state: 'available' }>;

export interface OwnProfilePatch {
  readonly displayName?: string;
  readonly avatar?: { readonly kind: 'replace'; readonly prepared: PreparedAvatar } | { readonly kind: 'remove' };
}

export type OwnProfileSaveResult =
  | { readonly state: 'confirmed'; readonly account: AccountScope; readonly profile: ConfirmedOwnProfile }
  | { readonly state: 'rejected'; readonly reason: 'invalid' | 'busy' | 'permission' | 'tooLarge' | 'limitsUnavailable' | 'server' }
  | { readonly state: 'unknown' }
  | { readonly state: 'cancelled'; readonly reason: 'closed' | 'aborted' };

export interface OwnProfilePort {
  readonly account: AccountScope;
  readonly maxMessageSize: ServerLimit;
  save(patch: OwnProfilePatch, signal: AbortSignal): Promise<OwnProfileSaveResult>;
  // Checking an unknown outcome only reads from the server. It never retries the write automatically.
  checkSave(signal: AbortSignal): Promise<OwnProfileSaveResult>;
}
