import type {
  AvatarResource,
  ChatListErrorKind,
  ChatSequence,
  ChatTitle,
} from '../chats/chat-list-types';
import type {
  ConversationAccess,
  ConversationHeader,
  ConversationHeaderPreview,
  ConversationIdentity,
  ConversationPresence,
  NavigationGeneration,
} from '../conversation/conversation-types';
import type { ServerLimit } from '../media/MediaResources';
import type { TranslationResources } from '../i18n/resources';

export interface ChatInfoIdentity extends ConversationIdentity {
  // A non-negative safe integer assigned each time the panel opens.
  // Compare the full account, topic, kind, and panelGeneration rather than topicKey alone.
  readonly panelGeneration: NavigationGeneration;
}

// Known details for the initial render. The seed does not confirm permissions or membership.
export type ChatInfoSeed = Pick<ConversationHeaderPreview, 'title' | 'avatar'> & (
  | { readonly kind: 'personal'; readonly presence?: ConversationPresence }
  | { readonly kind: 'group'; readonly participantCount?: ChatSequence; readonly isChannel?: true }
);

export type PersonalChatInfoDetails = Extract<ConversationHeader, { kind: 'personal' }>;
export type GroupChatInfoDetails = Omit<Extract<ConversationHeader, { kind: 'group' }>, 'onlineCount'>;
export type ChatInfoDetails = PersonalChatInfoDetails | GroupChatInfoDetails;

export type ChatInfoOwnership =
  | { readonly state: 'owner' }
  | { readonly state: 'notOwner' }
  | { readonly state: 'unknown' };

export interface ChatInfoMember {
  readonly uid: string;
  readonly displayName: ChatTitle;
  readonly avatar: AvatarResource;
  // Mark the owner only when O is confirmed. Hidden or missing acs leaves ownership unknown.
  readonly ownership: ChatInfoOwnership;
  readonly removable: boolean;
}

export interface ChatInfoMemberList {
  // Unique user IDs in stable order. The roster omits presence and raw public or acs fields.
  readonly members: readonly ChatInfoMember[];
  // Total roster size reported for a regular group. The channel roster uses unknown here.
  // The total channel subscriber count lives separately in header.participantCount.
  readonly totalCount: ChatSequence;
}

export type ChatInfoLoadedMembers = ChatInfoMemberList & (
  | { readonly state: 'ready' }
  // Channel members visible to the requester. The full reader list may be unavailable.
  | { readonly state: 'available' }
  | {
      readonly state: 'partial';
      readonly reason: 'serverLimit' | 'clientLimit' | 'restricted' | 'incompleteResponse';
    }
);

export type ChatInfoMembersState =
  | { readonly state: 'loading'; readonly lastKnown?: ChatInfoLoadedMembers }
  | ChatInfoLoadedMembers
  | {
      readonly state: 'unavailable';
      readonly reason: 'permission' | 'unsupported';
      readonly error: ChatInfoError;
    }
  | {
      readonly state: 'failed';
      readonly error: ChatInfoError;
      readonly lastKnown?: ChatInfoLoadedMembers;
    };

// Normalized permission strings, independent of the SDK's AccessMode object.
// Known access requires valid want, given, and mode, with mode equal to want & given.
export type ChatInfoOwnAccess =
  | { readonly state: 'unknown' }
  | {
      readonly state: 'known';
      readonly want: string;
      readonly given: string;
      readonly mode: string;
    };

export type ChatInfoActionAvailability = ConversationAccess
  | { readonly state: 'denied'; readonly reason: 'unsupported' };

export interface ChatInfoPermissions {
  readonly ownAccess: ChatInfoOwnAccess;
  // Editing is available only for a group with confirmed O permission. A permission alone is insufficient.
  readonly canEditGroup: ChatInfoActionAvailability;
  readonly canChangeMute: ChatInfoActionAvailability;
}

export type ChatInfoMuteState =
  | { readonly state: 'unknown' }
  | { readonly state: 'confirmed'; readonly muted: boolean }
  | { readonly state: 'saving'; readonly target: boolean; readonly previous: boolean }
  | { readonly state: 'reconciling' | 'failed'; readonly target: boolean; readonly previous: boolean; readonly error: ChatInfoError };

export interface ChatInfoMuteResult extends ChatInfoContext {
  readonly permissions: ChatInfoPermissions;
  readonly mute: Exclude<ChatInfoMuteState, { readonly state: 'saving' }>;
}

interface ChatInfoOwnState {
  readonly permissions: ChatInfoPermissions;
  readonly mute: ChatInfoMuteState;
}

export type ChatInfoData = ChatInfoOwnState & (
  | PersonalChatInfoDetails
  | (GroupChatInfoDetails & { readonly members: ChatInfoMembersState })
);

export type ChatInfoErrorKind = ChatListErrorKind;
export type ChatInfoErrorArea = 'details' | 'members' | 'ownAccess' | 'groupSave';

export type ChatInfoErrorMessageCode = keyof Pick<TranslationResources['errors'],
  | 'chatInfoNetwork'
  | 'chatInfoTimeout'
  | 'chatInfoPermission'
  | 'chatInfoInvalidResponse'
  | 'chatInfoUnavailable'
  | 'chatInfoSessionClosed'
  | 'chatInfoRefreshFailed'
  | 'chatInfoMembersUnavailable'
  | 'chatInfoMembersTimeout'
  | 'chatInfoMembersPermission'
  | 'chatInfoMembersInvalidResponse'
  | 'chatInfoMembersIncomplete'
  | 'chatInfoMemberRemoveDenied'
  | 'chatInfoMemberRemoveFailed'
  | 'chatInfoMemberRemoveUnknown'
  | 'chatInfoMemberAddDenied'
  | 'chatInfoMemberAddFailed'
  | 'chatInfoMuteUnavailable'
  | 'chatInfoMuteDenied'
  | 'chatInfoMuteFailed'
  | 'chatInfoChannelMuteNotSaved'
  | 'chatInfoMuteUnknown'
  | 'chatInfoMuteBusy'
  | 'chatInfoGroupSaveDenied'
  | 'chatInfoGroupSaveInvalid'
  | 'chatInfoGroupSaveTooLarge'
  | 'chatInfoGroupSaveLimits'
  | 'chatInfoGroupSaveFailed'
  | 'chatInfoGroupSaveUnknown'
  | 'chatInfoGroupSaveBusy'
>;

export interface ChatInfoError {
  readonly kind: ChatInfoErrorKind;
  readonly area: ChatInfoErrorArea;
  readonly messageCode: ChatInfoErrorMessageCode;
  readonly retryable: boolean;
  // Validated numeric status only. Keep the raw Error and its message out of the UI.
  readonly serverCode?: number;
}

export type ChatInfoRefresh =
  | { readonly state: 'idle' }
  | { readonly state: 'pending' }
  | { readonly state: 'failed'; readonly error: ChatInfoError };

interface ChatInfoContext {
  readonly identity: ChatInfoIdentity;
  // Local non-negative safe integer. A late snapshot cannot roll back a live update.
  readonly revision: number;
}

export interface ChatInfoGroupPatch {
  readonly title?: string;
  readonly avatar?: import('../media/AvatarPreparation').PreparedAvatar;
}

type ChatInfoGroupSaveOutcome =
  | { readonly state: 'confirmed' }
  | { readonly state: 'failed' | 'unknown'; readonly error: ChatInfoError };

export type ChatInfoGroupSaveResult = ChatInfoContext & ChatInfoGroupSaveOutcome;
export type ChatInfoGroupSaveState = ChatInfoGroupSaveOutcome | { readonly state: 'saving' | 'checking' };

export interface ChatInfoAddMembersResult {
  readonly failed: readonly string[];
  readonly error?: ChatInfoError;
}

export interface ChatInfoLoadResult extends ChatInfoContext {
  readonly data: ChatInfoData;
}

// Keep lastKnown only for the same identity while read access remains valid.
// Clear the data after an account switch or loss of read access.
export type ChatInfoSnapshot = ChatInfoContext & (
  | { readonly phase: 'idle' | 'loading'; readonly seed: ChatInfoSeed }
  | { readonly phase: 'ready'; readonly data: ChatInfoData; readonly refresh: ChatInfoRefresh; readonly groupSave?: ChatInfoGroupSaveState; readonly removingMember?: string }
  | {
      readonly phase: 'failed';
      readonly error: ChatInfoError;
      readonly seed?: ChatInfoSeed;
      readonly lastKnown?: ChatInfoData;
    }
  | { readonly phase: 'closed' }
);

export type ChatInfoEvent = ChatInfoContext & (
  | { readonly kind: 'detailsUpdated'; readonly details: ChatInfoDetails }
  | { readonly kind: 'membersUpdated'; readonly members: ChatInfoMembersState }
  | {
      readonly kind: 'ownAccessUpdated';
      readonly permissions: ChatInfoPermissions;
      readonly mute: ChatInfoMuteState;
    }
  | { readonly kind: 'invalidated'; readonly area: 'details' | 'members' | 'ownAccess' }
  | { readonly kind: 'unavailable'; readonly error: ChatInfoError }
  | { readonly kind: 'closed' }
);

export type ChatInfoListener = (event: ChatInfoEvent) => void;

export interface ChatInfoPort {
  readonly identity: ChatInfoIdentity;
  readonly seed: ChatInfoSeed;
  subscribe(listener: ChatInfoListener): () => void;
  // Aborting cancels the panel's interest without proving the server stopped processing the request.
  load(signal?: AbortSignal): Promise<ChatInfoLoadResult>;
  setMuted(target: boolean, signal?: AbortSignal): Promise<ChatInfoMuteResult>;
  saveGroup(patch: ChatInfoGroupPatch, signal?: AbortSignal): Promise<ChatInfoGroupSaveResult>;
  checkGroupSave(signal?: AbortSignal): Promise<ChatInfoGroupSaveResult>;
  removeMember(uid: string, signal: AbortSignal): Promise<void>;
  addMembers(uids: readonly string[], signal: AbortSignal): Promise<readonly string[]>;
  // Loads images for visible members only. It does not fetch profiles or memberships, or perform writes.
  setVisibleMembers(uids: readonly string[]): void;
  // Idempotently release the panel's interest while keeping the SDK, me topic, and conversation open.
  dispose(): void;
}

// Child route for an established conversation. The factory uses the same owner
// and closes only the panel. The UI receives no SDK objects.
export interface ChatInfoNavigation {
  readonly identity: ChatInfoIdentity;
  readonly seed: ChatInfoSeed;
  readonly maxMessageSize?: ServerLimit;
  readonly openPort: () => Promise<ChatInfoPort>;
}
