import type { TranslationResources } from '../i18n/resources';
import type { ConversationDraft, ConversationDraftPort } from '../conversation/ConversationDraft';
import type { GroupCreationKind } from '../groups/group-creation-types';

export interface AccountScope {
  readonly serverId: string;
  readonly uid: string;
  readonly generation: number;
}

export type ChatKind = 'personal' | 'group';

// The value is a non-negative safe integer. The integration layer applies protocol defaults.
// In me.sub, an omitted read means 0, while an unknown seq stays unknown.
export type ChatSequence =
  | { readonly state: 'known'; readonly value: number }
  | { readonly state: 'unknown' };

export type ChatUnreadCount = ChatSequence;

// known.text is a non-empty display name. An unknown name gets a neutral label.
export type ChatTitle =
  | { readonly state: 'known'; readonly text: string }
  | { readonly state: 'unknown' };

// ISO UTC timestamp from a validated server ts or touched value, never the client clock.
export type ServerTimestamp = string;

export type ChatLastActivity =
  | {
      readonly state: 'known';
      readonly at: ServerTimestamp;
      readonly source: 'message' | 'subscription';
    }
  | { readonly state: 'unknown' };

// The prefix does not replace MIME and byte validation or Blob URL ownership.
// The UI must not use an HTTP image URL that carries a token in its query string.
export type AvatarImageSource =
  | `data:image/${string};base64,${string}`
  | `blob:${string}`;

export type AvatarResource =
  | { readonly state: 'missing' }
  | { readonly state: 'pending' }
  | { readonly state: 'ready'; readonly imageSource: AvatarImageSource }
  | { readonly state: 'unavailable' };

export interface SenderProfile {
  readonly profileKey: string;
  readonly displayName: ChatTitle;
  readonly avatar: AvatarResource;
}

export type MessageSender = (
  | { readonly state: 'self' }
  | {
      readonly state: 'known';
      readonly profileKey: string;
      readonly displayName: string;
    }
  | { readonly state: 'unknown'; readonly profileKey?: string }
) & { readonly avatar?: AvatarResource };

export type MessagePreviewContent =
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'photo' | 'voice' | 'video' | 'file' | 'unsupported';
      readonly caption?: string;
    };

export interface LastMessage {
  readonly mentionedMe?: boolean;
  // Sequence of the original message. An edit changes the version while preserving position and date.
  readonly seq: number;
  readonly versionSeq?: number;
  readonly timestamp: ServerTimestamp;
  readonly sender: MessageSender;
  readonly content: MessagePreviewContent;
}

export type LastMessagePreview =
  | { readonly state: 'pending'; readonly lastKnown?: LastMessage }
  | { readonly state: 'available'; readonly message: LastMessage }
  | {
      readonly state: 'empty';
      readonly reason: 'noMessages' | 'noAvailableMessages';
    }
  | {
      readonly state: 'unavailable';
      readonly error: ChatListError;
      readonly lastKnown?: LastMessage;
    };

export interface ChatActionTopic {
  readonly kind: 'personal' | 'group' | 'channel' | 'unknown';
  readonly role: 'owner' | 'member' | 'unknown';
}

export interface ChatActionDetails extends ChatActionTopic {
  readonly notificationsMuted?: boolean;
}

export interface ChatListItem {
  // The group count comes from me.sub subcnt. An absent or unknown count stays unknown.
  readonly participantCount?: ChatSequence;
  readonly mentionUnread?: boolean;
  // Effective notification setting of the signed-in member; absent when unknown.
  readonly notificationsMuted?: boolean;
  readonly draft?: ConversationDraft;
  // Stable server key, kept separate from the display name.
  readonly topicKey: string;
  readonly kind: ChatKind;
  readonly title: ChatTitle;
  readonly avatar: AvatarResource;
  readonly unread: ChatUnreadCount;
  readonly preview: LastMessagePreview;
  readonly lastActivityAt: ChatLastActivity;
}

// Internal adapter and controller record. The UI receives only ChatListItem.
export type ChatMuteErrorCode = keyof Pick<TranslationResources['errors'],
  'chatInfoMuteUnavailable' | 'chatInfoMuteDenied' | 'chatInfoMuteFailed' |
  'chatInfoChannelMuteNotSaved' | 'chatInfoMuteUnknown' | 'chatInfoMuteBusy'>;

export interface ChatMuteError {
  readonly messageCode: ChatMuteErrorCode;
  readonly retryable: boolean;
}

export type ChatMuteResult =
  | { readonly state: 'confirmed'; readonly muted: boolean }
  | { readonly state: 'failed' | 'reconciling'; readonly error: ChatMuteError };

export type ChatDeletionAction = 'deleteGroupForAll' | 'deleteChannelForAll';
export type ChatDepartureAction = 'deletePersonal' | 'leaveGroup' | 'unsubscribeChannel' | ChatDeletionAction;
export type ChatDepartureErrorCode = keyof Pick<TranslationResources['errors'],
  'chatDepartureUnavailable' | 'chatDepartureFailed' | 'chatDepartureUnknown' |
  'chatDeleteForAllUnavailable' | 'chatDeleteForAllFailed' | 'chatDeleteForAllUnknown'>;

export type ChatDepartureResult =
  | { readonly state: 'confirmed' }
  | { readonly state: 'failed'; readonly messageCode: ChatDepartureErrorCode };

export interface ChatRecord extends ChatListItem {
  readonly actionTopic: ChatActionTopic;
  readonly serverSeq: ChatSequence;
  readonly readSeq: ChatSequence;
  readonly revision: number;
}

export type CurrentUserProfile =
  | { readonly state: 'pending' }
  | {
      readonly state: 'available';
      readonly displayName: ChatTitle;
      readonly avatar: AvatarResource;
    }
  | { readonly state: 'unavailable'; readonly error: ChatListError };

export type ChatListErrorKind =
  | 'network'
  | 'timeout'
  | 'permission'
  | 'invalidResponse'
  | 'unavailable'
  | 'sessionClosed';

export type ChatListErrorArea = 'list' | 'preview' | 'profile';

export type ChatListErrorMessageCode = keyof Pick<TranslationResources['errors'],
  | 'chatListNetwork'
  | 'chatListTimeout'
  | 'chatListPermission'
  | 'chatListInvalidResponse'
  | 'chatListUnavailable'
  | 'chatListRefreshFailed'
  | 'chatListSessionClosed'
  | 'chatPreviewUnavailable'
  | 'chatPreviewTimeout'
  | 'chatPreviewPermission'
  | 'chatPreviewInvalidResponse'
  | 'chatProfileUnavailable'
>;

export interface ChatListError {
  readonly kind: ChatListErrorKind;
  readonly area: ChatListErrorArea;
  readonly messageCode: ChatListErrorMessageCode;
  readonly retryable: boolean;
  readonly messageParams?: { readonly seconds?: number };
  readonly serverCode?: number;
}

export type ChatListRefresh =
  | { readonly state: 'idle' }
  | { readonly state: 'pending' }
  | { readonly state: 'failed'; readonly error: ChatListError };

export type ChatListSnapshot =
  | {
      readonly phase: 'idle' | 'loading';
      readonly ownProfile?: CurrentUserProfile;
    }
  | {
      readonly phase: 'ready';
      readonly items: readonly ChatListItem[];
      readonly ownProfile: CurrentUserProfile;
      readonly refresh: ChatListRefresh;
    }
  | {
      readonly phase: 'error';
      readonly error: ChatListError;
      readonly ownProfile?: CurrentUserProfile;
    }
  | { readonly phase: 'closed' };

export interface ChatListLoadResult {
  readonly scope: AccountScope;
  readonly revision: number;
  readonly records: readonly ChatRecord[];
  readonly ownProfile: CurrentUserProfile;
}

export interface ChatPreviewResult {
  readonly scope: AccountScope;
  readonly topicKey: string;
  readonly revision: number;
  readonly preview: LastMessagePreview;
  readonly lastActivityAt: ChatLastActivity;
}

interface ChatListEventContext {
  readonly scope: AccountScope;
  readonly revision: number;
}

// Fields confirmed by an upsert. A partial update leaves the other fields intact.
export type ChatRecordUpdateField = 'metadata' | 'avatar' | 'notificationsMuted' | 'draft' | 'serverSeq' | 'readSeq' | 'preview' | 'activity';

export type ChatListEvent = ChatListEventContext & (
  | { readonly kind: 'chatUpsert'; readonly record: ChatRecord; readonly updatedFields?: readonly ChatRecordUpdateField[] }
  | { readonly kind: 'chatRemoved'; readonly topicKey: string }
  | { readonly kind: 'readPending'; readonly topicKey: string; readonly serverSeq: number }
  | {
      readonly kind: 'readUpdated';
      readonly topicKey: string;
      readonly readSeq: ChatSequence;
    }
  | {
      readonly kind: 'previewUpdated';
      readonly topicKey: string;
      readonly preview: LastMessagePreview;
      readonly lastActivityAt: ChatLastActivity;
    }
  | { readonly kind: 'profileUpdated'; readonly profile: SenderProfile }
  | { readonly kind: 'ownProfileUpdated'; readonly profile: CurrentUserProfile }
  | { readonly kind: 'unavailable'; readonly error: ChatListError }
  | { readonly kind: 'closed' }
);

export type ChatListListener = (event: ChatListEvent) => void;

// consumerId is a non-negative NavigationGeneration that increases on each transition.
// The handle is valid only for its account and generation.
export interface ChatPreviewPause {
  readonly account: AccountScope;
  readonly navigationGeneration: number;
  readonly active: boolean;
  waitTopicIdle(topicKey: string, signal?: AbortSignal): Promise<void>;
  // Confirms and publishes a personal subscription before opening a chat absent from the list.
  preparePersonalChat?(userId: string, signal: AbortSignal): Promise<void>;
  prepareCreatedGroup?(topicKey: string, signal: AbortSignal, kind: GroupCreationKind): Promise<void>;
  refreshPreview(topicKey: string, change: 'message' | 'delete'): void;
  // An already reserved topic with an unknown outcome stays isolated until a new scope.
  blockTopic(topicKey: string): void;
  // Call after safely closing or isolating the conversation. The handle does not close it.
  release(): void;
}

// Normalized integration boundary for the controller, without SDK or sign-in data.
// Aborting cancels the caller's interest without proving that the data stream has stopped.
export interface ChatListPort {
  readonly account: AccountScope;
  subscribe(listener: ChatListListener): () => void;
  load(signal?: AbortSignal): Promise<ChatListLoadResult>;
  // Loads only the current user's profile and publishes it through ownProfileUpdated.
  refreshOwnProfile(): Promise<void>;
  reconcileForeground(): void;
  openDraft?(topicKey: string): ConversationDraftPort | undefined;
  readActionDetails(topicKey: string, signal: AbortSignal): Promise<ChatActionDetails>;
  setMuted(topicKey: string, muted: boolean): Promise<ChatMuteResult>;
  departChat(topicKey: string, action: ChatDepartureAction): Promise<ChatDepartureResult>;
  loadPreview(topicKey: string, signal?: AbortSignal): Promise<ChatPreviewResult>;
  pausePreviews(consumerId: number): ChatPreviewPause;
  dispose(): void;
}
