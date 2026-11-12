import type { ChatInfoPort } from '../chat-info/chat-info-types';
import type { PreparedMedia } from '../media/PreparedMedia';
import type { ServerLimits, MediaLease } from '../media/MediaResources';
import type {
  AccountScope,
  AvatarImageSource,
  AvatarResource,
  ChatKind,
  ChatSequence,
  ChatTitle,
  ServerTimestamp,
} from '../chats/chat-list-types';
import type { TranslationResources } from '../i18n/resources';

// The prefix constrains the TypeScript type. Runtime validation checks the suffix
// and allowed characters and excludes me, fnd, sys, new, and nch.
export type ConversationTopicKey = `usr${string}` | `grp${string}` | `chn${string}`;

export interface ConversationIdentity {
  // Compare serverId, uid, and generation as well as topicKey.
  readonly account: AccountScope;
  readonly topicKey: ConversationTopicKey;
  readonly kind: ChatKind;
}

// Local navigation generation, represented by a non-negative safe integer.
export type NavigationGeneration = number;

export type ConversationTimestamp =
  | { readonly state: 'known'; readonly at: ServerTimestamp }
  | { readonly state: 'unknown' };

export type ConversationPresence =
  | { readonly state: 'online' }
  | { readonly state: 'offline'; readonly lastSeenAt?: ServerTimestamp }
  | { readonly state: 'unknown' };

// Known chat card data for the initial header, including subcnt.
// Permissions, read markers, and presence still require a server response.
export interface ConversationHeaderPreview {
  readonly isChannel?: true;
  readonly participantCount?: ChatSequence;
  readonly kind: ChatKind;
  readonly title: ChatTitle;
  readonly avatar: AvatarResource;
}

interface ConversationHeaderBase {
  readonly title: ChatTitle;
  readonly avatar: AvatarResource;
}

export type ConversationHeader = ConversationHeaderBase & (
  | {
      readonly kind: 'personal';
      readonly peerUid: string;
      readonly presence: ConversationPresence;
    }
  | {
      readonly kind: 'group';
      // Identified by the server's chan flag or the chn reader address. The count includes readers.
      readonly isChannel?: true;
      // A known count is confirmed independently of a partial sub response.
      readonly participantCount: ChatSequence;
      readonly onlineCount: ChatSequence;
    }
);

export type ConversationAccess =
  | { readonly state: 'unknown' }
  | { readonly state: 'allowed' }
  | {
      readonly state: 'denied';
      readonly reason: 'notGranted' | 'sessionClosed';
    };

export interface ConversationPermissions {
  readonly canRead: ConversationAccess;
  readonly canWrite: ConversationAccess;
  readonly canDelete: ConversationAccess;
}

export type ConversationSender =
  | { readonly state: 'self'; readonly uid: string }
  | {
      readonly state: 'other';
      readonly uid: string;
      readonly displayName: ChatTitle;
      readonly avatar: AvatarResource;
    }
  | { readonly state: 'unknown'; readonly uid?: string };

// Offsets use the normalized text. start and length are safe integers with start >= 0,
// length > 0, and start + length <= text.length. The normalizer checks order and overlaps.
export type ConversationTextSpan =
  | {
      readonly start: number;
      readonly length: number;
      readonly kind: 'bold' | 'italic' | 'strike' | 'code' | 'quote' | 'highlight';
    }
  | {
      readonly start: number;
      readonly length: number;
      readonly kind: 'link';
      // Validated link from the message, separate from any authenticated media URL.
      readonly url: `https://${string}` | `http://${string}`;
    };

export interface ConversationText {
  readonly text: string;
  readonly spans: readonly ConversationTextSpan[];
}

// Opaque integration resource ID, distinct from a URL, base64 payload, Blob, or DOM src.
// Resource bytes and credentials stay out of messages and public snapshots.
export type ConversationMediaReference =
  | { readonly state: 'missing' }
  | { readonly state: 'available'; readonly resourceId: string };

export type ConversationImageDimensions =
  | {
      readonly state: 'known';
      // Positive safe integers after validation.
      readonly width: number;
      readonly height: number;
    }
  | { readonly state: 'unknown' };

export interface PhotoAttachment {
  readonly kind: 'photo';
  readonly media: ConversationMediaReference;
  readonly dimensions: ConversationImageDimensions;
  readonly size: ChatSequence;
  readonly mime?: string;
  readonly filename?: string;
  // Small, validated preview. The full photo is stored outside the model.
  readonly preview?: Extract<ConversationMediaReference, { state: 'available' }>;
}

export interface VoiceAttachment {
  readonly kind: 'voice';
  readonly media: ConversationMediaReference;
  readonly size: ChatSequence;
  // Actual recording duration in milliseconds. An unknown duration stays unknown.
  readonly durationMs: ChatSequence;
  readonly mime?: string;
  readonly filename?: string;
  // Small, normalized amplitude samples from 0 to 255, independent of the full PCM data.
  readonly waveform?: readonly number[];
}

export interface UnsupportedAttachment {
  readonly kind: 'unsupported';
  readonly contentType: 'video' | 'file' | 'form' | 'unknown';
  readonly filename?: string;
}

export type ConversationAttachment = PhotoAttachment | VoiceAttachment | UnsupportedAttachment;

export interface ConversationContent {
  readonly text: ConversationText;
  readonly attachments: readonly ConversationAttachment[];
}

export interface ConversationMessage {
  // Positive safe integer unique within the topic. Keep its full precision beyond int32.
  readonly serverSeq: number;
  readonly timestamp: ConversationTimestamp;
  readonly sender: ConversationSender;
  readonly content: ConversationContent;
  readonly delivery: 'serverConfirmed';
  // For head.replace, track the original message's sequence and a separate version sequence.
  readonly originalSeq?: number;
  readonly versionSeq?: number;
  // Server timestamp of the winning version; the original send time stays separate.
  readonly editedAt?: ServerTimestamp;
  // Validated UUID from this user's publication. Tinode does not deduplicate on it.
  readonly operationId?: string;
}

export interface ConversationPageQuery {
  // Positive safe integers. since is inclusive and before is exclusive.
  // When both bounds are set, since must precede before. The adapter checks the server limit.
  readonly since?: number;
  readonly before?: number;
  readonly limit: number;
}

export type ConversationPageCursor =
  | { readonly state: 'more'; readonly query: ConversationPageQuery }
  | { readonly state: 'end' }
  | { readonly state: 'unknown' };

export interface ConversationHistoryRange {
  readonly query: ConversationPageQuery;
  readonly snapshotUpperSeq: ChatSequence;
  readonly receivedSeq: readonly number[];
  // A complete page requires proven coverage beyond min, max, or count below the limit.
  readonly coverage: 'partial' | 'complete';
  readonly older: ConversationPageCursor;
  readonly newer: ConversationPageCursor;
}

interface ConversationResultContext {
  readonly identity: ConversationIdentity;
  // Local revision that increases within the current scope and starts at zero or higher.
  readonly revision: number;
}

export interface ConversationPageResult extends ConversationResultContext {
  readonly range: ConversationHistoryRange;
  // Explicit reads for originals of received message versions. Each response has its own query and count.
  readonly relatedPages?: readonly ConversationPageResult[];
  readonly messages: readonly ConversationMessage[];
  // Data packets received before applying live deletions or merging, independent of the message map size.
  readonly receivedCount: number;
}

export type ConversationOpeningTarget =
  | {
      readonly kind: 'message';
      readonly serverSeq: number;
      readonly reason: 'latest' | 'firstUnread' | 'lastRead' | 'resume';
      readonly offsetPx?: number;
    }
  | { readonly kind: 'empty' };

export interface ConversationReadingPosition {
  readonly confirmedReadSeq: ChatSequence;
  // A note expected to have been sent. The server has not acknowledged it.
  readonly pendingReadSeq?: number;
  readonly highestReceivedSeq: ChatSequence;
  readonly firstUnreadTarget?: number;
}

export type ConversationReadPositionResult = Pick<ConversationOpenResult,
  'identity' | 'revision' | 'history' | 'contextPages' | 'target'>;

export interface ConversationScrollAnchor {
  readonly serverSeq: number;
  // Finite offset in pixels. A partially visible row can have a negative offset.
  readonly offsetPx: number;
}

// Transient state of one still-open conversation; never persisted or used as an offline queue.
export interface ConversationCheckpoint {
  readonly identity: ConversationIdentity;
  readonly draft: string;
  readonly draftDirty?: boolean;
  readonly edit?: ConversationEditDraft;
  readonly atEnd: boolean;
  readonly anchor?: ConversationScrollAnchor;
  readonly outgoing: readonly ConversationOutgoing[];
}
export type ConversationResumePosition = { readonly kind: 'latest' }
  | { readonly kind: 'anchor'; readonly serverSeq: number };

export interface ConversationOpenResult extends ConversationResultContext {
  readonly header: ConversationHeader;
  readonly permissions: ConversationPermissions;
  // Undefined = server did not advertise a usable limit; 0 = unlimited.
  readonly maxDeleteAgeSeconds?: number;
  readonly history: ConversationPageResult;
  // Additional real reads for the window around the first unread message.
  // Existence checks are excluded, and their data is not published to the UI.
  readonly contextPages?: readonly ConversationPageResult[];
  readonly reading: ConversationReadingPosition;
  readonly target: ConversationOpeningTarget;
}

// Deletion uses server sequence ranges with inclusive low and exclusive hi.
export type ConversationDeleteScope = 'self' | 'all';
export type ConversationDeleteResult = 'selfConfirmed' | 'allUnconfirmed' | 'rejected' | 'unknown';

export interface ConversationDeletionRange {
  readonly low: number;
  // Tinode omits hi for a single sequence, including MAX_SAFE_INTEGER.
  readonly hi?: number;
}

export interface ConversationDeletionState {
  // clear is the non-negative safe integer ID of the deletion transaction, not a message sequence.
  readonly transactionId: number;
  readonly ranges: readonly ConversationDeletionRange[];
}

export type ConversationErrorArea = 'header' | 'history' | 'send' | 'media' | 'capture' | 'playback';
export type ConversationErrorKind =
  | 'network' | 'timeout' | 'permission' | 'invalidResponse'
  | 'unsupported' | 'tooLarge' | 'sessionClosed';

// An unknown publication outcome is intentionally excluded from ordinary retries.
export type ConversationErrorMessageCode = keyof Pick<TranslationResources['errors'],
  | 'conversationNetwork'
  | 'conversationTimeout'
  | 'conversationUnavailable'
  | 'conversationInvalidResponse'
  | 'conversationReadDenied'
  | 'conversationWriteDenied'
  | 'conversationSessionClosed'
  | 'conversationAttachUnconfirmed'
  | 'conversationHistoryUnavailable'
  | 'conversationHistoryTimeout'
  | 'conversationHistoryInterrupted'
  | 'conversationProfileUnavailable'
  | 'conversationLimitsUnavailable'
  | 'conversationSendRejected'
  | 'conversationTextEmpty'
  | 'conversationTextTooLarge'
  | 'conversationEditRejected'
  | 'conversationEditTooLarge'
  | 'conversationEditStale'
  | 'conversationEditAttachment'
  | 'conversationMediaUnavailable'
  | 'conversationMediaUnsupported'
  | 'conversationMediaTooLarge'
  | 'conversationPhotoPreparationFailed'
  | 'conversationPhotoPreparationBusy'
  | 'conversationMediaUploadFailed'
  | 'conversationMediaUploadTimeout'
  | 'conversationVoiceSendFailed'
  | 'conversationCaptureUnsupported'
  | 'conversationCaptureInterrupted'
  | 'conversationPlaybackUnavailable'
  | 'conversationPlaybackUnsupported'
>;

export type ConversationSendUnknownMessageCode = keyof Pick<TranslationResources['errors'],
  'conversationSendUnknown'>;

export interface ConversationError {
  readonly area: ConversationErrorArea;
  readonly kind: ConversationErrorKind;
  readonly messageCode: ConversationErrorMessageCode;
  readonly retryable: boolean;
  // Only validated finite, non-negative numeric parameters are exposed. The raw cause stays private.
  readonly messageParams?: { readonly seconds?: number; readonly maxBytes?: number };
  readonly serverCode?: number;
}

// Local operation metadata. A UUID correlates a publication; it is not an idempotency key.
export type ConversationOutgoingState =
  | { readonly phase: 'preparing' | 'publishing' | 'cancelled' }
  | { readonly phase: 'confirmed'; readonly serverSeq: number; readonly timestamp: ServerTimestamp }
  | { readonly phase: 'rejected'; readonly error: ConversationError }
  | { readonly phase: 'unknown'; readonly messageCode: ConversationSendUnknownMessageCode };
export type ConversationOutgoingOperation = ConversationResultContext & {
  readonly operationId: string;
  readonly kind: 'text' | 'photo' | 'voice' | 'edit';
  readonly targetSeq?: number;
  readonly requestId?: string;
  // Highest server sequence observed before this publication; not its eventual seq.
  readonly afterSeq?: number;
} & ConversationOutgoingState;

export interface ConversationReconcileCursor {
  readonly before: number;
  readonly upperSeq: number;
}
export interface ConversationReconcileQuery {
  readonly operationId: string;
  readonly targetSeq?: number;
  readonly afterSeq?: number;
  readonly cursor?: ConversationReconcileCursor;
}
export interface ConversationReconcileResult extends ConversationResultContext {
  readonly operationId: string;
  readonly pages: readonly ConversationPageResult[];
  // An undeleted publication with exact own UID/topic/UUID/target and valid time.
  readonly match?: ConversationMessage;
  readonly cursor?: ConversationReconcileCursor;
}
export type ConversationVerification = { readonly operationId: string } & (
  | { readonly state: 'checking' | 'unconfirmed' }
  | { readonly state: 'failed'; readonly error: ConversationError }
);

export type ConversationReadEvent = ConversationResultContext & (
  | { readonly kind: 'messageUpsert'; readonly message: ConversationMessage }
  | { readonly kind: 'outgoingUpdated'; readonly operation: ConversationOutgoingOperation }
  | { readonly kind: 'messagesDeleted'; readonly deletion: ConversationDeletionState }
  | { readonly kind: 'metadataUpdated'; readonly header: ConversationHeader }
  | { readonly kind: 'permissionsChanged'; readonly permissions: ConversationPermissions }
  | { readonly kind: 'readUpdated'; readonly confirmedReadSeq: ChatSequence }
  | { readonly kind: 'readPending'; readonly serverSeq: number }
  | {
      readonly kind: 'receiptUpdated';
      readonly uid: string;
      readonly receipt: 'read' | 'recv';
      readonly serverSeq: number;
    }
  | { readonly kind: 'unavailable'; readonly error: ConversationError }
  | { readonly kind: 'closed' }
);

export type ConversationReadListener = (event: ConversationReadEvent) => void;

export type ConversationCloseResult = { readonly identity: ConversationIdentity } & (
  | { readonly state: 'detached' }
  | { readonly state: 'blocked'; readonly error: ConversationError }
);

// Opening requires confirmed attachment, R permission, and a completed history read.
// Normalize a refusal or failure as an error instead of an empty result.
// Aborting ends the caller's interest without proving the stream has drained or undoing server operations.
export interface ConversationPort {
  readonly account: AccountScope;
  readonly topicKey: ConversationTopicKey;
  subscribe(listener: ConversationReadListener): () => void;
  open(signal?: AbortSignal, resume?: ConversationResumePosition): Promise<ConversationOpenResult>;
  // Load chat details on demand through the existing SDK connection and topic attachment.
  openInfoPort(panelGeneration: NavigationGeneration): Promise<ChatInfoPort>;
  loadPage(query: ConversationPageQuery, signal?: AbortSignal): Promise<ConversationPageResult>;
  // An explicit jump refreshes the server sequence and loads a bounded latest page.
  loadLatest(signal?: AbortSignal): Promise<ConversationPageResult>;
  loadReadPosition(signal?: AbortSignal): Promise<ConversationReadPositionResult>;
  // Returning from note does not acknowledge delivery. Mark only displayed rows as read.
  markRead(seq: number): void;
  markReceived(seq: number): void;
  // Resolves the first known outcome; late ACK/echo can update unknown via subscribe.
  // Reusing operationId never publishes again. Abort after pub means unknown.
  sendText(operationId: string, text: string, signal?: AbortSignal): Promise<ConversationOutgoingOperation>;
  sendEdit(operationId: string, input: ConversationEditDraft, signal?: AbortSignal): Promise<ConversationOutgoingOperation>;
  // Read-only preflight. The destructive operation must repeat it immediately before sending.
  verifyDeleteForAll(serverSeq: number, signal?: AbortSignal): Promise<boolean>;
  deleteMessage(serverSeq: number, scope: ConversationDeleteScope, signal: AbortSignal): Promise<ConversationDeleteResult>;
  checkMessageDeletion(serverSeq: number, signal: AbortSignal): Promise<ConversationDeleteResult>;
  sendPreparedMedia(operationId: string, handle: PreparedMedia, signal?: AbortSignal,
    onUploadProgress?: (fraction: number) => void): Promise<ConversationOutgoingOperation>;
  mediaLimits(): ServerLimits;
  acquireVoice(media: Extract<ConversationMediaReference, { state: 'available' }>, signal: AbortSignal): Promise<MediaLease>;
  acquirePhoto(media: Extract<ConversationMediaReference, { state: 'available' }>, signal: AbortSignal): Promise<MediaLease>;
  acquirePhotoPreview(preview: NonNullable<PhotoAttachment['preview']>, signal: AbortSignal): Promise<MediaLease>;
  // One bounded history step. A missing match never proves a rejected publication.
  reconcile(query: ConversationReconcileQuery, signal?: AbortSignal): Promise<ConversationReconcileResult>;
  // Confirm detach or report the topic as blocked while keeping the shared SDK open.
  close(): Promise<ConversationCloseResult>;
  // Idempotently release the interest. This does not confirm a successful detach.
  dispose(): void;
}

export type ConversationPageLoadState =
  | { readonly state: 'idle' }
  | { readonly state: 'pending' }
  | { readonly state: 'failed'; readonly error: ConversationError };

export interface ConversationReceipt {
  readonly uid: string;
  readonly readSeq: ChatSequence;
  readonly receivedSeq: ChatSequence;
}

export interface ConversationHistoryGap {
  readonly query: ConversationPageQuery;
  // Insert before this displayed original. Undefined means the end of the list.
  readonly beforeMessageSeq?: number;
}
export type ConversationForwardLoadState =
  | { readonly state: 'idle' }
  | { readonly state: 'pending'; readonly target: 'latest' | 'read' | number }
  | { readonly state: 'failed'; readonly target: 'latest' | 'read' | number; readonly error: ConversationError };

export interface ConversationOutgoing {
  readonly operation: ConversationOutgoingOperation;
  // Only local unresolved text. Confirmed content belongs to the real message.
  readonly text?: string;
  readonly submittedDraftIds?: readonly string[];
  readonly voice?: { readonly attachment: VoiceAttachment; readonly canRetry: boolean; readonly uploadProgress?: number };
  readonly photo?: { readonly filename: string; readonly uploadProgress?: number; readonly preview?: AvatarImageSource };
  readonly reconcileCursor?: ConversationReconcileCursor;
}
export interface ConversationEditDraft {
  readonly serverSeq: number;
  readonly versionSeq: number;
  readonly originalText: string;
  readonly text: string;
  readonly stale: boolean;
}

export interface ConversationComposerState {
  readonly edit?: ConversationEditDraft;
  readonly editOperation?: ConversationOutgoingOperation;
  readonly text: string;
  readonly revision: number;
  readonly pending: boolean;
  readonly uncertain: boolean;
  readonly canVerify: boolean;
  readonly verification?: ConversationVerification;
  readonly error?: ConversationError;
}

export interface ConversationSearchRange {
  // Offset and length in UTF-16 code units of the original normalized text.
  readonly start: number;
  readonly length: number;
}

export interface ConversationSearchMatch {
  readonly serverSeq: number;
  readonly ranges: readonly ConversationSearchRange[];
}

export type ConversationSearchState =
  | { readonly state: 'closed' }
  | { readonly state: 'no-query' | 'no-matches'; readonly query: string }
  | {
      readonly state: 'matches';
      readonly query: string;
      readonly matches: readonly ConversationSearchMatch[];
      readonly activeIndex: number;
    };

export interface ConversationReadySnapshot {
  readonly phase: 'ready';
  readonly identity: ConversationIdentity;
  readonly composer: ConversationComposerState;
  readonly search: ConversationSearchState;
  readonly outgoing: readonly ConversationOutgoing[];
  readonly header: ConversationHeader;
  readonly permissions: ConversationPermissions;
  readonly maxDeleteAgeSeconds?: number;
  readonly messages: readonly ConversationMessage[];
  readonly history: {
    readonly ranges: readonly ConversationHistoryRange[];
    readonly older: ConversationPageCursor;
    readonly newer: ConversationPageCursor;
  };
  readonly older: ConversationPageLoadState;
  readonly newer: ConversationForwardLoadState;
  readonly gaps: readonly ConversationHistoryGap[];
  readonly position: {
    readonly atLatest: boolean;
    readonly newMessageCount: number;
    // Update only after an explicit jump completes. Live messages and replacements leave it intact.
    readonly scrollRequest: { readonly id: number; readonly target: 'latest' | number };
  };
  readonly reading: ConversationReadingPosition;
  readonly receipts: readonly ConversationReceipt[];
  readonly target: ConversationOpeningTarget;
}

export type ConversationSnapshot =
  | { readonly phase: 'idle' | 'opening' | 'closed'; readonly identity: ConversationIdentity }
  | { readonly phase: 'error' | 'suspended'; readonly identity: ConversationIdentity; readonly error: ConversationError }
  | ConversationReadySnapshot;
