import { confirmedGroupRosterCount } from '../../chat-info/chat-info-normalize';
import type { GroupPublicPatch } from '../../chat-info/group-public-patch';
import type { TinodeTextContent } from 'tinode-sdk';
import type { ChatInfoIdentity, ChatInfoPort, ChatInfoSeed } from '../../chat-info/chat-info-types';
import { MediaFailure, inlineMediaByteLimit } from '../../media/MediaResources';
import type { MediaLease } from '../../media/MediaResources';
import type { TinodeMediaSource } from './TinodeMediaTransport';
import { preparedMediaFile } from '../../media/PreparedMedia';
import type { PreparedMedia } from '../../media/PreparedMedia';
import type { AccountScope, ChatPreviewPause, ChatSequence } from '../../chats/chat-list-types';
import { ChatListFailure } from '../../chats/chat-list-normalize';
import type {
  ConversationCloseResult, ConversationError, ConversationHeader, ConversationIdentity,
  ConversationDeletionState, ConversationDeletionRange, ConversationDeleteScope, ConversationDeleteResult, ConversationMediaReference, PhotoAttachment, VoiceAttachment, ConversationPermissions, ConversationOutgoingOperation, ConversationOutgoingState,
  ConversationMessage, ConversationEditDraft, ConversationResumePosition, ConversationReadPositionResult, ConversationOpeningTarget, ConversationOpenResult, ConversationPageCursor, ConversationPageQuery,
  ConversationPageResult, ConversationReconcileQuery, ConversationReconcileResult, ConversationPort, ConversationReadEvent, ConversationReadListener,
} from '../../conversation/conversation-types';
import {
  ConversationFailure, normalizeConversationIdentity, normalizeConversationMessage,
  normalizeConversationMetadata, normalizeConversationProfile, sortConversationMessages,
  normalizeConversationDeletion, mergeConversationDeletionRanges, conversationSeqDeleted,
  normalizeConversationPermissions, conversationAccessRemoved, normalizeConversationTimestamp, normalizeConversationPresence,
} from '../../conversation/conversation-normalize';
import type { NormalizedConversationProfile } from '../../conversation/conversation-normalize';
import type { TinodeTopicInterest } from './TinodeTopicInterests';
import { TinodeSessionFailure } from './TinodeSessionScope';
import type {
  TinodeConversationGetQuery, TinodeConversationPacket, TinodeConversationRequest,
  TinodeConversationSubscription, TinodeConversationMetadataQuery, TinodeConversationMetadataReader,
  TinodePublication, TinodeSessionObject, TinodeSessionScope, TinodeMetadataWriteResult,
} from './TinodeSessionScope';
import { TinodeAvatarLoader } from './tinode-avatar';
import { replacementMessageSeq } from '../../conversation/message-replacement';
import { canEditConversationMessage } from '../../conversation/conversation-edit';
import { conversationDeleteOptions } from '../../conversation/conversation-deletion';
import { prepareTinodeEdit } from './tinode-message-edit';
import type { TinodeEditPayload } from './tinode-message-edit';

const responseTimeoutMs = 30_000;
const pageSize = 32;
const deletionLogPageSize = 1024;
interface Deferred<T> { readonly promise: Promise<T>; readonly resolve: (value: T) => void; readonly reject: (reason: unknown) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'], reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function integer(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}
function sameAccount(a: AccountScope, b: AccountScope): boolean {
  return a.serverId === b.serverId && a.uid === b.uid && a.generation === b.generation;
}
function cancelled(): DOMException { return new DOMException('Conversation interest cancelled.', 'AbortError'); }
function error(code: ConversationError['messageCode'], kind: ConversationError['kind'], retryable: boolean,
  area: 'header' | 'history' = 'history', serverCode?: number): ConversationFailure {
  return new ConversationFailure({ area, kind, messageCode: code, retryable,
    ...(serverCode === undefined ? {} : { serverCode }) });
}
function failure(reason: unknown, area: 'header' | 'history' = 'history'): ConversationFailure {
  if (reason instanceof ConversationFailure) return reason;
  const code = reason instanceof TinodeSessionFailure ? reason.code : undefined;
  if (reason instanceof TinodeSessionFailure) {
    if (reason.reason === 'closed') return error('conversationSessionClosed', 'sessionClosed', false, area);
    if (reason.reason === 'limitsUnavailable') return error('conversationLimitsUnavailable', 'invalidResponse', true, area);
    if (reason.reason === 'invalidResponse' || reason.reason === 'tooLarge') {
      return error('conversationInvalidResponse', reason.reason === 'tooLarge' ? 'tooLarge' : 'invalidResponse', true, area);
    }
  }
  return code === 504 ? error(area === 'history' ? 'conversationHistoryTimeout' : 'conversationTimeout', 'timeout', true, area, code)
    : code === 401 || code === 403 ? error('conversationReadDenied', 'permission', false, area, code)
      : code === 404 || code === 410 ? error('conversationUnavailable', 'permission', false, area, code)
        : code === undefined || code === 503 ? error('conversationNetwork', 'network', true, area, code)
          : error('conversationHistoryUnavailable', 'network', code >= 500 || code === 429, area, code);
}
function invalid(): ConversationFailure { return error('conversationInvalidResponse', 'invalidResponse', true); }
function knownRefusal(reason: unknown): boolean {
  return reason instanceof TinodeSessionFailure && reason.code !== undefined &&
    reason.code >= 400 && reason.code < 500 && reason.code !== 408;
}
interface ConversationSession {
  owner?: TinodeConversationAdapter;
  readonly blocked: Set<string>;
}
const sessions = new WeakMap<TinodeSessionScope, ConversationSession>();
interface Command {
  readonly kind: 'attach' | 'leave';
  readonly clean: boolean;
  readonly result: Deferred<TinodeSessionObject>;
  readonly timer: ReturnType<typeof setTimeout>;
  settled: boolean;
}
interface DeleteIntent {
  readonly scope: ConversationDeleteScope;
  readonly seqs: readonly number[];
  readonly before: number;
  acknowledged?: number;
}

interface ReadRequest {
  readonly request: TinodeConversationRequest;
  readonly what: TinodeConversationGetQuery['what'];
  readonly done: Deferred<void>;
}
interface HistoryRequest {
  readonly query: ConversationPageQuery;
  readonly retainMessages: boolean;
  readonly upper: number;
  readonly received: Set<number>;
  readonly messages: Map<number, ConversationMessage>;
  readonly result: Deferred<ConversationPageResult>;
  readonly finished: Deferred<void>;
  readonly timer: ReturnType<typeof setTimeout>;
  detach: () => void;
  readId?: string;
  completionCount?: number;
  receivedCount: number;
  problem?: ConversationFailure;
  settled: boolean;
  ended: boolean;
  drained: boolean;
  blocked: boolean;
}
interface PreparedPublication {
  readonly edit?: TinodeEditPayload;
  readonly content: TinodeTextContent;
  readonly request: TinodePublication;
}
interface Publication {
  afterSeq: number;
  readonly kind: ConversationOutgoingOperation['kind'];
  readonly targetSeq?: number;
  readonly operationId: string;
  readonly result: Deferred<ConversationOutgoingOperation>;
  state: ConversationOutgoingOperation;
  content?: TinodeTextContent;
  edit?: TinodeEditPayload;
  request?: TinodePublication;
  timer?: ReturnType<typeof setTimeout>;
  detach: () => void;
  sent: boolean;
}
interface AvatarTask { readonly key: string; readonly publicProfile: unknown; readonly uid?: string; readonly version?: number }

export interface TinodeChatInfoSourceSnapshot {
  readonly subscriberLimit?: number;
  readonly identity: ChatInfoIdentity;
  readonly revision: number;
  readonly seed: ChatInfoSeed;
  // Most recent desc. It cannot confirm permissions after invalidation.
  readonly cachedDescription: TinodeSessionObject;
}
export interface TinodeChatInfoMetadataResult {
  readonly identity: ChatInfoIdentity;
  // Revision at the start of the read. The snapshot must not overwrite a later invalidation.
  readonly revision: number;
  readonly payload: TinodeSessionObject;
  readonly participantCountOverride?: number;
}
export type TinodeChatInfoSourceEvent = {
  readonly identity: ChatInfoIdentity;
  readonly revision: number;
} & (
  | { readonly kind: 'invalidated'; readonly area: 'details' | 'members' | 'ownAccess' }
  | { readonly kind: 'closed' }
);
export interface TinodeChatInfoSource {
  readonly identity: ChatInfoIdentity;
  readonly active: boolean;
  getSnapshot(): TinodeChatInfoSourceSnapshot;
  readMetadata(query: TinodeConversationMetadataQuery, signal?: AbortSignal): Promise<TinodeChatInfoMetadataResult>;
  readOwnChannelAccess(signal?: AbortSignal): Promise<unknown>;
  writeOwnPush(want: string, enabled: boolean, signal?: AbortSignal): Promise<TinodeMetadataWriteResult>;
  writeGroupPublic(patch: GroupPublicPatch, signal?: AbortSignal): Promise<TinodeMetadataWriteResult>;
  removeMember(uid: string, signal?: AbortSignal): Promise<TinodeMetadataWriteResult>;
  addMember(uid: string, signal?: AbortSignal): Promise<TinodeMetadataWriteResult>;
  reportGroupDescription?(description: TinodeSessionObject, rosterCount?: number): void;
  // Use the mode confirmed by the server. Without it, the chat list refreshes its own subscription.
  reportOwnPush(mode?: string): void;
  subscribe(listener: (event: TinodeChatInfoSourceEvent) => void): () => void;
  dispose(): void;
}
interface ChatInfoPortWork {
  readonly panelGeneration: number;
  readonly promise: Promise<ChatInfoPort>;
  source?: TinodeChatInfoSource;
}
interface ChatInfoSourceState {
  readonly identity: ChatInfoIdentity;
  readonly reader: TinodeConversationMetadataReader;
  readonly lifetime: AbortController;
  readonly listeners: Set<(event: TinodeChatInfoSourceEvent) => void>;
  pendingGroupProfile: boolean;
  revision: number;
}

// Port for reading, marking, and publishing in one topic. The existing owner retains the SDK and session.
export class TinodeConversationAdapter implements ConversationPort {
  readonly account: AccountScope;
  readonly topicKey: ConversationIdentity['topicKey'];
  readonly #identity: ConversationIdentity;
  readonly #scope: TinodeSessionScope;
  readonly #topicInterest: TinodeTopicInterest;
  readonly #handoff: ChatPreviewPause;
  readonly #session: ConversationSession;
  #phase: 'idle' | 'opening' | 'ready' | 'closing' | 'closed' = 'idle';
  #interest = new AbortController();
  #transport = new AbortController();
  #detachScope: () => void;
  #detachReadState: () => void;
  #confirmedRead = 0;
  #readKnown = false;
  #pendingRead = 0;
  #sentRecv = 0;
  #receivedMaximum = 0;
  #recvQueued = false;
  #presenceEpoch = 0;
  #memberPresence = new Map<string, boolean | undefined>();
  #membershipValid = false;
  #participantCountBeforeAttach?: number;
  #confirmedGroupRosterCount?: number;
  #firstAttachedParticipantCount?: number;
  #peerPresence: Extract<ConversationHeader, { kind: 'personal' }>['presence'] = { state: 'unknown' };
  #subscription: TinodeConversationSubscription | undefined;
  #avatars: TinodeAvatarLoader | undefined;
  #avatarQueue: AvatarTask[] = [];
  #avatarRunning = 0;
  #avatarOwners = new Set<string>();
  #avatarCandidates = new Map<string, unknown>();
  #profiles = new Map<string, NormalizedConversationProfile>();
  #messages = new Map<number, ConversationMessage>();
  readonly #editPackets = new WeakMap<ConversationMessage, TinodeSessionObject>();
  readonly #ackEdits = new WeakSet<ConversationMessage>();
  #header: ConversationHeader | undefined;
  #upper: number | undefined;
  #command: Command | undefined;
  #reads = new Map<string, ReadRequest>();
  #knownCommandIds = new Set<string>();
  #history: HistoryRequest | undefined;
  #pageWork: { readonly query: ConversationPageQuery; readonly retain: boolean; readonly promise: Promise<ConversationPageResult> } | undefined;
  #deletion: ConversationDeletionState = { transactionId: 0, ranges: [] };
  #deletionLogCursor = 0;
  #deleteIntents = new Map<number, DeleteIntent>();
  #deleteWork = false;
  #versionTargets = new Map<number, number>();
  #hydrateTargets = new Set<number>();
  #hydrating = false;
  #latestWork: Promise<ConversationPageResult> | undefined;
  #readPositionWork: Promise<ConversationReadPositionResult> | undefined;
  #reconcileWork: { readonly key: string; readonly promise: Promise<ConversationReconcileResult> } | undefined;
  #permissions: ConversationPermissions | undefined;
  #description: TinodeSessionObject = {};
  #metadataEpoch = 0;
  #refreshKeys = new Set<string>();
  #refreshRunning = false;
  #avatarVersions = new Map<string, number>();
  #attachment: 'none' | 'pending' | 'confirmed' | 'refused' | 'unknown' = 'none';
  #unsafe: ConversationFailure | undefined;
  #revision = 0;
  #listeners = new Set<ConversationReadListener>();
  readonly #voiceSources = new WeakMap<ConversationMediaReference, { readonly seq: number; readonly source: TinodeMediaSource }>();
  readonly #photoSources = new WeakMap<ConversationMediaReference, { readonly seq: number; readonly source: TinodeMediaSource }>();
  readonly #photoPreviews = new WeakMap<NonNullable<PhotoAttachment['preview']>,
    { readonly source: Extract<TinodeMediaSource, { kind: 'inline' }>; readonly fullPhoto: boolean }>();
  #publications = new Map<string, Publication>();
  #publicationRequests = new Map<string, Publication>();
  #openPromise: Promise<ConversationOpenResult> | undefined;
  #openFailureCleanup = false;
  #closePromise: Promise<ConversationCloseResult> | undefined;
  #infoSource: ChatInfoSourceState | undefined;
  #infoWrites = new Set<Promise<TinodeMetadataWriteResult>>();
  // A late control packet cannot count as a leave ACK when the timed-out set request's ID is unknown.
  #infoWriteMayReply = false;
  #infoGeneration = -1;
  #infoPortWork: ChatInfoPortWork | undefined;

  constructor(scope: TinodeSessionScope, topicKey: string, handoff: ChatPreviewPause) {
    this.#identity = normalizeConversationIdentity(scope.account, topicKey);
    this.account = this.#identity.account;
    this.topicKey = this.#identity.topicKey;
    if (!scope.active || !handoff.active || !sameAccount(this.account, handoff.account) ||
      !integer(handoff.navigationGeneration, 0)) throw error('conversationSessionClosed', 'sessionClosed', false);
    let session = sessions.get(scope);
    if (!session) {
      const created: ConversationSession = { blocked: new Set() };
      sessions.set(scope, created); session = created;
      scope.onClose(() => { created.owner = undefined; created.blocked.clear(); });
    }
    if (session.owner) throw error('conversationUnavailable', 'invalidResponse', true);
    if (session.blocked.has(topicKey)) throw error('conversationAttachUnconfirmed', 'timeout', false);
    this.#scope = scope; this.#handoff = handoff; this.#session = session;
    this.#topicInterest = scope.topicInterest(this.topicKey, 'conversation');
    session.owner = this;
    const knownRead = scope.confirmedRead(this.topicKey);
    if (knownRead !== undefined) { this.#confirmedRead = knownRead; this.#readKnown = true; }
    this.#detachScope = scope.onClose(() => { void this.close(); });
    this.#detachReadState = scope.subscribeReadState(value => {
      if (value.topic !== this.topicKey || this.#phase === 'closing' || this.#phase === 'closed') return;
      if (value.state === 'confirmed') this.#acceptRead(value.seq);
      else if (value.seq > Math.max(this.#pendingRead, this.#confirmedRead)) {
        this.#pendingRead = value.seq; this.#emit({ kind: 'readPending', serverSeq: value.seq });
      }
    });
  }

  subscribe(listener: ConversationReadListener): () => void {
    if (this.#phase === 'closed') return () => {};
    const wrapped = (event: ConversationReadEvent) => listener(event);
    this.#listeners.add(wrapped);
    return () => { this.#listeners.delete(wrapped); };
  }

  openInfoPort(panelGeneration: number): Promise<ChatInfoPort> {
    try {
      this.#assertInterest();
      if (!integer(panelGeneration, 0)) throw invalid();
      const previous = this.#infoPortWork;
      if (previous?.panelGeneration === panelGeneration && (!previous.source || previous.source.active)) return previous.promise;
      if (panelGeneration <= this.#infoGeneration || (previous && panelGeneration < previous.panelGeneration)) throw invalid();
      let work: ChatInfoPortWork;
      let avatars: TinodeAvatarLoader | undefined;
      // Import first so a failed load leaves the panel generation available for retry.
      const promise: Promise<ChatInfoPort> = import('./TinodeChatInfoAdapter').then(({ TinodeChatInfoAdapter }) => {
        this.#assertInterest();
        if (this.#infoPortWork !== work) throw cancelled();
        const source = this.openInfoSource(panelGeneration); work.source = source;
        if (this.#infoPortWork !== work || !source.active) throw cancelled();
        avatars = new TinodeAvatarLoader(this.#scope);
        return new TinodeChatInfoAdapter(source, avatars);
      }).catch((reason: unknown) => {
        work.source?.dispose(); avatars?.dispose();
        if (this.#infoPortWork === work) this.#infoPortWork = undefined;
        throw reason;
      });
      work = { panelGeneration, promise }; this.#infoPortWork = work;
      return promise;
    } catch (reason: unknown) { return Promise.reject(reason); }
  }

  openInfoSource(panelGeneration: number): TinodeChatInfoSource {
    this.#assertInterest();
    if (!integer(panelGeneration, 0) || panelGeneration <= this.#infoGeneration) throw invalid();
    if (this.#phase !== 'ready' || this.#attachment !== 'confirmed' || !this.#header ||
      !this.#subscription || this.#permissions?.canRead.state !== 'allowed') {
      throw error('conversationUnavailable', 'invalidResponse', true, 'header');
    }
    const reader = this.#subscription.metadataReader();
    const previous = this.#infoSource;
    const state: ChatInfoSourceState = {
      identity: Object.freeze({ ...this.#identity, panelGeneration }), reader,
      lifetime: new AbortController(), listeners: new Set(), pendingGroupProfile: false, revision: 0,
    };
    this.#infoGeneration = panelGeneration; this.#infoSource = state;
    if (previous) this.#releaseInfoSource(previous);
    // A closed handler can open another panel or close the conversation synchronously.
    this.#assertInfoSource(state);
    const owner = this;
    return Object.freeze({
      identity: state.identity,
      get active() { return !state.lifetime.signal.aborted && owner.#infoActive(state); },
      getSnapshot: () => this.#infoSnapshot(state),
      readMetadata: (query: TinodeConversationMetadataQuery, signal?: AbortSignal) => this.#readInfoMetadata(state, query, signal),
      readOwnChannelAccess: (signal?: AbortSignal) => this.#readInfoChannelAccess(state, signal),
      writeOwnPush: (want: string, enabled: boolean, signal?: AbortSignal) => this.#writeInfoPush(state, want, enabled, signal),
      writeGroupPublic: (patch: GroupPublicPatch, signal?: AbortSignal) =>
        this.#writeInfo(state, signal, () => state.reader.setGroupPublic(patch, this.#transport.signal), result => {
          if (result.state === 'rejected') return;
          state.pendingGroupProfile = true;
          if (!this.#infoActive(state)) this.#refreshGroupProfileAfterClose(state);
        }),
      removeMember: (uid: string, signal?: AbortSignal) =>
        this.#writeInfo(state, signal, () => state.reader.removeMember(uid, this.#transport.signal)),
      addMember: (uid: string, signal?: AbortSignal) =>
        this.#writeInfo(state, signal, () => state.reader.addMember(uid, this.#transport.signal)),
      reportGroupDescription: (description: TinodeSessionObject, rosterCount?: number) => {
        if (!this.#infoActive(state) || !this.topicKey.startsWith('grp')) return;
        state.pendingGroupProfile = false;
        this.#metadataEpoch++;
        if (integer(rosterCount, 0) && this.#header?.kind === 'group' && !this.#header.isChannel) {
          this.#confirmedGroupRosterCount = rosterCount;
        }
        this.#applyDescription(description, true);
        this.#scope.reportGroupProfile(this.topicKey);
      },
      reportOwnPush: (mode?: string) => this.#scope.reportOwnPush(this.topicKey, mode),
      subscribe: (listener: (event: TinodeChatInfoSourceEvent) => void) => {
        if (!this.#infoActive(state)) return () => {};
        const wrapped = (event: TinodeChatInfoSourceEvent) => listener(event);
        state.listeners.add(wrapped);
        return () => { state.listeners.delete(wrapped); };
      },
      dispose: () => this.#releaseInfoSource(state),
    });
  }

  #infoActive(state: ChatInfoSourceState): boolean {
    return this.#infoSource === state && !state.lifetime.signal.aborted &&
      this.#scope.active && this.#handoff.active && !this.#interest.signal.aborted &&
      !this.#unsafe && this.#session.owner === this && this.#phase === 'ready' &&
      this.#attachment === 'confirmed' && this.#permissions?.canRead.state === 'allowed';
  }
  #assertInfoSource(state: ChatInfoSourceState, signal?: AbortSignal): void {
    this.#assertInterest(signal);
    if (!this.#infoActive(state)) throw new TinodeSessionFailure('closed');
  }
  #infoSnapshot(state: ChatInfoSourceState): TinodeChatInfoSourceSnapshot {
    this.#assertInfoSource(state);
    const header = this.#header!;
    const seed: ChatInfoSeed = Object.freeze(header.kind === 'personal'
      ? { kind: 'personal', title: header.title, avatar: header.avatar, presence: header.presence }
      : { kind: 'group', title: header.title, avatar: header.avatar, participantCount: header.participantCount, ...(header.isChannel ? { isChannel: true as const } : {}) });
    return Object.freeze({ identity: state.identity, revision: state.revision, seed,
      cachedDescription: this.#description, subscriberLimit: this.#scope.subscriberLimit() });
  }
  async #waitForChannelPush(signal?: AbortSignal): Promise<void> {
    if (this.topicKey.startsWith('chn') && this.#infoWrites.size) {
      await this.#wait(Promise.allSettled([...this.#infoWrites]), signal);
    }
  }
  async #readInfoMetadata(state: ChatInfoSourceState, query: TinodeConversationMetadataQuery,
    signal?: AbortSignal): Promise<TinodeChatInfoMetadataResult> {
    await this.#waitForChannelPush(signal);
    this.#assertInfoSource(state, signal);
    const local = new AbortController();
    const cancel = () => local.abort();
    state.lifetime.signal.addEventListener('abort', cancel, { once: true });
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted || state.lifetime.signal.aborted) cancel();
    try {
      this.#assertInfoSource(state, local.signal);
      const revision = state.revision;
      // Closing the panel does not cancel the server read. The previous owner waits for it to drain.
      const request = state.reader.requestMeta(query, this.#transport.signal);
      this.#trackRead(request, query.what, true);
      const payload = await this.#wait(request.response, local.signal);
      this.#assertInfoSource(state, signal);
      // Keep the raw description for profile writes and apply the same count rule in the panel.
      const participantCountOverride = query.what === 'desc' && record(payload.desc)
        ? this.#participantCountOverride(payload.desc.subcnt, false) : undefined;
      return Object.freeze({ identity: state.identity, revision, payload,
        ...(participantCountOverride === undefined ? {} : { participantCountOverride }) });
    } finally {
      state.lifetime.signal.removeEventListener('abort', cancel);
      signal?.removeEventListener('abort', cancel);
    }
  }
  async #readInfoChannelAccess(state: ChatInfoSourceState, signal?: AbortSignal): Promise<unknown> {
    await this.#waitForChannelPush(signal);
    this.#assertInfoSource(state, signal);
    if (!this.topicKey.startsWith('chn')) throw invalid();
    const response = await this.#wait(this.#scope.getMeta('me', { what: 'sub', sub: { topic: this.topicKey } }), signal);
    this.#assertInfoSource(state, signal);
    const row = Array.isArray(response.sub) ? response.sub.find(value => record(value) && value.topic === this.topicKey) : undefined;
    return record(row) && !row.deleted ? row.acs : undefined;
  }
  async #writeInfoPush(state: ChatInfoSourceState, want: string, enabled: boolean,
    signal?: AbortSignal): Promise<TinodeMetadataWriteResult> {
    return this.#writeInfo(state, signal, async local => {
      if (this.topicKey.startsWith('chn')) {
        // Let existing metadata and history requests finish before leaving the channel.
        await this.#wait(Promise.allSettled([...this.#reads.values()].map(read => read.request.response)), local);
        this.#assertInfoSource(state, local);
      }
      return state.reader.setOwnPush(want, enabled, this.#transport.signal);
    }, result => {
      if (this.#scope.isTopicAttachmentBlocked(this.topicKey)) {
        this.#markUnsafe(error('conversationAttachUnconfirmed', 'timeout', false));
        this.#terminate(this.#unsafe!.conversationError);
      }
      if (result.state !== 'rejected' && !this.#infoActive(state)) this.#scope.reportOwnPush(this.topicKey);
    });
  }
  async #writeInfo(state: ChatInfoSourceState, signal: AbortSignal | undefined,
    write: (signal: AbortSignal) => Promise<TinodeMetadataWriteResult>,
    settled?: (result: TinodeMetadataWriteResult) => void): Promise<TinodeMetadataWriteResult> {
    this.#assertInfoSource(state, signal);
    const local = new AbortController();
    const cancel = () => local.abort();
    state.lifetime.signal.addEventListener('abort', cancel, { once: true });
    signal?.addEventListener('abort', cancel, { once: true });
    if (state.lifetime.signal.aborted || signal?.aborted) cancel();
    try {
      this.#assertInfoSource(state, local.signal);
      const request = write(local.signal).then(result => {
        if (result.state === 'acknowledged') this.#knownCommandIds.add(result.controlId);
        if (result.state === 'unknown') this.#infoWriteMayReply = true;
        settled?.(result);
        return result;
      });
      this.#infoWrites.add(request);
      void request.then(() => this.#infoWrites.delete(request), () => this.#infoWrites.delete(request));
      const result = await this.#wait(request, local.signal);
      this.#assertInfoSource(state, signal);
      return result;
    } finally {
      state.lifetime.signal.removeEventListener('abort', cancel);
      signal?.removeEventListener('abort', cancel);
    }
  }
  #infoChanged(area: 'details' | 'members' | 'ownAccess'): void {
    const state = this.#infoSource;
    if (!state || !this.#infoActive(state)) return;
    const event: TinodeChatInfoSourceEvent = Object.freeze({ identity: state.identity,
      revision: ++state.revision, kind: 'invalidated', area });
    for (const listener of [...state.listeners]) {
      if (!this.#infoActive(state)) break;
      try { listener(event); } catch { console.error('Chat info subscriber notification failed.'); }
    }
  }
  #refreshGroupProfileAfterClose(state: ChatInfoSourceState): void {
    if (!state.pendingGroupProfile) return;
    state.pendingGroupProfile = false;
    this.#metadataEpoch++;
    this.#schedule('desc');
    this.#scope.reportGroupProfile(this.topicKey);
  }
  #releaseInfoSource(state: ChatInfoSourceState): void {
    if (state.lifetime.signal.aborted) return;
    if (this.#infoSource === state) this.#infoSource = undefined;
    if (this.#infoPortWork?.source?.identity === state.identity) this.#infoPortWork = undefined;
    state.lifetime.abort(); state.reader.dispose();
    const event: TinodeChatInfoSourceEvent = Object.freeze({ identity: state.identity,
      revision: ++state.revision, kind: 'closed' });
    const listeners = [...state.listeners]; state.listeners.clear();
    for (const listener of listeners) {
      try { listener(event); } catch { console.error('Chat info subscriber notification failed.'); }
    }
    this.#refreshGroupProfileAfterClose(state);
  }
  #infoPacket(packet: TinodeConversationPacket): void {
    if (!this.#infoSource || !this.#infoActive(this.#infoSource)) return;
    const p = packet.payload;
    // A reply to an old read must not become an event for a later panel.
    if (typeof p.id === 'string' && this.#knownCommandIds.has(p.id)) return;
    if (packet.kind === 'meta') {
      if (p.topic === 'me') {
        if (p.id === undefined && Array.isArray(p.sub)) {
          this.#infoChanged('details'); this.#infoChanged('ownAccess');
        }
      } else {
        if (p.desc !== undefined) { this.#infoChanged('details'); this.#infoChanged('ownAccess'); }
        if (p.sub !== undefined) {
          if (this.#identity.kind === 'group') this.#infoChanged('members');
          this.#infoChanged('ownAccess');
        }
      }
    } else if (packet.kind === 'pres' && ['upd', 'acs', 'gone'].includes(String(p.what))) {
      this.#infoChanged('details'); this.#infoChanged('ownAccess');
      if (this.#identity.kind === 'group') this.#infoChanged('members');
    }
  }

  sendText(operationId: string, text: string, signal?: AbortSignal): Promise<ConversationOutgoingOperation> {
    return this.#startPublication(operationId, 'text', signal, (key, subscription) =>
      ({ request: subscription.prepareText(key, text), content: { txt: text } }));
  }

  sendEdit(operationId: string, input: ConversationEditDraft, signal?: AbortSignal): Promise<ConversationOutgoingOperation> {
    const validate = () => {
      const original = this.#messages.get(input.serverSeq), version = this.#messages.get(input.versionSeq);
      if (!original || original.originalSeq !== undefined || original.sender.state !== 'self' ||
        !version || (input.versionSeq !== input.serverSeq && version.originalSeq !== input.serverSeq) ||
        this.#deleted(original.serverSeq) || this.#deleted(version.serverSeq) || !canEditConversationMessage(version) ||
        version.content.text.text !== input.originalText || !input.text.trim() || input.text === input.originalText ||
        [...this.#messages.values()].some(row => row.originalSeq === input.serverSeq && row.sender.state === 'self' &&
          row.serverSeq > input.versionSeq && !this.#deleted(row.serverSeq))) {
        throw new ConversationFailure(this.#sendError('conversationEditStale', 'invalidResponse', false));
      }
      return version;
    };
    return this.#startPublication(operationId, 'edit', signal, (key, subscription) => {
      const version = validate(), packet = this.#editPackets.get(version);
      const limit = this.#scope.mediaLimits().maxMessageSize;
      if (limit.state !== 'known') throw new TinodeSessionFailure('limitsUnavailable');
      if (input.text.length > Math.min(limit.value, 1024 * 1024)) throw new TinodeSessionFailure('tooLarge');
      const edit = packet && prepareTinodeEdit(version, packet, input.text, this.account.serverId);
      if (!edit) throw new ConversationFailure(this.#sendError('conversationEditAttachment', 'invalidResponse', false));
      return { request: subscription.prepareEdit(key, input.serverSeq, edit), content: edit.content, edit };
    }, input.serverSeq, validate);
  }

  async verifyDeleteForAll(serverSeq: number, signal?: AbortSignal): Promise<boolean> {
    this.#assertInterest(signal);
    if (this.#phase !== 'ready' || this.#attachment !== 'confirmed' || this.topicKey.startsWith('chn')) return false;
    const initial = this.#messages.get(serverSeq);
    if (!initial || this.#deleted(serverSeq) || !this.#permissions ||
      !conversationDeleteOptions(initial, this.#identity, this.#permissions, this.#scope.messageDeleteAgeSeconds()).all) return false;
    const epoch = this.#metadataEpoch;
    const response = await this.#wait(this.#readMetadata({ what: 'desc', desc: {} }), signal);
    this.#assertInterest(signal);
    if (epoch !== this.#metadataEpoch || this.#phase !== 'ready') return false;
    const metadata = normalizeConversationMetadata(response, this.#identity, undefined, true);
    this.#applyDescription(response.desc, true);
    const target = this.#messages.get(serverSeq);
    return !signal?.aborted && !this.#interest.signal.aborted && epoch === this.#metadataEpoch && !!target && !this.#deleted(serverSeq) &&
      conversationDeleteOptions(target, this.#identity, metadata.permissions, this.#scope.messageDeleteAgeSeconds()).all;
  }

  deleteMessage(serverSeq: number, scope: ConversationDeleteScope, signal: AbortSignal): Promise<ConversationDeleteResult> {
    return this.#runDelete(serverSeq, scope, signal);
  }

  checkMessageDeletion(serverSeq: number, signal: AbortSignal): Promise<ConversationDeleteResult> {
    return this.#runDelete(serverSeq, undefined, signal);
  }

  async #runDelete(serverSeq: number, scope: ConversationDeleteScope | undefined, signal: AbortSignal): Promise<ConversationDeleteResult> {
    this.#assertInterest(signal);
    if (this.#deleteWork || this.#phase !== 'ready' || this.#attachment !== 'confirmed' || !this.#subscription ||
      !integer(serverSeq, 1)) return 'rejected';
    const subscription = this.#subscription;
    let intent = this.#deleteIntents.get(serverSeq);
    if (!intent && scope === undefined) return 'rejected';
    this.#deleteWork = true;
    const readLifetime = AbortSignal.any([signal, this.#interest.signal]);
    try {
      await this.#waitForChannelPush(signal);
      this.#assertInterest(signal);
      const historyWork = this.#latestWork ?? this.#readPositionWork ?? this.#reconcileWork?.promise ?? this.#pageWork?.promise;
      if (historyWork) await this.#wait(Promise.allSettled([historyWork]), signal);
      this.#assertInterest(signal);
      if (this.#phase !== 'ready' || this.#subscription !== subscription) return intent ? 'unknown' : 'rejected';
      if (!intent && scope !== undefined) {
        const epoch = this.#metadataEpoch;
        const fresh = await subscription.readDeletionMetadata({ what: 'desc', desc: {} }, readLifetime);
        this.#assertInterest(signal);
        if (epoch !== this.#metadataEpoch || !record(fresh.desc)) return 'rejected';
        const metadata = normalizeConversationMetadata(fresh, this.#identity, undefined, true);
        this.#applyDescription(fresh.desc, true);
        const original = this.#messages.get(serverSeq);
        if (!original || original.originalSeq !== undefined || this.#deleted(serverSeq)) return 'rejected';
        const options = conversationDeleteOptions(original, this.#identity, metadata.permissions, this.#scope.messageDeleteAgeSeconds());
        if (scope === 'all' ? !options.all : !options.self) return 'rejected';
        const seqs = [serverSeq, ...[...this.#messages.values()].filter(row =>
          row.originalSeq === serverSeq && !!original.sender.uid && row.sender.uid === original.sender.uid &&
          !this.#deleted(row.serverSeq)).map(row => row.serverSeq)].sort((a, b) => a - b);
        if (seqs.length > 1024) return 'rejected';
        const before = Math.max(this.#deletion.transactionId, this.#deletionLogCursor, integer(fresh.desc.del, 0) ? fresh.desc.del : 0);
        intent = { scope, seqs, before };
        this.#deleteIntents.set(serverSeq, intent);
        const result = await this.#wait(subscription.deleteMessages(seqs, scope === 'all'), signal);
        this.#assertInterest(signal);
        if (result.state === 'rejected') { this.#deleteIntents.delete(serverSeq); return 'rejected'; }
        if (result.state === 'acknowledged' && result.deletionId > before) intent.acknowledged = result.deletionId;
      }

      if (!intent) return 'rejected';
      const since = intent.acknowledged ?? this.#after(intent.before);
      if (since === undefined) return 'unknown';
      const journal = await subscription.readDeletionMetadata({ what: 'del', del: { since, limit: Math.max(32, intent.seqs.length) } }, readLifetime);
      this.#assertInterest(signal);
      const deletion = journal.del === undefined ? undefined : normalizeConversationDeletion(journal.del);
      if (this.#upper === undefined) return 'unknown';
      this.#upper = Math.max(this.#upper, this.#receivedMaximum);
      const before = this.#after(serverSeq);
      const page = await this.#readPage({ since: serverSeq, ...(before === undefined ? {} : { before }), limit: 1 }, signal, false);
      this.#assertInterest(signal);
      if (this.#phase !== 'ready' || page.range.coverage !== 'complete') return 'unknown';
      const present = page.range.receivedSeq.includes(serverSeq);
      const inLog = deletion && deletion.transactionId >= since && conversationSeqDeleted(serverSeq, deletion.ranges);
      if (!present && inLog) {
        this.#deleteIntents.delete(serverSeq);
        // The caller's deletion log contains both personal and global deletions.
        this.#applyDeletion({ clear: deletion.transactionId,
          delseq: intent.seqs.filter(seq => conversationSeqDeleted(seq, deletion.ranges)).map(low => ({ low })) });
        this.#handoff.refreshPreview(this.topicKey, 'delete');
        return intent.scope === 'all' ? 'allUnconfirmed' : 'selfConfirmed';
      }
      if (present && !inLog && intent.acknowledged !== undefined) {
        this.#deleteIntents.delete(serverSeq);
        return 'rejected';
      }
      return 'unknown';
    } catch {
      this.#assertInterest(signal);
      return intent ? 'unknown' : 'rejected';
    } finally {
      this.#deleteWork = false; this.#pumpHydrate();
    }
  }

  sendPreparedMedia(operationId: string, handle: PreparedMedia, signal?: AbortSignal,
    onUploadProgress?: (fraction: number) => void): Promise<ConversationOutgoingOperation> {
    const prepared = preparedMediaFile(handle);
    if (!prepared || !sameAccount(this.account, prepared.identity.account) ||
      prepared.identity.topicKey !== this.topicKey || prepared.identity.kind !== this.#identity.kind) {
      return Promise.reject(new ConversationFailure(this.#sendError('conversationInvalidResponse', 'invalidResponse', false)));
    }
    return this.#startPublication(operationId, prepared.file.kind, signal, async (key, subscription, lifetime) => {
      const { TinodeMediaTransport } = await import('./TinodeMediaTransport');
      this.#assertWritable(lifetime);
      const { content, references } = await TinodeMediaTransport.forScope(this.#scope).preparePublication(prepared.file, lifetime, onUploadProgress);
      this.#assertWritable(lifetime);
      return { request: subscription.prepareMedia(key, content, references), content };
    });
  }

  async acquirePhoto(media: Extract<ConversationMediaReference, { state: 'available' }>, signal: AbortSignal): Promise<MediaLease> {
    this.#assertInterest(signal);
    const registered = this.#photoSources.get(media);
    if (!registered || this.#deleted(registered.seq) || this.#permissions?.canRead.state !== 'allowed') {
      throw new MediaFailure('unavailable');
    }
    const { TinodeMediaTransport } = await import('./TinodeMediaTransport');
    this.#assertInterest(signal);
    const lease = await TinodeMediaTransport.forScope(this.#scope).acquirePhoto(media.resourceId, registered.source, signal);
    if (!this.#scope.active || signal.aborted || this.#deleted(registered.seq) || this.#phase !== 'ready') {
      lease.release({ discard: true });
      throw new MediaFailure('aborted');
    }
    return lease;
  }

  mediaLimits() { return this.#scope.mediaLimits(); }

  async acquireVoice(media: Extract<ConversationMediaReference, { state: 'available' }>, signal: AbortSignal): Promise<MediaLease> {
    this.#assertInterest(signal);
    const registered = this.#voiceSources.get(media);
    if (!registered || this.#deleted(registered.seq) || this.#permissions?.canRead.state !== 'allowed') {
      throw new MediaFailure('unavailable');
    }
    const { TinodeMediaTransport } = await import('./TinodeMediaTransport');
    this.#assertInterest(signal);
    const lease = await TinodeMediaTransport.forScope(this.#scope).acquire(media.resourceId, registered.source, signal);
    if (!this.#scope.active || signal.aborted || this.#deleted(registered.seq) || this.#phase !== 'ready') {
      lease.release({ discard: true });
      throw new MediaFailure('aborted');
    }
    return lease;
  }

  async acquirePhotoPreview(preview: NonNullable<PhotoAttachment['preview']>, signal: AbortSignal): Promise<MediaLease> {
    this.#assertInterest(signal);
    const registered = this.#photoPreviews.get(preview);
    if (!registered || this.#permissions?.canRead.state !== 'allowed') throw new MediaFailure('unavailable');
    const { TinodeMediaTransport } = await import('./TinodeMediaTransport');
    this.#assertInterest(signal);
    const transport = TinodeMediaTransport.forScope(this.#scope);
    return registered.fullPhoto ? transport.acquirePhoto(preview.resourceId, registered.source, signal)
      : transport.acquirePhotoPreview(preview.resourceId, registered.source, signal);
  }

  #registerVoice(seq: number, index: number, data: Readonly<Record<string, unknown>>, mime?: string): VoiceAttachment['media'] {
    const source: TinodeMediaSource | undefined = typeof data.ref === 'string' && data.ref.trim() && data.ref.length <= 8192
      ? { kind: 'reference', family: 'audio', reference: data.ref, mime }
      : typeof data.val === 'string' && data.val && data.val.length <= Math.ceil(inlineMediaByteLimit / 3) * 4 && mime
        ? { kind: 'inline', family: 'audio', base64: data.val, mime } : undefined;
    if (!source) return Object.freeze({ state: 'missing' });
    const media = Object.freeze({ state: 'available', resourceId: this.topicKey + ':voice:' + seq + ':' + index } as const);
    this.#voiceSources.set(media, { seq, source }); return media;
  }

  #registerPhoto(seq: number, index: number, data: Readonly<Record<string, unknown>>, mime?: string):
    Pick<PhotoAttachment, 'media' | 'preview'> {
    const id = this.topicKey + ':photo:' + seq + ':' + index;
    const inline = typeof data.val === 'string' ? data.val : '';
    // Drafty IM.val is an inline preview when ref exists, or inline image data on its own.
    const inlineMime = inline.startsWith('iVBORw0KGgo') ? 'image/png'
      : inline.startsWith('/9j/') ? 'image/jpeg' : mime;
    let media: ConversationMediaReference = Object.freeze({ state: 'missing' });
    const source: TinodeMediaSource | undefined = typeof data.ref === 'string' && data.ref.trim() && data.ref.length <= 8192
      ? { kind: 'reference', family: 'image', reference: data.ref, mime }
      : inline && inline.length <= Math.ceil(inlineMediaByteLimit / 3) * 4 && inlineMime
        ? { kind: 'inline', family: 'image', base64: inline, mime: inlineMime } : undefined;
    if (source) {
      media = Object.freeze({ state: 'available', resourceId: id });
      this.#photoSources.set(media, { seq, source });
    }
    const fullPhoto = source?.kind === 'inline';
    if (!inline || (!fullPhoto && inline.length > Math.ceil(32 * 1024 / 3) * 4) ||
      (inlineMime !== 'image/jpeg' && inlineMime !== 'image/png')) return { media };
    const preview = Object.freeze({ state: 'available', resourceId: id + ':preview' } as const);
    this.#photoPreviews.set(preview, { source: { kind: 'inline', family: 'image', base64: inline, mime: inlineMime }, fullPhoto });
    return { media, preview };
  }

  #assertWritable(signal?: AbortSignal): TinodeConversationSubscription {
    this.#assertInterest(signal);
    if (this.#phase !== 'ready' || this.#attachment !== 'confirmed' || !this.#subscription) {
      throw new ConversationFailure(this.#sendError('conversationUnavailable', 'permission', false));
    }
    if (this.#permissions?.canRead.state !== 'allowed' || this.#permissions?.canWrite.state !== 'allowed') {
      throw new ConversationFailure(this.#sendError('conversationWriteDenied', 'permission', false));
    }
    return this.#subscription;
  }

  #startPublication(operationId: string, kind: Publication['kind'], signal: AbortSignal | undefined,
    prepare: (key: string, subscription: TinodeConversationSubscription, signal: AbortSignal) =>
      PreparedPublication | Promise<PreparedPublication>, targetSeq?: number, validate?: () => void): Promise<ConversationOutgoingOperation> {
    try { this.#assertInterest(); }
    catch (reason: unknown) { return Promise.reject(reason); }
    if (typeof operationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId)) {
      return Promise.reject(new ConversationFailure(this.#sendError('conversationInvalidResponse', 'invalidResponse', false)));
    }
    const key = operationId.toLowerCase(), existing = this.#publications.get(key);
    if (existing) return existing.result.promise;
    const afterSeq = Math.max(this.#upper ?? 0, this.#receivedMaximum);
    const lifetime = new AbortController();
    const work: Publication = { afterSeq, operationId: key, result: deferred(), kind, targetSeq, sent: false, detach: () => {},
      state: Object.freeze({ identity: this.#identity, revision: ++this.#revision, operationId: key, ...(kind === 'edit' ? {} : { afterSeq }), kind, targetSeq, phase: 'preparing' }) };
    this.#publications.set(key, work);
    const abort = () => this.#finishPublication(work, work.sent
      ? { phase: 'unknown', messageCode: 'conversationSendUnknown' } : { phase: 'cancelled' });
    work.detach = () => {
      signal?.removeEventListener('abort', abort);
      lifetime.abort();
    };
    signal?.addEventListener('abort', abort, { once: true });
    this.#emit({ kind: 'outgoingUpdated', operation: work.state });
    if (signal?.aborted) abort();
    queueMicrotask(async () => {
      if (work.state.phase !== 'preparing') return;
      try {
        const preparation = prepare(key, this.#assertWritable(lifetime.signal), lifetime.signal);
        const { request, content, edit } = preparation instanceof Promise ? await preparation : preparation;
        if (work.state.phase !== 'preparing') {
          request.dispose();
          return;
        }
        work.afterSeq = Math.max(this.#upper ?? 0, this.#receivedMaximum);
        work.request = request;
        work.content = content; work.edit = edit;
        this.#publicationRequests.set(request.id, work);
        this.#knownCommandIds.add(request.id);
      } catch (reason: unknown) {
        if (reason instanceof MediaFailure && reason.reason === 'aborted') this.#finishPublication(work, { phase: 'cancelled' });
        else this.#finishPublication(work, { phase: 'rejected', error: this.#preparationError(reason, kind) });
        return;
      }
      // Register id and the own deadline before invoking the synchronous SDK send.
      work.timer = setTimeout(() => this.#finishPublication(work, { phase: 'unknown', messageCode: 'conversationSendUnknown' }), responseTimeoutMs);
      this.#finishPublication(work, { phase: 'publishing' });
      // A subscriber may close/abort reentrantly on the publishing event.
      const phase = work.state.phase as ConversationOutgoingOperation['phase'];
      if (phase !== 'publishing' || this.#phase !== 'ready' || !this.#scope.active) {
        if (phase === 'publishing') this.#finishPublication(work, { phase: 'cancelled' });
        return;
      }
      if (this.#permissions?.canWrite.state !== 'allowed' || this.#permissions.canRead.state !== 'allowed') {
        this.#finishPublication(work, { phase: 'rejected', error: this.#sendError('conversationWriteDenied', 'permission', false) }); return;
      }
      try { validate?.(); }
      catch (reason: unknown) { this.#finishPublication(work, { phase: 'rejected', error: this.#preparationError(reason, kind) }); return; }
      work.sent = true;
      try {
        void work.request!.publish().catch((reason: unknown) => {
          if (reason instanceof TinodeSessionFailure && reason.code === 504) return;
          if (work.state.phase === 'publishing') this.#finishPublication(work, { phase: 'unknown', messageCode: 'conversationSendUnknown' });
        });
      } catch (reason: unknown) {
        if (reason instanceof TinodeSessionFailure && reason.reason === 'closed') {
          work.sent = false; this.#finishPublication(work, { phase: 'cancelled' });
        } else if ((work.state.phase as ConversationOutgoingOperation['phase']) === 'publishing') {
          this.#finishPublication(work, { phase: 'unknown', messageCode: 'conversationSendUnknown' });
        }
      }
    });
    return work.result.promise;
  }
  #sendError(messageCode: ConversationError['messageCode'], kind: ConversationError['kind'], retryable: boolean, serverCode?: number): ConversationError {
    return Object.freeze({ area: 'send', kind, messageCode, retryable, ...(serverCode === undefined ? {} : { serverCode }) });
  }
  #preparationError(reason: unknown, kind: Publication['kind']): ConversationError {
    if (reason instanceof ConversationFailure) return Object.freeze({ ...reason.conversationError, area: 'send' });
    if (reason instanceof MediaFailure) {
      if (reason.reason === 'closed') return this.#sendError('conversationSessionClosed', 'sessionClosed', false);
      if (reason.reason === 'timeout') return this.#sendError(kind === 'voice' ? 'conversationVoiceSendFailed' : 'conversationMediaUploadTimeout', 'timeout', true);
      if (reason.reason === 'unsupported') return this.#sendError('conversationMediaUnsupported', 'invalidResponse', false);
      if (reason.reason === 'tooLarge' || reason.status === 413) return this.#sendError('conversationMediaTooLarge', 'tooLarge', false);
      if (reason.status === 401 || reason.status === 403) {
        return this.#sendError(kind === 'voice' ? 'conversationVoiceSendFailed' : 'conversationMediaUploadFailed', 'permission', false, reason.status);
      }
      const invalid = reason.reason === 'invalidResponse';
      return this.#sendError(kind === 'voice' ? 'conversationVoiceSendFailed' : 'conversationMediaUploadFailed', invalid ? 'invalidResponse' : 'network',
        !invalid && (reason.status === undefined || reason.status === 429 || reason.status >= 500), reason.status);
    }
    if (reason instanceof TinodeSessionFailure) {
      if (reason.reason === 'tooLarge') {
        return this.#sendError(kind === 'edit' ? 'conversationEditTooLarge' : kind === 'text' ? 'conversationTextTooLarge' : 'conversationMediaTooLarge', 'tooLarge', false);
      }
      if (reason.reason === 'limitsUnavailable') return this.#sendError('conversationLimitsUnavailable', 'invalidResponse', true);
      if (reason.reason === 'invalidResponse') return this.#sendError('conversationInvalidResponse', 'invalidResponse', false);
    }
    return this.#sendError('conversationSessionClosed', 'sessionClosed', false);
  }
  #finishPublication(work: Publication, value: ConversationOutgoingState): void {
    if (this.#publications.get(work.operationId) !== work || work.state.phase === 'confirmed' || work.state.phase === 'rejected' || work.state.phase === 'cancelled') return;
    if (work.state.phase === 'unknown' && value.phase !== 'confirmed' && value.phase !== 'rejected') return;
    work.state = Object.freeze({ identity: this.#identity, revision: ++this.#revision, operationId: work.operationId,
      kind: work.kind, targetSeq: work.targetSeq, afterSeq: work.afterSeq, ...(work.request ? { requestId: work.request.id } : {}), ...value });
    if (value.phase === 'confirmed') this.#handoff.refreshPreview(this.topicKey, 'message');
    this.#emit({ kind: 'outgoingUpdated', operation: work.state });
    if (value.phase === 'preparing' || value.phase === 'publishing') return;
    clearTimeout(work.timer); work.timer = undefined; work.detach(); work.detach = () => {};
    if (value.phase !== 'unknown') {
      work.content = undefined; work.edit = undefined; work.request?.dispose();
      if (work.request) this.#publicationRequests.delete(work.request.id);
      work.request = undefined;
    }
    work.result.resolve(work.state);
  }
  #publicationControl(p: TinodeSessionObject): void {
    const work = typeof p.id === 'string' ? this.#publicationRequests.get(p.id) : undefined;
    if (!work || !work.sent || (work.state.phase !== 'publishing' && work.state.phase !== 'unknown') ||
      (p.topic !== undefined && p.topic !== this.topicKey)) return;
    if (typeof p.code === 'number' && Number.isInteger(p.code) && p.code >= 400 && p.code <= 599) {
      if (work.kind === 'edit' && (p.code === 408 || p.code >= 500)) {
        this.#finishPublication(work, { phase: 'unknown', messageCode: 'conversationSendUnknown' }); return;
      }
      this.#finishPublication(work, { phase: 'rejected', error: this.#sendError(
        p.code === 401 || p.code === 403 ? 'conversationWriteDenied' : work.kind === 'edit'
          ? p.code === 413 ? 'conversationEditTooLarge' : 'conversationEditRejected' : 'conversationSendRejected',
        p.code === 401 || p.code === 403 ? 'permission' : 'network', p.code >= 500 || p.code === 429, p.code) });
      return;
    }
    const timestamp = normalizeConversationTimestamp(p.ts), params = record(p.params) ? p.params : undefined;
    if (p.topic !== this.topicKey || typeof p.code !== 'number' || !Number.isInteger(p.code) || p.code < 200 || p.code >= 300 ||
      !integer(params?.seq, 1) || timestamp.state !== 'known' ||
      (work.targetSeq !== undefined && (params.seq <= work.afterSeq || params.seq <= work.targetSeq))) return;
    // A valid ACK supplies real seq/time; the submitted Drafty supplies its body.
    const existing = this.#messages.get(params.seq);
    if (work.targetSeq !== undefined && existing && (existing.operationId !== work.operationId ||
      existing.originalSeq !== work.targetSeq || existing.sender.state !== 'self')) return;
    this.#remember({ topic: this.topicKey, from: this.account.uid, seq: params.seq, ts: timestamp.at,
      head: { mime: 'text/x-drafty', 'x-tinode-pwa-id': work.operationId, ...(work.targetSeq === undefined ? {} :
        { ...work.edit?.metadata, replace: ':' + work.targetSeq, attachments: work.edit?.references ?? [] }) },
      content: { ...work.content! } } as TinodeSessionObject, true, work.targetSeq !== undefined);
    this.#finishPublication(work, { phase: 'confirmed', serverSeq: params.seq, timestamp: timestamp.at });
  }
  #publicationEcho(message: ConversationMessage): void {
    if (message.sender.state !== 'self' || message.sender.uid !== this.account.uid || !message.operationId ||
      message.timestamp.state !== 'known') return;
    const work = this.#publications.get(message.operationId);
    if (work?.sent && message.originalSeq === work.targetSeq && message.serverSeq > work.afterSeq &&
      (work.state.phase === 'publishing' || work.state.phase === 'unknown')) {
      this.#finishPublication(work, { phase: 'confirmed', serverSeq: message.serverSeq, timestamp: message.timestamp.at });
    }
  }

  #findPublication(operationId: string, afterSeq: number, targetSeq?: number): ConversationMessage | undefined {
    for (const message of this.#messages.values()) if (message.serverSeq > afterSeq && !this.#deleted(message.serverSeq) &&
      message.sender.state === 'self' && message.sender.uid === this.account.uid && message.operationId === operationId &&
      message.originalSeq === targetSeq && message.timestamp.state === 'known') return message;
    return undefined;
  }
  reconcile(input: ConversationReconcileQuery, signal?: AbortSignal): Promise<ConversationReconcileResult> {
    let query: ConversationReconcileQuery;
    try {
      this.#assertInterest(signal);
      if (this.#phase !== 'ready' || this.#deleteWork || this.#latestWork || this.#readPositionWork || !record(input) ||
        typeof input.operationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.operationId) ||
        (input.afterSeq !== undefined && !integer(input.afterSeq, 0)) ||
        (input.targetSeq !== undefined && !integer(input.targetSeq, 1))) throw invalid();
      const cursor = input.cursor;
      if (cursor !== undefined && (!record(cursor) || !integer(cursor.before, 1) || !integer(cursor.upperSeq, 0) ||
        cursor.before > cursor.upperSeq || cursor.before <= (input.afterSeq ?? 0) + 1)) throw invalid();
      query = Object.freeze({ operationId: input.operationId.toLowerCase(), targetSeq: input.targetSeq,
        ...(input.afterSeq === undefined ? {} : { afterSeq: input.afterSeq }),
        ...(cursor === undefined ? {} : { cursor: Object.freeze({ before: cursor.before, upperSeq: cursor.upperSeq }) }) });
    } catch (reason: unknown) { return Promise.reject(reason); }
    const key = JSON.stringify(query);
    if (this.#reconcileWork) return this.#reconcileWork.key === key ? this.#reconcileWork.promise : Promise.reject(invalid());
    const pending = Promise.resolve().then(async (): Promise<ConversationReconcileResult> => {
      if (this.#pageWork) await this.#wait(this.#pageWork.promise, signal);
      this.#assertInterest(signal);
      const after = query.afterSeq ?? 0;
      const result = (pages: readonly ConversationPageResult[], cursor?: ConversationReconcileQuery['cursor']) => {
        this.#assertInterest(signal);
        const match = this.#findPublication(query.operationId, after, query.targetSeq);
        return Object.freeze({ identity: this.#identity, revision: ++this.#revision, operationId: query.operationId,
          pages: Object.freeze([...pages]), ...(match ? { match } : {}), ...(!match && cursor ? { cursor } : {}) });
      };
      // Cached data already came from this authenticated Scope; no text/time heuristics.
      if (this.#findPublication(query.operationId, after, query.targetSeq)) return result([]);
      const upper = await this.#refreshUpper(signal);
      if (after >= upper) return result([]);
      const cursor = query.cursor && query.cursor.upperSeq <= upper ? query.cursor : undefined;
      const before = cursor?.before ?? this.#after(upper), since = after + 1;
      const page = await this.#readPage({ since, ...(before === undefined ? {} : { before }), limit: pageSize }, signal);
      this.#assertInterest(signal);
      const min = page.range.receivedSeq[0];
      // Do not infer exhaustion from count<limit: server cap and deleted rows are independent.
      const next = min !== undefined && min > since ? Object.freeze({ before: min, upperSeq: cursor?.upperSeq ?? upper }) : undefined;
      return result([page], next);
    }).catch((reason: unknown) => {
      if (reason instanceof DOMException && reason.name === 'AbortError') throw reason;
      if (this.#unsafe && this.#scope.active) throw error('conversationAttachUnconfirmed', 'timeout', false);
      throw failure(reason);
    });
    const work = { key, promise: pending }; this.#reconcileWork = work;
    const release = () => { if (this.#reconcileWork === work) this.#reconcileWork = undefined; this.#pumpHydrate(); };
    void pending.then(release, release);
    return pending;
  }

  markRead(seq: number): void {
    this.#assertInterest();
    if (this.#phase !== 'ready' || this.#attachment !== 'confirmed' || this.#permissions?.canRead.state !== 'allowed' ||
      !integer(seq, 1) || !this.#messages.has(seq) || this.#deleted(seq)) throw invalid();
    if (seq <= Math.max(this.#confirmedRead, this.#pendingRead)) return;
    try { this.#subscription!.note('read', seq); }
    catch (reason: unknown) { throw failure(reason); }
    // Read implies received; neither value is a server ACK.
    this.#sentRecv = Math.max(this.#sentRecv, seq);
  }
  markReceived(seq: number): void {
    this.#assertInterest();
    if (this.#phase !== 'ready' || this.#attachment !== 'confirmed' || this.#permissions?.canRead.state !== 'allowed' ||
      !integer(seq, 1) || seq > this.#receivedMaximum) throw invalid();
    if (seq <= Math.max(this.#sentRecv, this.#confirmedRead, this.#pendingRead)) return;
    try { this.#subscription!.note('recv', seq); this.#sentRecv = seq; }
    catch (reason: unknown) { throw failure(reason); }
  }
  #acceptRead(seq: number): void {
    if (!integer(seq, 0) || (this.#readKnown && seq <= this.#confirmedRead)) return;
    this.#readKnown = true; this.#confirmedRead = Math.max(this.#confirmedRead, seq);
    if (this.#pendingRead <= seq) this.#pendingRead = 0;
    this.#emit({ kind: 'readUpdated', confirmedReadSeq: Object.freeze({ state: 'known', value: this.#confirmedRead }) });
  }
  #received(seq: number): void {
    this.#receivedMaximum = Math.max(this.#receivedMaximum, seq);
    if (this.#recvQueued) return;
    this.#recvQueued = true;
    queueMicrotask(() => {
      this.#recvQueued = false;
      if (this.#phase !== 'ready' || this.#receivedMaximum === 0) return;
      try { this.markReceived(this.#receivedMaximum); } catch { /* A later message or view can retry the note. Do not confirm it locally. */ }
    });
  }

  open(signal?: AbortSignal, resume?: ConversationResumePosition): Promise<ConversationOpenResult> {
    if (this.#phase === 'closing' || this.#phase === 'closed') return Promise.reject(error('conversationSessionClosed', 'sessionClosed', false));
    if (this.#openPromise) {
      try { this.#assertInterest(signal); return this.#openPromise; }
      catch (reason: unknown) { return Promise.reject(reason); }
    }
    if (this.#phase !== 'idle') return Promise.reject(error('conversationSessionClosed', 'sessionClosed', false));
    this.#phase = 'opening';
    const pending = this.#open(signal, resume).catch((reason: unknown) => {
      // Report an open failure through its promise. Cleaning up this attempt does not mean the session dropped.
      this.#openFailureCleanup = true;
      void this.close();
      if (reason instanceof DOMException && reason.name === 'AbortError') throw reason;
      throw failure(reason);
    });
    this.#openPromise = pending;
    return pending;
  }

  async #open(signal?: AbortSignal, resume?: ConversationResumePosition): Promise<ConversationOpenResult> {
    try {
      await this.#wait(this.#handoff.waitTopicIdle(this.topicKey, signal), signal);
    } catch (reason: unknown) {
      // Retrying in the same scope cannot recover a preview stream whose outcome is unknown.
      if (reason instanceof ChatListFailure) {
        const source = reason.chatListError;
        if (source.kind === 'sessionClosed') throw error('conversationSessionClosed', 'sessionClosed', false);
        if (source.kind === 'unavailable' && !source.retryable) {
          throw error('conversationAttachUnconfirmed', 'timeout', false);
        }
      }
      throw reason;
    }
    this.#assertInterest(signal);
    this.#subscription = this.#scope.subscribeConversation(this.topicKey, this.#onPacket, (reason) => {
      this.#markUnsafe(failure(reason));
      if (this.#history) this.#failHistory(this.#history, failure(reason), true);
      this.#terminate(this.#unsafe!.conversationError);
    });
    this.#avatars = new TinodeAvatarLoader(this.#scope);
    const physicalAttach = await this.#wait(this.#topicInterest.acquire(signal), signal);
    this.#assertInterest(signal);
    if (physicalAttach) {
      this.#participantCountBeforeAttach = await this.#scope.readGroupCountBeforeAttach(
        this.topicKey, signal ? AbortSignal.any([signal, this.#interest.signal]) : this.#interest.signal,
      ).catch(() => undefined);
      this.#assertInterest(signal);
      this.#attachment = 'pending';
      await this.#wait(this.#startCommand('attach', true), signal);
    } else this.#attachment = 'confirmed';
    this.#assertInterest(signal);
    let metadata: ReturnType<typeof normalizeConversationMetadata> | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      const epoch = this.#metadataEpoch;
      const response = await this.#wait(this.#readMetadata({ what: 'desc', desc: {} }), signal);
      this.#assertInterest(signal);
      if (epoch !== this.#metadataEpoch) continue;
      metadata = normalizeConversationMetadata(response, this.#identity, this.#avatars.state(record(response.desc) ? response.desc.public : undefined), true);
      if (metadata.permissions.canRead.state === 'denied') throw error('conversationReadDenied', 'permission', false);
      if (metadata.permissions.canRead.state !== 'allowed' || metadata.serverSeq.state !== 'known') throw invalid();
      this.#applyDescription(response.desc, true); break;
    }
    if (!metadata || !this.#header) throw error('conversationHistoryInterrupted', 'network', true);
    this.#upper = metadata.serverSeq.state === 'known' ? metadata.serverSeq.value : undefined;
    if (this.#upper === undefined) throw invalid();
    const desc = this.#description;
    // Tinode can omit desc.del even when the account's deletion journal is populated.
    const deletionLog = this.#upper > 0
      ? this.#restoreDeletionLog(integer(desc.del, 1) ? desc.del : undefined, signal) : undefined;
    if (this.#identity.kind === 'personal') {
      this.#installProfile(this.topicKey, desc);
      // me.sub contains only our own read position. The peer's subscription is optional.
      void this.#subscription.readPeerReceipt(this.#interest.signal).then(response => {
        this.#assertInterest(signal);
        const rows = response.sub;
        const peer = Array.isArray(rows) ? rows.find(row => record(row) && row.user === this.topicKey) : undefined;
        if (record(peer)) this.#applySubscriptionReceipt(peer);
      }).catch(() => {});
      const epoch = this.#presenceEpoch;
      try {
        const response = await this.#wait(this.#scope.getMeta('me', { what: 'sub', sub: { topic: this.topicKey, limit: 1 } }), signal);
        if (epoch === this.#presenceEpoch && Array.isArray(response.sub)) {
          const row = response.sub.find(row => record(row) && row.topic === this.topicKey);
          if (record(row) && !row.deleted) this.#setPeerPresence(row);
        }
      } catch (reason: unknown) {
        if (reason instanceof DOMException && reason.name === 'AbortError') throw reason;
        if (!this.#scope.active) throw reason;
      }
    } else if (this.topicKey.startsWith('chn')) {
      // Channel descriptions may omit the persisted reader position.
      try {
        await this.#wait(this.#scope.getMeta('me', { what: 'sub', sub: { topic: this.topicKey } }), signal);
      } catch (reason: unknown) {
        if (reason instanceof DOMException && reason.name === 'AbortError' || !this.#scope.active) throw reason;
      }
    } else {
      try {
        const epoch = this.#metadataEpoch, presenceEpoch = this.#presenceEpoch;
        const participants = await this.#wait(this.#readMetadata({ what: 'sub', sub: { limit: 32 } }), signal);
        // Do not let a late initial roster snapshot roll back a newer profile.
        if (epoch === this.#metadataEpoch && Array.isArray(participants.sub)) {
          this.#applyProfiles(participants.sub);
          if (presenceEpoch === this.#presenceEpoch) this.#applyMembership(participants.sub); else this.#schedule('members');
        }
      } catch (reason: unknown) {
        if (reason instanceof DOMException && reason.name === 'AbortError') throw reason;
        // A confirmed failure of the optional sub request does not fail the data read.
        if (!(reason instanceof TinodeSessionFailure && reason.origin === 'server')) throw reason;
      }
    }
    await deletionLog;
    this.#assertInterest(signal);
    const openingRead: ChatSequence = this.#readKnown && (metadata.readSeq.state === 'known'
      ? this.#confirmedRead > metadata.readSeq.value : this.#description.read === undefined)
      ? { state: 'known', value: this.#confirmedRead } : metadata.readSeq;
    const opening = resume?.kind === 'anchor' ? await this.#resumeHistory(resume.serverSeq, openingRead, signal)
      : await this.#openingHistory(resume?.kind === 'latest' ? { state: 'known', value: this.#upper } : openingRead, signal);
    this.#assertInterest(signal);
    const refresh = (page: ConversationPageResult) => Object.freeze({ ...page,
      messages: Object.freeze(page.messages.map(message => this.#messages.get(message.serverSeq) ?? message)) });
    const history = refresh(opening.history), contextPages = Object.freeze(opening.contextPages.map(refresh));
    const received = [history, ...contextPages].flatMap(page => [page, ...(page.relatedPages ?? [])]).flatMap(page => page.range.receivedSeq);
    const highest = received.reduce((max, seq) => Math.max(max, seq), 0);
    this.#phase = 'ready'; this.#pumpRefresh(); this.#pumpHydrate();
    if (this.#receivedMaximum) this.#received(this.#receivedMaximum);
    return Object.freeze({ identity: this.#identity, revision: ++this.#revision, header: this.#header,
      maxDeleteAgeSeconds: this.#scope.messageDeleteAgeSeconds(),
      permissions: this.#permissions ?? metadata.permissions, history,
      ...(contextPages.length ? { contextPages } : {}),
      reading: Object.freeze({ confirmedReadSeq: openingRead,
        highestReceivedSeq: highest ? Object.freeze({ state: 'known', value: highest } as const) : Object.freeze({ state: 'unknown' } as const),
        ...(opening.target.kind === 'message' && opening.target.reason === 'firstUnread' ? { firstUnreadTarget: opening.target.serverSeq } : {}) }),
      target: opening.target });
  }

  async #restoreDeletionLog(through: number | undefined, signal?: AbortSignal): Promise<void> {
    const lifetime = new AbortController();
    const timer = setTimeout(() => lifetime.abort(), responseTimeoutMs);
    let since = 1;
    try {
      while (!lifetime.signal.aborted) {
        this.#assertInterest(signal);
        const response = await this.#wait(this.#subscription!.readDeletionMetadata(
          { what: 'del', del: { since, limit: deletionLogPageSize } }, lifetime.signal), signal);
        this.#assertInterest(signal);
        if (response.del === undefined) return;
        const deletion = normalizeConversationDeletion(response.del);
        if (deletion.transactionId < since) return;
        this.#applyDeletion(response.del);
        if (through !== undefined && since >= through) {
          this.#deletionLogCursor = Math.max(this.#deletionLogCursor, since);
          return;
        }
        // clear identifies a transaction. The page can end in the middle of its ranges.
        if (deletion.transactionId > since) {
          this.#deletionLogCursor = Math.max(this.#deletionLogCursor, deletion.transactionId - 1);
          since = deletion.transactionId;
        } else {
          this.#deletionLogCursor = Math.max(this.#deletionLogCursor, since);
          since++;
        }
      }
    } catch {
      // A missing journal leaves its ranges unverified. History can still be opened.
    } finally {
      clearTimeout(timer);
      lifetime.abort();
    }
  }

  #after(seq: number): number | undefined { return seq < Number.MAX_SAFE_INTEGER ? seq + 1 : undefined; }
  async #existence(since: number, before: number | undefined, signal?: AbortSignal): Promise<number | undefined> {
    // A deleted message still counts toward the response total but cannot be selected as a target.
    let end = before;
    for (let attempt = 0; attempt <= this.#deletion.ranges.length + 4; attempt++) {
      const page = await this.#readPage({ since, ...(end === undefined ? {} : { before: end }), limit: 1 }, signal, false);
      const seq = page.range.receivedSeq[0];
      if (seq === undefined) return;
      if (!this.#deleted(seq)) return seq;
      const range = this.#deletion.ranges.find(range => range.low <= seq && (range.hi === undefined ? range.low === seq : seq < range.hi));
      const next = range?.low ?? seq;
      if (next <= since) return;
      end = next;
    }
    throw error('conversationHistoryInterrupted', 'network', true);
  }
  async #loadPreviousContext(history: ConversationPageResult, contextPages: ConversationPageResult[],
    before: number, signal?: AbortSignal): Promise<void> {
    const received = new Set([history, ...contextPages].flatMap(page =>
      page.messages.filter(message => !this.#deleted(message.serverSeq)).map(message => message.serverSeq)));
    while (received.size < pageSize && before > 1 && contextPages.length < pageSize - 1) {
      const page = await this.#readPage({ before, limit: pageSize - received.size }, signal);
      contextPages.push(page);
      for (const message of page.messages) if (!this.#deleted(message.serverSeq)) received.add(message.serverSeq);
      const min = page.range.receivedSeq[0];
      if (min === undefined) break;
      if (min >= before) throw invalid();
      before = min;
    }
  }

  async #openingHistory(read: ChatSequence, signal?: AbortSignal, clearWindow = true): Promise<{
    readonly history: ConversationPageResult;
    readonly contextPages: readonly ConversationPageResult[];
    readonly target: ConversationOpeningTarget;
  }> {
    const upper = this.#upper!;
    const latest = async () => {
      const before = this.#after(upper);
      const history = await this.#readPage({ limit: pageSize, ...(before === undefined ? {} : { before }) }, signal);
      const last = history.messages.at(-1);
      return { history, contextPages: Object.freeze([]), target: Object.freeze(last
        ? { kind: 'message', serverSeq: last.serverSeq, reason: 'latest' } as const : { kind: 'empty' } as const) };
    };
    if (upper === 0) return latest();
    if (read.state !== 'known') throw invalid();
    if (read.value >= upper) return latest();
    let lower = read.value + 1;
    // If the selected message was deleted, search only after its sequence. Repeated server changes
    // produce an explicit error instead of an infinite loop or a false empty result.
    for (let attempt = 0; attempt < 4; attempt++) {
      const newest = await this.#existence(lower, this.#after(upper), signal);
      if (newest === undefined) return latest();
      let lo = lower, hi = newest;
      while (lo < hi) {
        const mid = lo + Math.floor((hi - lo) / 2);
        const found = await this.#existence(lo, mid + 1, signal);
        if (found === undefined) lo = mid + 1;
        else hi = found;
      }
      if (clearWindow) this.#clearWindow();
      const beforeTarget = this.#after(lo);
      const history = await this.#readPage({ since: lo, ...(beforeTarget === undefined ? {} : { before: beforeTarget }), limit: pageSize }, signal);
      if (history.messages.length) {
        const contextPages: ConversationPageResult[] = [];
        // Read at most 31 adjacent sequences. If the server caps pages at a lower size,
        // fill only that bounded range using backward pages.
        if (lo < upper) {
          const since = lo + 1, high = lo + Math.min(pageSize - 1, upper - lo);
          let before = this.#after(high);
          for (let pageIndex = 0; pageIndex < pageSize - 1; pageIndex++) {
            const page = await this.#readPage({ since, ...(before === undefined ? {} : { before }), limit: pageSize }, signal);
            contextPages.push(page);
            const min = page.range.receivedSeq[0];
            if (min === undefined || min === since) break;
            before = min;
          }
        }
        await this.#loadPreviousContext(history, contextPages, lo, signal);
        // A deletion may occur between the binary search and the neighboring reads.
        if (await this.#existence(lo, beforeTarget, signal) !== undefined) {
          return { history, contextPages: Object.freeze(contextPages),
            target: Object.freeze({ kind: 'message', serverSeq: lo, reason: 'firstUnread' }) };
        }
      }
      if (clearWindow) this.#clearWindow();
      if (lo === upper) return latest();
      lower = lo + 1;
    }
    throw error('conversationHistoryInterrupted', 'network', true);
  }

  async #resumeHistory(anchor: number, read: ChatSequence, signal?: AbortSignal): Promise<{
    readonly history: ConversationPageResult; readonly contextPages: readonly ConversationPageResult[]; readonly target: ConversationOpeningTarget;
  }> {
    if (!integer(anchor, 1)) throw invalid();
    const upper = this.#upper!;
    for (let attempt = 0; attempt < 4 && upper > 0; attempt++) {
      const seq = await this.#existence(1, this.#after(Math.min(anchor, upper)), signal);
      if (seq === undefined) break;
      this.#clearWindow();
      const history = await this.#readPage({ since: seq, before: this.#after(seq), limit: pageSize }, signal);
      if (!history.messages.some(message => message.serverSeq === seq)) continue;
      const contextPages: ConversationPageResult[] = [];
      if (seq < upper) {
        const since = seq + 1, high = seq + Math.min(pageSize - 1, upper - seq);
        let before = this.#after(high);
        for (let pageIndex = 0; pageIndex < pageSize - 1; pageIndex++) {
          const page = await this.#readPage({ since, ...(before === undefined ? {} : { before }), limit: pageSize }, signal);
          contextPages.push(page);
          const min = page.range.receivedSeq[0];
          if (min === undefined || min === since) break;
          before = min;
        }
      }
      await this.#loadPreviousContext(history, contextPages, seq, signal);
      if (await this.#existence(seq, this.#after(seq), signal) !== undefined) return {
        history, contextPages: Object.freeze(contextPages), target: Object.freeze({ kind: 'message', serverSeq: seq, reason: 'resume' }),
      };
    }
    this.#clearWindow();
    return this.#openingHistory(read, signal);
  }

  loadPage(query: ConversationPageQuery, signal?: AbortSignal): Promise<ConversationPageResult> {
    const previousUpper = this.#upper;
    try {
      this.#assertInterest(signal);
      if (this.#phase !== 'ready' || this.#deleteWork || this.#latestWork || this.#readPositionWork || this.#reconcileWork) throw error('conversationHistoryUnavailable', 'invalidResponse', true);
      const upper = this.#upper!;
      if ((query.since !== undefined && query.since > upper) || (query.before !== undefined && query.before - 1 > upper)) {
        this.#upper = Math.max(upper, this.#receivedMaximum);
      }
      const pending = this.#readPage(query, signal);
      if (this.#upper !== previousUpper) void pending.catch(() => { this.#upper = previousUpper; });
      return pending;
    } catch (reason: unknown) { this.#upper = previousUpper; return Promise.reject(reason); }
  }

  loadLatest(signal?: AbortSignal): Promise<ConversationPageResult> {
    if (this.#latestWork) return this.#latestWork;
    if (this.#deleteWork || this.#readPositionWork || this.#reconcileWork) return Promise.reject(invalid());
    const previousUpper = this.#upper;
    const pending = Promise.resolve().then(async () => {
      this.#assertInterest(signal);
      if (this.#phase !== 'ready') throw invalid();
      // Use one collector at a time. Finish the previous page or hydration first.
      if (this.#pageWork) await this.#wait(this.#pageWork.promise, signal);
      this.#assertInterest(signal);
      const upper = await this.#refreshUpper(signal);
      const before = this.#after(upper);
      return this.#readPage({ limit: pageSize, ...(before === undefined ? {} : { before }) }, signal);
    }).catch((reason: unknown) => { this.#upper = previousUpper; throw failure(reason); });
    this.#latestWork = pending;
    const release = () => { if (this.#latestWork === pending) this.#latestWork = undefined; this.#pumpHydrate(); };
    void pending.then(release, release);
    return pending;
  }

  async #refreshUpper(signal?: AbortSignal): Promise<number> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const epoch = this.#metadataEpoch;
      const response = await this.#wait(this.#readMetadata({ what: 'desc', desc: {} }), signal);
      this.#assertInterest(signal);
      if (epoch !== this.#metadataEpoch) continue;
      const metadata = normalizeConversationMetadata(response, this.#identity, undefined, true);
      if (metadata.serverSeq.state !== 'known' || metadata.serverSeq.value < this.#upper!) throw invalid();
      this.#upper = Math.max(metadata.serverSeq.value, this.#receivedMaximum);
      this.#applyDescription(response.desc, true);
      return this.#upper;
    }
    throw error('conversationHistoryInterrupted', 'network', true);
  }

  loadReadPosition(signal?: AbortSignal): Promise<ConversationReadPositionResult> {
    if (this.#readPositionWork) return this.#readPositionWork;
    if (this.#deleteWork || this.#latestWork || this.#reconcileWork) return Promise.reject(invalid());
    const previousUpper = this.#upper;
    // Freeze the receipt boundary at the explicit action, including a sent pending note.
    const read = this.#readKnown || this.#pendingRead > 0 ? Math.max(this.#confirmedRead, this.#pendingRead) : undefined;
    const pending = Promise.resolve().then(async (): Promise<ConversationReadPositionResult> => {
      this.#assertInterest(signal);
      if (this.#phase !== 'ready' || read === undefined) throw invalid();
      if (this.#pageWork) await this.#wait(this.#pageWork.promise, signal);
      this.#assertInterest(signal);
      await this.#refreshUpper(signal);
      let before = this.#after(Math.min(read, this.#upper!));
      if (read > 0) for (let attempt = 0; attempt < 4; attempt++) {
        const seq = await this.#existence(1, before, signal);
        if (seq === undefined) break;
        const targetBefore = this.#after(seq);
        const history = await this.#readPage({ since: seq, ...(targetBefore === undefined ? {} : { before: targetBefore }), limit: pageSize }, signal);
        const candidate = history.messages.find(message => message.serverSeq === seq);
        const original = candidate?.originalSeq === undefined ? candidate : this.#messages.get(candidate.originalSeq);
        const displayable = candidate && (candidate.originalSeq === undefined ||
          (original?.sender.uid !== undefined && original.sender.uid === candidate.sender.uid));
        if (displayable) {
          const contextPages: ConversationPageResult[] = [];
          const high = seq + Math.min(pageSize - 1, this.#upper! - seq);
          let end = this.#after(high);
          if (seq < high) for (let page = 0; page < pageSize - 1; page++) {
            const part = await this.#readPage({ since: seq + 1, ...(end === undefined ? {} : { before: end }), limit: pageSize }, signal);
            contextPages.push(part);
            const min = part.range.receivedSeq[0];
            if (min === undefined || min === seq + 1) break;
            end = min;
          }
          if (!this.#deleted(seq)) return Object.freeze({ identity: this.#identity, revision: ++this.#revision,
            history, ...(contextPages.length ? { contextPages: Object.freeze(contextPages) } : {}),
            target: Object.freeze({ kind: 'message', serverSeq: seq, reason: 'lastRead' }) });
        }
        before = seq;
        if (attempt === 3) throw error('conversationHistoryInterrupted', 'network', true);
      }
      const opening = await this.#openingHistory({ state: 'known', value: 0 }, signal, false);
      return Object.freeze({ identity: this.#identity, revision: ++this.#revision, ...opening });
    }).catch((reason: unknown) => { this.#upper = previousUpper; throw failure(reason); });
    this.#readPositionWork = pending;
    const release = () => { if (this.#readPositionWork === pending) this.#readPositionWork = undefined; this.#pumpHydrate(); };
    void pending.then(release, release);
    return pending;
  }

  #pageQuery(query: ConversationPageQuery): ConversationPageQuery {
    if (!record(query) || !integer(query.limit, 1) ||
      (query.since !== undefined && !integer(query.since, 1)) ||
      (query.before !== undefined && !integer(query.before, 1)) ||
      (query.since !== undefined && query.before !== undefined && query.since >= query.before)) throw invalid();
    const upper = this.#upper!;
    if (query.since !== undefined && query.since > upper) throw invalid();
    const before = upper < Number.MAX_SAFE_INTEGER ? Math.min(query.before ?? upper + 1, upper + 1) : query.before;
    return Object.freeze({ limit: Math.min(pageSize, query.limit),
      ...(query.since === undefined ? {} : { since: query.since }), ...(before === undefined ? {} : { before }) });
  }

  #readPage(input: ConversationPageQuery, signal?: AbortSignal, retainMessages = true): Promise<ConversationPageResult> {
    this.#assertInterest(signal);
    const query = this.#pageQuery(input), current = this.#pageWork;
    if (current) {
      if (current.retain === retainMessages && current.query.since === query.since && current.query.before === query.before && current.query.limit === query.limit) return current.promise;
      if (this.#hydrating) return current.promise.then(() => this.#readPage(query, signal, retainMessages));
      return Promise.reject(error('conversationHistoryUnavailable', 'invalidResponse', true));
    }
    const promise = Promise.resolve().then(async () => {
      await this.#waitForChannelPush(signal);
      const page = await this.#rawPage(query, signal, retainMessages);
      if (!retainMessages) return page;
      const relatedPages: ConversationPageResult[] = [];
      const targets = [...new Set(page.messages.flatMap(message => message.originalSeq === undefined ? [] : [message.originalSeq]))];
      for (const target of targets) {
        this.#assertInterest(signal);
        if (this.#messages.has(target) || this.#deleted(target)) continue;
        const before = this.#after(target);
        const related = await this.#rawPage({ since: target, ...(before === undefined ? {} : { before }), limit: 1 }, signal, true);
        relatedPages.push(related); this.#hydrateTargets.delete(target);
      }
      return relatedPages.length ? Object.freeze({ ...page, relatedPages: Object.freeze(relatedPages) }) : page;
    });
    const work = { query, retain: retainMessages, promise }; this.#pageWork = work;
    void promise.then(() => { if (this.#pageWork === work) this.#pageWork = undefined; this.#pumpHydrate(); },
      () => { if (this.#pageWork === work) this.#pageWork = undefined; this.#pumpHydrate(); });
    return promise;
  }
  #rawPage(input: ConversationPageQuery, signal?: AbortSignal, retainMessages = true): Promise<ConversationPageResult> {
    this.#assertInterest(signal);
    const query = this.#pageQuery(input);
    if (this.#history) {
      const current = this.#history;
      if (current.query.since === query.since && current.query.before === query.before && current.query.limit === query.limit && current.retainMessages === retainMessages) return current.result.promise;
      return Promise.reject(error('conversationHistoryUnavailable', 'invalidResponse', true));
    }
    const result = deferred<ConversationPageResult>(), finished = deferred<void>();
    const history: HistoryRequest = { query, retainMessages, upper: this.#upper!, received: new Set(), messages: new Map(),
      result, finished, timer: setTimeout(() => this.#failHistory(history,
        error('conversationHistoryTimeout', 'timeout', false, 'history', 504), true), responseTimeoutMs),
      detach: () => {}, receivedCount: 0, settled: false, ended: false, drained: false, blocked: false };
    this.#history = history;
    const abort = () => {
      if (!history.settled) { history.settled = true; history.result.reject(this.#scope.active ? cancelled() : error('conversationSessionClosed', 'sessionClosed', false)); }
    };
    signal?.addEventListener('abort', abort, { once: true });
    this.#interest.signal.addEventListener('abort', abort, { once: true });
    history.detach = () => { signal?.removeEventListener('abort', abort); this.#interest.signal.removeEventListener('abort', abort); };
    if (signal?.aborted || this.#interest.signal.aborted) abort();
    try {
      const read = this.#startRead({ what: 'data', data: query });
      history.readId = read.request.id;
      void read.request.response.then((response) => this.#historyControl(history, response), (reason: unknown) => {
        if (reason instanceof TinodeSessionFailure && reason.origin === 'server') this.#historyRejected(history, failure(reason));
        else this.#failHistory(history, failure(reason), true);
      });
    } catch (reason: unknown) { this.#failHistory(history, failure(reason), false); this.#endHistory(history, true); }
    return result.promise;
  }

  #startRead(query: TinodeConversationGetQuery): ReadRequest {
    if (!this.#subscription) throw error('conversationSessionClosed', 'sessionClosed', false);
    const request = this.#subscription.requestMeta(query, this.#transport.signal);
    return this.#trackRead(request, query.what);
  }
  #trackRead(request: TinodeConversationRequest, what: TinodeConversationGetQuery['what'], isolatedMetadata = false): ReadRequest {
    const read: ReadRequest = { request, what, done: deferred<void>() };
    this.#reads.set(request.id, read);
    this.#knownCommandIds.add(request.id);
    void request.response.then(() => this.#finishRead(read), (reason: unknown) => {
      // MetadataReader isolates completed or expired IDs within the scope. A failure of this
      // optional read does not fail the conversation history.
      if (isolatedMetadata || (reason instanceof TinodeSessionFailure && (reason.origin === 'server' || reason.reason === 'closed'))) this.#finishRead(read);
      else this.#markUnsafe(failure(reason));
    });
    return read;
  }
  async #readMetadata(query: TinodeConversationGetQuery): Promise<TinodeSessionObject> {
    await this.#waitForChannelPush();
    this.#assertInterest();
    const read = this.#startRead(query);
    return read.request.response;
  }
  #finishRead(read: ReadRequest): void {
    if (this.#reads.get(read.request.id) === read) this.#reads.delete(read.request.id);
    read.done.resolve();
  }

  readonly #onPacket = (packet: TinodeConversationPacket): void => {
    this.#handlePacket(packet);
    this.#infoPacket(packet);
  };
  #handlePacket(packet: TinodeConversationPacket): void {
    if (this.#phase === 'closed') return;
    const p = packet.payload;
    if (packet.kind === 'ctrl' && this.#phase === 'ready') this.#publicationControl(p);
    if (p.topic === 'me') {
      if (packet.kind === 'pres') this.#presence(p, true);
      else if (packet.kind === 'meta' && Array.isArray(p.sub)) for (const row of p.sub) {
        if (!record(row) || row.topic !== this.topicKey) continue;
        const rowAt = normalizeConversationTimestamp(row.deleted ?? row.updated), currentAt = normalizeConversationTimestamp(this.#description.updated);
        if (rowAt.state === 'known' && currentAt.state === 'known' && rowAt.at < currentAt.at) continue;
        if (row.deleted) { this.#terminate(error('conversationUnavailable', 'permission', false).conversationError); return; }
        // The me.sub reply already updates the list. Requesting desc here would create a refresh loop.
        // The title and photo update through pres.upd or the topic's own meta.desc.
        this.#access(row.acs, false);
        if (this.#identity.kind === 'personal' && p.id === undefined) { this.#presenceEpoch++; this.#setPeerPresence(row); }
      }
      return;
    }
    if (p.topic !== this.topicKey) return;
    if (packet.kind === 'ctrl') {
      this.#commandPacket(p);
      const read = typeof p.id === 'string' ? this.#reads.get(p.id) : undefined;
      if (read && typeof p.code === 'number' && p.code >= 400) this.#finishRead(read);
      const history = this.#history;
      if (history && history.readId !== undefined && history.readId === p.id) this.#historyControl(history, p);
      if (p.code === 205 && this.#phase !== 'closing') {
        this.#attachment = 'none'; this.#terminate(error('conversationUnavailable', 'permission', false).conversationError);
      }
    } else if (packet.kind === 'pres') this.#presence(p, false);
    else if (packet.kind === 'info') this.#receipt(p);
    else if (packet.kind === 'meta') {
      const read = typeof p.id === 'string' ? this.#reads.get(p.id) : undefined;
      if (read && read.what !== 'data' && p[read.what] !== undefined) this.#finishRead(read);
      if (record(p.del)) this.#applyDeletion(p.del);
      if (p.id === undefined) {
        this.#metadataEpoch++;
        if (record(p.desc)) this.#applyDescription(p.desc);
        if (Array.isArray(p.sub)) {
          this.#applyProfiles(p.sub); this.#presenceEpoch++;
          for (const row of p.sub) if (record(row) && typeof row.user === 'string') {
            if (row.deleted || !this.#memberPresence.has(row.user)) this.#membershipValid = false;
            else if (typeof row.online === 'boolean') this.#memberPresence.set(row.user, row.online);
          }
          this.#updateHeaderPresence();
        }
      }
    } else if (packet.kind === 'data') {
      const history = this.#history;
      if (!integer(p.seq, 1)) { if (history) this.#failHistory(history, invalid(), true); return; }
      const inPage = history && p.seq <= history.upper && p.seq >= (history.query.since ?? 1) &&
        (history.query.before === undefined || p.seq < history.query.before);
      if (history && p.seq <= history.upper && !inPage && !this.#messages.has(p.seq)) {
        this.#failHistory(history, invalid(), true); return;
      }
      if (inPage) {
        if (history.retainMessages) this.#received(p.seq);
        history.receivedCount++; history.received.add(p.seq);
        const target = this.#replacementTarget(p);
        if (target !== undefined) this.#versionTargets.set(p.seq, target);
        if (!history.settled && history.retainMessages && this.#phase !== 'closing') {
          try { const message = this.#remember(p, false); if (message) history.messages.set(message.serverSeq, message); }
          catch (reason: unknown) { this.#failHistory(history, failure(reason), false); }
        }
        if (history.receivedCount > history.query.limit) this.#failHistory(history, invalid(), true);
        this.#tryHistory(history);
      } else if (this.#phase !== 'closing') {
        this.#received(p.seq);
        try { this.#remember(p, true); } catch (reason: unknown) { this.#terminate(failure(reason).conversationError); }
      }
    }
  }

  #replacementTarget(packet: TinodeSessionObject): number | undefined {
    const head = record(packet.head) ? packet.head : undefined;
    return typeof packet.seq === 'number' ? replacementMessageSeq(head?.replace, this.topicKey, packet.seq) : undefined;
  }
  #deleted(seq: number): boolean {
    const target = this.#versionTargets.get(seq);
    return conversationSeqDeleted(seq, this.#deletion.ranges) || (target !== undefined && conversationSeqDeleted(target, this.#deletion.ranges));
  }
  #clearWindow(): void {
    for (const seq of this.#messages.keys()) if (this.#upper !== undefined && seq <= this.#upper) this.#messages.delete(seq);
  }
  #remember(packet: TinodeSessionObject, live: boolean, fromEditAck = false): ConversationMessage | undefined {
    if (!integer(packet.seq, 1)) throw invalid();
    const target = this.#replacementTarget(packet); if (target !== undefined) this.#versionTargets.set(packet.seq, target);
    if (this.#deleted(packet.seq)) return;
    const previous = this.#messages.get(packet.seq);
    if (previous && (fromEditAck || !this.#ackEdits.has(previous))) return previous;
    if (typeof packet.from === 'string' && /^usr[A-Za-z0-9_-]+$/.test(packet.from) && !this.#profiles.has(packet.from)) {
      this.#profiles.set(packet.from, normalizeConversationProfile({}, packet.from, { state: 'unavailable' }));
      if (this.#identity.kind === 'group') this.#schedule('sub:' + packet.from);
    }
    const seq = packet.seq;
    let photoIndex = 0, voiceIndex = 0;
    const message = normalizeConversationMessage(packet, { identity: this.#identity, profiles: this.#profiles,
      photoMedia: (data, mime) => this.#registerPhoto(seq, photoIndex++, data, mime),
      voiceMedia: (data, mime) => this.#registerVoice(seq, voiceIndex++, data, mime) });
    // A real data packet outranks the projection made from an ACK.
    if (fromEditAck) this.#ackEdits.add(message);
    this.#messages.set(message.serverSeq, message);
    if (canEditConversationMessage(message)) this.#editPackets.set(message, packet);
    if (message.sender.state === 'other') this.#queueSenderAvatar(message.sender.uid);
    if (live) {
      if (!message.operationId || !this.#publications.has(message.operationId)) {
        this.#handoff.refreshPreview(this.topicKey, 'message');
      }
      this.#emit({ kind: 'messageUpsert', message });
    }
    this.#publicationEcho(message);
    if (message.originalSeq !== undefined && !this.#messages.has(message.originalSeq) && !this.#deleted(message.originalSeq)) {
      this.#hydrateTargets.add(message.originalSeq); this.#pumpHydrate();
    }
    return message;
  }
  #terminate(problem: ConversationError): void {
    if (this.#phase === 'closing' || this.#phase === 'closed') return;
    this.#emit({ kind: 'unavailable', error: problem }); void this.close();
  }
  #applyDeletion(value: unknown): void {
    try {
      const incoming = normalizeConversationDeletion(value);
      // Background notices can overlap our request. Keep its bubble until the exact history probe agrees.
      const held = [...new Set([...this.#deleteIntents.values()].flatMap(intent => intent.seqs))].sort((a, b) => a - b);
      const verified = incoming.ranges.flatMap(range => {
        if (!held.length) return [range];
        const parts: ConversationDeletionRange[] = [];
        let low = range.low;
        const last = range.hi === undefined ? low : range.hi - 1;
        for (const seq of held) {
          if (seq < low) continue;
          if (seq > last) break;
          if (seq > low) parts.push({ low, hi: seq });
          if (seq === last) return parts;
          low = seq + 1;
        }
        parts.push({ low, ...(range.hi === undefined ? {} : { hi: range.hi }) });
        return parts;
      });
      const previous = this.#deletion.ranges;
      const ranges = mergeConversationDeletionRanges([...previous, ...verified]);
      this.#deletion = Object.freeze({ transactionId: Math.max(this.#deletion.transactionId, incoming.transactionId), ranges });
      if (ranges.length === previous.length && ranges.every((range, index) =>
        range.low === previous[index]?.low && range.hi === previous[index]?.hi)) return;
      for (const seq of this.#messages.keys()) if (this.#deleted(seq)) this.#messages.delete(seq);
      const used = new Set([...this.#messages.values()].filter(message => message.sender.state === 'other').map(message => message.sender.uid));
      for (const [uid, profile] of this.#profiles) if (!used.has(uid)) {
        this.#avatars?.release(uid); this.#avatarOwners.delete(uid);
        this.#avatarVersions.set(uid, (this.#avatarVersions.get(uid) ?? 0) + 1);
        this.#profiles.set(uid, Object.freeze<NormalizedConversationProfile>({ ...profile, avatar: this.#avatars?.state(this.#avatarCandidates.get(uid)) ?? { state: 'unavailable' } }));
      }
      this.#emit({ kind: 'messagesDeleted', deletion: this.#deletion });
    } catch (reason: unknown) { this.#terminate(failure(reason).conversationError); }
  }
  #access(value: unknown, grant = true, freshDescription = false): void {
    if (!record(value)) return;
    const permissions = normalizeConversationPermissions(value), previous = this.#permissions;
    const denied = { state: 'denied', reason: 'notGranted' } as const;
    if (permissions.canRead.state === 'denied' || conversationAccessRemoved(value, 'J') || conversationAccessRemoved(value, 'R')) {
      this.#emit({ kind: 'permissionsChanged', permissions: Object.freeze<ConversationPermissions>({ canRead: denied, canWrite: denied, canDelete: denied }) });
      this.#terminate(error('conversationReadDenied', 'permission', false).conversationError); return;
    }
    const canDelete = permissions.canDelete.state === 'denied' || conversationAccessRemoved(value, 'D') ? denied
      : freshDescription ? permissions.canDelete : previous?.canDelete ?? { state: 'unknown' } as const;
    // A subscription can report a revocation while a previous description read is still in flight.
    if (!freshDescription && previous?.canDelete.state === 'allowed' && canDelete.state === 'denied') this.#metadataEpoch++;
    if (permissions.canRead.state === 'allowed' && grant) this.#permissions = Object.freeze({ ...permissions, canDelete });
    else if (previous || conversationAccessRemoved(value, 'W')) this.#permissions = Object.freeze<ConversationPermissions>({
      canRead: previous?.canRead ?? { state: 'unknown' }, canWrite: conversationAccessRemoved(value, 'W')
        ? denied : previous?.canWrite ?? { state: 'unknown' }, canDelete });
    if (this.#permissions) this.#emit({ kind: 'permissionsChanged', permissions: this.#permissions });
  }
  #invalidateDeleteAccess(): void {
    if (this.#permissions?.canDelete.state !== 'allowed') return;
    this.#permissions = Object.freeze<ConversationPermissions>({ ...this.#permissions, canDelete: { state: 'unknown' } });
    this.#emit({ kind: 'permissionsChanged', permissions: this.#permissions });
  }
  #presence(p: TinodeSessionObject, onMe: boolean): void {
    if (this.#phase === 'closing') return;
    if (p.what === 'term') {
      this.#attachment = 'none'; this.#terminate(error('conversationHistoryInterrupted', 'network', true).conversationError); return;
    }
    if (onMe && p.src !== this.topicKey) return;
    if (p.what === 'gone' && (onMe || p.src === undefined || p.src === this.account.uid)) {
      this.#terminate(error('conversationUnavailable', 'permission', false).conversationError); return;
    }
    if (p.what === 'on' || p.what === 'off' || p.what === 'ua') {
      this.#presenceEpoch++;
      if (onMe && this.#identity.kind === 'personal') {
        if (p.what === 'on') this.#peerPresence = { state: 'online' };
        else if (p.what === 'off') this.#peerPresence = { state: 'offline' };
        // ua alone does not prove online/offline and is not a last-seen timestamp.
        this.#updateHeaderPresence();
      } else if (!onMe && this.#identity.kind === 'group' && typeof p.src === 'string' && /^usr[A-Za-z0-9_-]+$/.test(p.src)) {
        if (p.what !== 'ua') {
          if (!this.#memberPresence.has(p.src)) { this.#membershipValid = false; this.#schedule('members'); }
          else this.#memberPresence.set(p.src, p.what === 'on');
          this.#updateHeaderPresence();
        }
      }
      return;
    }
    if (p.what === 'del') {
      if (Array.isArray(p.delseq)) this.#applyDeletion({ clear: p.clear, delseq: p.delseq });
      else this.#schedule('del');
      return;
    }
    if (p.what === 'acs') {
      this.#metadataEpoch++;
      const refreshRoster = !onMe || this.#confirmedGroupRosterCount !== undefined;
      this.#confirmedGroupRosterCount = undefined;
      if (refreshRoster && this.#identity.kind === 'group') {
        this.#membershipValid = false;
        this.#updateHeaderPresence();
        this.#schedule('members');
      }
      const affected = onMe ? p.tgt : p.tgt ?? p.src ?? this.account.uid;
      if (affected === undefined || affected === this.account.uid) {
        // alpha3 converts acs to AccessMode before onMessage. For incomplete acs,
        // the delta sign is already lost, so request a fresh desc.
        const ambiguous = p.dacs === undefined && record(p.acs) && typeof p.acs.mode === 'number' &&
          (typeof p.acs.given !== 'number' || typeof p.acs.want !== 'number');
        if (!ambiguous) this.#access(p.dacs ?? p.acs);
        // A presence delta can revoke D, but only a fresh own description grants it.
        this.#invalidateDeleteAccess();
      }
      this.#schedule('desc');
      if (!onMe && typeof affected === 'string' && /^usr[A-Za-z0-9_-]+$/.test(affected)) this.#schedule('sub:' + affected);
    } else if (p.what === 'upd' || p.what === 'gone') {
      if (p.what === 'gone' && !onMe && this.#identity.kind === 'group') {
        this.#confirmedGroupRosterCount = undefined;
        this.#membershipValid = false;
        this.#updateHeaderPresence();
        this.#schedule('members');
      }
      this.#metadataEpoch++; this.#schedule('desc');
      if (!onMe && typeof p.src === 'string' && /^usr[A-Za-z0-9_-]+$/.test(p.src)) this.#schedule('sub:' + p.src);
    }
  }
  #public(previous: unknown, patch: unknown): unknown {
    return patch === undefined ? previous : record(patch) && record(previous) ? Object.freeze({ ...previous, ...patch }) : patch;
  }
  #sameAvatar(a: unknown, b: unknown): boolean {
    const left = record(a) ? a.photo : undefined, right = record(b) ? b.photo : undefined;
    return left === right || (record(left) && record(right) && left.type === right.type && left.ref === right.ref && left.data === right.data);
  }
  #avatarState(key: string, publicProfile: unknown, previous: ConversationHeader['avatar'] | undefined): ConversationHeader['avatar'] {
    const old = this.#avatarCandidates.get(key), same = this.#sameAvatar(old, publicProfile);
    this.#avatarCandidates.set(key, publicProfile);
    if (same && previous && previous.state !== 'unavailable') return previous;
    this.#avatarVersions.set(key, (this.#avatarVersions.get(key) ?? 0) + 1);
    this.#avatarOwners.delete(key); this.#avatars?.release(key);
    return this.#avatars?.state(publicProfile) ?? { state: 'unavailable' };
  }
  #installProfile(uid: string, row: TinodeSessionObject): void {
    if (row.deleted) {
      if (uid === this.account.uid) this.#terminate(error('conversationUnavailable', 'permission', false).conversationError);
      return;
    }
    const publicProfile = row.public === undefined ? this.#avatarCandidates.get(uid) : row.public;
    const previous = this.#profiles.get(uid), avatar = this.#avatarState(uid, publicProfile, previous?.avatar);
    const profile = normalizeConversationProfile({ ...row, public: publicProfile }, uid, avatar);
    this.#profiles.set(uid, profile);
    for (const [seq, message] of this.#messages) if (message.sender.state === 'other' && message.sender.uid === uid) {
      const updated = Object.freeze({ ...message, sender: Object.freeze({ ...message.sender, displayName: profile.displayName, avatar: profile.avatar }) });
      this.#messages.set(seq, updated); this.#emit({ kind: 'messageUpsert', message: updated });
    }
    if ([...this.#messages.values()].some(message => message.sender.state === 'other' && message.sender.uid === uid)) this.#queueAvatar({ key: uid, uid, publicProfile });
  }
  #applyProfiles(rows: readonly unknown[]): void {
    for (const row of rows) {
      if (!record(row) || typeof row.user !== 'string' || !/^usr[A-Za-z0-9_-]+$/.test(row.user)) continue;
      if (row.user === this.account.uid) this.#access(row.acs);
      this.#installProfile(row.user, row as TinodeSessionObject);
      this.#applySubscriptionReceipt(row);
    }
    this.#updateHeaderPresence();
  }
  #applySubscriptionReceipt(row: Record<string, unknown>): void {
    if (row.deleted) return;
    this.#receipt({ from: row.user, what: 'read', seq: row.read });
    this.#receipt({ from: row.user, what: 'recv', seq: row.recv });
  }
  #receipt(packet: Record<string, unknown>): void {
    if ((packet.what !== 'read' && packet.what !== 'recv') || typeof packet.from !== 'string' ||
      !/^usr[A-Za-z0-9_-]+$/.test(packet.from) || !integer(packet.seq, 0)) return;
    if (packet.from === this.account.uid) {
      if (packet.what === 'read') this.#acceptRead(packet.seq);
      else this.#sentRecv = Math.max(this.#sentRecv, packet.seq);
    }
    this.#emit({ kind: 'receiptUpdated', uid: packet.from, receipt: packet.what, serverSeq: packet.seq });
  }
  #applyMembership(rows: readonly unknown[]): void {
    const members = new Map<string, boolean | undefined>();
    let valid = true;
    for (const row of rows) {
      if (!record(row) || typeof row.user !== 'string' || !/^usr[A-Za-z0-9_-]+$/.test(row.user)) { valid = false; continue; }
      if (row.deleted) continue;
      if (members.has(row.user)) valid = false;
      members.set(row.user, typeof row.online === 'boolean' ? row.online : undefined);
    }
    this.#memberPresence = members; this.#membershipValid = valid;
    if (valid && this.#header?.kind === 'group' && !this.#header.isChannel) {
      const count = confirmedGroupRosterCount(rows, this.#identity, 32, this.#scope.subscriberLimit());
      if (count !== undefined) {
        this.#confirmedGroupRosterCount = count;
        this.#participantCountBeforeAttach = undefined;
        this.#header = Object.freeze({ ...this.#header, participantCount: { state: 'known' as const, value: count } });
      }
    }
    const countBeforeAttach = this.#participantCountBeforeAttach;
    if (valid && this.#header?.kind === 'group' && !this.#header.isChannel &&
      countBeforeAttach !== undefined && members.size > countBeforeAttach) {
      this.#participantCountBeforeAttach = undefined;
      this.#schedule('desc');
    }
    this.#updateHeaderPresence();
  }
  #setPeerPresence(row: Record<string, unknown>): void {
    // me.sub describes global peer presence. Missing online remains unknown.
    if (row.online === undefined && row.seen === undefined) return;
    this.#peerPresence = normalizeConversationPresence(row);
    this.#updateHeaderPresence();
  }
  #updateHeaderPresence(): void {
    if (!this.#header) return;
    if (this.#header.kind === 'personal') this.#header = Object.freeze({ ...this.#header, presence: this.#peerPresence });
    else {
      const count = this.#header.participantCount;
      const complete = this.#membershipValid && count.state === 'known' && count.value === this.#memberPresence.size &&
        [...this.#memberPresence.values()].every(value => value !== undefined);
      this.#header = Object.freeze<ConversationHeader>({ ...this.#header, onlineCount: complete
        ? { state: 'known', value: [...this.#memberPresence.values()].filter(Boolean).length } : { state: 'unknown' } });
    }
    this.#emit({ kind: 'metadataUpdated', header: this.#header });
  }
  #participantCountOverride(reportedCount: unknown, recordObservation: boolean): number | undefined {
    if (this.#confirmedGroupRosterCount !== undefined) return this.#confirmedGroupRosterCount;
    const detachedCount = this.#participantCountBeforeAttach;
    if (detachedCount === undefined) return undefined;
    if (integer(reportedCount, 0)) {
      // Tinode can first report a different count once the owner attaches.
      // A later change to that value is a new server observation.
      if (reportedCount === detachedCount ||
        (this.#firstAttachedParticipantCount !== undefined && reportedCount !== this.#firstAttachedParticipantCount)) {
        if (recordObservation) this.#participantCountBeforeAttach = undefined;
        return undefined;
      }
      if (recordObservation) this.#firstAttachedParticipantCount = reportedCount;
    }
    return detachedCount;
  }

  #applyDescription(payload: unknown, full = false): void {
    if (!record(payload) || this.#phase === 'closing' || this.#phase === 'closed') return;
    if (payload.deleted) { this.#terminate(error('conversationUnavailable', 'permission', false).conversationError); return; }
    const participantCountOverride = this.#participantCountOverride(payload.subcnt, true);
    const value = participantCountOverride === undefined ? payload : { ...payload, subcnt: participantCountOverride };
    const publicProfile = full ? value.public : this.#public(this.#description.public, value.public);
    const desc = Object.freeze({ ...this.#description, ...value, public: publicProfile, ...(full ? { subcnt: value.subcnt ?? null } : {}) }) as TinodeSessionObject;
    const avatar = this.#avatarState('header', publicProfile, this.#header?.avatar);
    const metadata = normalizeConversationMetadata({ topic: this.topicKey, desc }, this.#identity, avatar);
    if (value.acs !== undefined) this.#access(value.acs, true, full);
    else if (full) this.#invalidateDeleteAccess();
    if (this.#interest.signal.aborted) return;
    this.#description = desc;
    if (integer(value.read, 0)) this.#acceptRead(value.read);
    if (integer(value.recv, 0)) this.#sentRecv = Math.max(this.#sentRecv, value.recv);
    this.#header = metadata.header; this.#updateHeaderPresence();
    this.#emit({ kind: 'metadataUpdated', header: this.#header });
    this.#queueAvatar({ key: 'header', publicProfile });
    if (this.#identity.kind === 'personal') this.#installProfile(this.topicKey, desc);
    this.#pumpRefresh();
  }
  #schedule(key: string): void {
    if (this.#phase === 'closing' || this.#phase === 'closed') return;
    this.#refreshKeys.add(key); queueMicrotask(() => this.#pumpRefresh());
  }
  #pumpRefresh(): void {
    if (this.#refreshRunning || !this.#header || this.#phase === 'closing' || this.#phase === 'closed' || !this.#scope.active || !this.#handoff.active) return;
    this.#refreshRunning = true;
    void (async () => {
      while (this.#refreshKeys.size && (this.#phase === 'ready' || this.#phase === 'opening') && this.#scope.active && this.#handoff.active) {
        const key = this.#refreshKeys.values().next().value!; this.#refreshKeys.delete(key);
        const epoch = this.#metadataEpoch;
        try {
          if (key === 'desc') {
            const response = await this.#readMetadata({ what: 'desc', desc: {} }); this.#assertInterest();
            if (epoch === this.#metadataEpoch) this.#applyDescription(response.desc, true); else this.#refreshKeys.add(key);
          } else if (key === 'members') {
            const presenceEpoch = this.#presenceEpoch;
            const response = await this.#readMetadata({ what: 'sub', sub: { limit: 32 } }); this.#assertInterest();
            if (epoch === this.#metadataEpoch && presenceEpoch === this.#presenceEpoch && Array.isArray(response.sub)) {
              this.#applyProfiles(response.sub); this.#applyMembership(response.sub);
            } else this.#refreshKeys.add(key);
          } else if (key === 'del') {
            if (this.#deletionLogCursor === Number.MAX_SAFE_INTEGER) continue;
            const cursor = this.#deletionLogCursor;
            const response = await this.#readMetadata({ what: 'del', del: { since: cursor + 1, limit: 32 } }); this.#assertInterest();
            if (record(response.del)) {
              this.#applyDeletion(response.del);
              if (integer(response.del.clear, 0)) this.#deletionLogCursor = Math.max(cursor, response.del.clear);
              if (this.#deletionLogCursor > cursor && this.#deletionLogCursor < this.#deletion.transactionId) this.#refreshKeys.add('del');
            }
          } else if (key.startsWith('sub:')) {
            const uid = key.slice(4);
            const response = await this.#readMetadata({ what: 'sub', sub: { user: uid, limit: 32 } }); this.#assertInterest();
            if (epoch === this.#metadataEpoch && Array.isArray(response.sub)) this.#applyProfiles(response.sub); else if (epoch !== this.#metadataEpoch) this.#refreshKeys.add(key);
          }
        } catch (reason: unknown) {
          const problem = failure(reason).conversationError;
          if (this.#unsafe || key === 'del' || problem.kind === 'sessionClosed' || (key === 'desc' && problem.kind === 'permission')) this.#terminate(this.#unsafe?.conversationError ?? (key === 'del' ? error('conversationHistoryInterrupted', 'network', true).conversationError : problem));
          // A terminal failure of the optional profile request leaves confirmed history visible.
        }
      }
    })().finally(() => { this.#refreshRunning = false; this.#pumpHydrate(); });
  }
  #pumpHydrate(): void {
    if (this.#deleteWork || this.#latestWork || this.#readPositionWork || this.#reconcileWork || this.#hydrating || this.#pageWork || this.#history || this.#phase !== 'ready' || !this.#scope.active || !this.#handoff.active || !this.#hydrateTargets.size) return;
    this.#hydrating = true;
    void (async () => {
      for (let budget = 0; budget < 32 && !this.#deleteWork && !this.#latestWork && !this.#readPositionWork && !this.#reconcileWork && this.#hydrateTargets.size && this.#phase === 'ready'; budget++) {
        const target = this.#hydrateTargets.values().next().value!; this.#hydrateTargets.delete(target);
        if (this.#messages.has(target) || this.#deleted(target) || this.#upper === undefined || target > this.#upper) continue;
        try {
          const before = this.#after(target);
          const page = await this.#readPage({ since: target, ...(before === undefined ? {} : { before }), limit: 1 }); this.#assertInterest();
          for (const result of [page, ...(page.relatedPages ?? [])]) for (const message of result.messages) if (!this.#deleted(message.serverSeq)) this.#emit({ kind: 'messageUpsert', message });
        } catch (reason: unknown) { if (this.#unsafe) this.#terminate(this.#unsafe.conversationError); }
      }
    })().finally(() => { this.#hydrating = false; });
  }

  #historyControl(history: HistoryRequest, control: TinodeSessionObject): void {
    if (history.ended || history.readId === undefined || control.id !== history.readId) return;
    if (typeof control.code === 'number' && control.code >= 400) {
      this.#historyRejected(history, failure(new TinodeSessionFailure('rejected', control.code, 'server'))); return;
    }
    const params = record(control.params) ? control.params : undefined;
    if ((control.code !== 204 && control.code !== 208) || params?.what !== 'data') return;
    const count = params.count === undefined && control.code === 204 ? 0 : params.count;
    if (!integer(count, 0) || count > history.query.limit ||
      (history.completionCount !== undefined && history.completionCount !== count)) { this.#failHistory(history, invalid(), true); return; }
    history.completionCount = count;
    const read = this.#reads.get(history.readId!);
    if (read) this.#finishRead(read);
    this.#tryHistory(history);
  }
  #historyRejected(history: HistoryRequest, reason: ConversationFailure): void {
    if (history.ended) return;
    this.#failHistory(history, reason, false);
    this.#endHistory(history, true);
  }
  #tryHistory(history: HistoryRequest): void {
    if (history.ended || history.completionCount === undefined) return;
    if (history.receivedCount > history.completionCount) { this.#failHistory(history, invalid(), true); return; }
    if (history.receivedCount === history.completionCount) this.#endHistory(history, true);
  }
  #failHistory(history: HistoryRequest, reason: ConversationFailure, blocked: boolean): void {
    if (history.ended) return;
    history.problem ??= reason;
    if (!history.settled) { history.settled = true; history.result.reject(reason); }
    if (blocked) {
      history.blocked = true; this.#markUnsafe(reason);
      this.#endHistory(history, false);
    }
  }
  #endHistory(history: HistoryRequest, drained: boolean): void {
    if (history.ended) return;
    history.ended = true; history.drained = drained;
    clearTimeout(history.timer); history.detach();
    if (this.#history === history) this.#history = undefined;
    if (!history.settled) {
      history.settled = true;
      if (history.problem) history.result.reject(history.problem);
      else history.result.resolve(this.#pageResult(history));
    }
    history.finished.resolve();
  }

  #pageResult(history: HistoryRequest): ConversationPageResult {
    const receivedSeq = [...history.received].sort((a, b) => a - b);
    const messages = sortConversationMessages([...history.messages.values()].filter(message => !this.#deleted(message.serverSeq)).map(message => this.#messages.get(message.serverSeq) ?? message));
    const lower = history.query.since ?? 1;
    const upper = Math.min(history.upper, (history.query.before ?? (history.upper + 1)) - 1);
    const min = receivedSeq[0], max = receivedSeq.at(-1);
    const olderBoundary = min ?? lower;
    const newerBoundary = max === undefined ? upper + 1 : max + 1;
    const older: ConversationPageCursor = olderBoundary <= 1 ? Object.freeze({ state: 'end' })
      : Object.freeze({ state: 'more', query: Object.freeze({ before: olderBoundary, limit: history.query.limit }) });
    const newer: ConversationPageCursor = newerBoundary > history.upper ? Object.freeze({ state: 'end' })
      : Object.freeze({ state: 'more', query: Object.freeze({ since: newerBoundary, limit: history.query.limit,
        ...(history.upper < Number.MAX_SAFE_INTEGER ? { before: history.upper + 1 } : {}) }) });
    const capacity = Math.max(0, upper - lower + 1);
    return Object.freeze({ identity: this.#identity, revision: ++this.#revision, messages,
      receivedCount: history.receivedCount, range: Object.freeze({ query: history.query,
        snapshotUpperSeq: Object.freeze({ state: 'known', value: history.upper }), receivedSeq: Object.freeze(receivedSeq),
        coverage: history.receivedCount === 0 || receivedSeq.length === capacity ? 'complete' : 'partial', older, newer }) });
  }

  #startCommand(kind: Command['kind'], clean: boolean): Promise<TinodeSessionObject> {
    if (!this.#scope.active || this.#command) return Promise.reject(error('conversationSessionClosed', 'sessionClosed', false));
    const result = deferred<TinodeSessionObject>();
    const command: Command = { kind, clean: clean && !this.#scope.hasUncorrelatedDeletion(this.topicKey), result, settled: false,
      timer: setTimeout(() => this.#finishCommand(command, undefined,
        error('conversationAttachUnconfirmed', 'timeout', false)), responseTimeoutMs) };
    this.#command = command;
    const request = kind === 'attach' ? this.#scope.subscribe(this.topicKey, null) : this.#scope.leave(this.topicKey);
    void request.then((response) => {
      if (this.#validAck(response)) this.#finishCommand(command, response);
      else this.#finishCommand(command, undefined, invalid());
    }, (reason: unknown) => {
      // A local 504 does not establish rejection. The router already handles correlated ctrl packets with a topic.
      // A topicless 504 with an unknown subscribe ID leaves the outcome unknown.
      if (reason instanceof TinodeSessionFailure && reason.code === 504) return;
      this.#finishCommand(command, undefined, failure(reason), knownRefusal(reason));
    });
    return result.promise;
  }
  #validAck(value: TinodeSessionObject): boolean {
    return value.topic === this.topicKey && typeof value.id === 'string' && value.id !== '' &&
      (value.code === 200 || value.code === 304) && (value.params === undefined || (record(value.params) && value.params.what === undefined));
  }
  #commandPacket(control: TinodeSessionObject): void {
    const command = this.#command;
    if (!command || !command.clean || typeof control.id !== 'string' || control.id === '' || this.#knownCommandIds.has(control.id)) return;
    // A clean handoff has one owner and no outstanding metadata or data queries.
    if (this.#validAck(control)) this.#finishCommand(command, control);
    else if (typeof control.code === 'number' && control.code >= 400 &&
      (!record(control.params) || control.params.what === undefined)) {
      const reason = new TinodeSessionFailure('rejected', control.code, 'server');
      this.#finishCommand(command, undefined, failure(reason), knownRefusal(reason));
    }
  }
  #finishCommand(command: Command, response?: TinodeSessionObject, problem?: ConversationFailure, refused = false): void {
    if (command.settled) return;
    command.settled = true; clearTimeout(command.timer);
    if (this.#command === command) this.#command = undefined;
    if (response && typeof response.id === 'string') this.#knownCommandIds.add(response.id);
    if (command.kind === 'attach') {
      this.#attachment = response ? 'confirmed' : refused ? 'refused' : 'unknown';
      if (response) this.#topicInterest.attached();
      else if (refused) this.#topicInterest.refused();
    } else this.#topicInterest.detached(response !== undefined && !this.#unsafe);
    if (problem) {
      if (!refused || command.kind === 'leave') this.#markUnsafe(problem);
      command.result.reject(problem);
    } else command.result.resolve(response!);
  }

  #queueSenderAvatar(uid: string): void {
    const profile = this.#profiles.get(uid);
    if (profile?.avatar.state === 'pending' && this.#avatarCandidates.has(uid)) {
      this.#queueAvatar({ key: uid, publicProfile: this.#avatarCandidates.get(uid), uid });
    }
  }
  #queueAvatar(task: AvatarTask): void {
    if (this.#avatarOwners.has(task.key) || !this.#avatars || this.#avatars.state(task.publicProfile).state !== 'pending') return;
    this.#avatarOwners.add(task.key); this.#avatarQueue.push({ ...task, version: this.#avatarVersions.get(task.key) ?? 0 }); this.#pumpAvatars();
  }
  #pumpAvatars(): void {
    while (this.#avatarRunning < 2 && this.#avatarQueue.length && this.#phase !== 'closing' && this.#phase !== 'closed') {
      const task = this.#avatarQueue.shift()!;
      if (task.version !== (this.#avatarVersions.get(task.key) ?? 0)) continue;
      this.#avatarRunning++;
      void this.#avatars!.load(task.key, task.publicProfile).then((resource) => {
        if (this.#phase === 'closing' || this.#phase === 'closed' || task.version !== (this.#avatarVersions.get(task.key) ?? 0)) return;
        if (task.uid) {
          const previous = this.#profiles.get(task.uid);
          if (!previous) return;
          const profile = Object.freeze({ ...previous, avatar: resource }); this.#profiles.set(task.uid, profile);
          for (const message of this.#messages.values()) {
            if (message.sender.state !== 'other' || message.sender.uid !== task.uid) continue;
            const updated = Object.freeze({ ...message, sender: Object.freeze({ ...message.sender, avatar: resource }) });
            this.#messages.set(message.serverSeq, updated);
            if (this.#phase === 'ready' || this.#phase === 'opening') this.#emit({ kind: 'messageUpsert', message: updated });
          }
        } else if (this.#header) {
          this.#header = Object.freeze({ ...this.#header, avatar: resource });
          if (this.#phase === 'ready' || this.#phase === 'opening') this.#emit({ kind: 'metadataUpdated', header: this.#header });
        }
      }).catch(() => {}).finally(() => { this.#avatarRunning--; this.#pumpAvatars(); });
    }
  }

  #assertInterest(signal?: AbortSignal): void {
    if (!this.#scope.active || this.#phase === 'closed' || this.#phase === 'closing') throw error('conversationSessionClosed', 'sessionClosed', false);
    if (signal?.aborted || this.#interest.signal.aborted || !this.#handoff.active) throw cancelled();
    if (this.#unsafe || this.#session.blocked.has(this.topicKey)) throw this.#unsafe ?? error('conversationAttachUnconfirmed', 'timeout', false);
  }
  async #wait<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    const stop = deferred<never>();
    const cancel = () => stop.reject(cancelled());
    const close = () => stop.reject(error('conversationSessionClosed', 'sessionClosed', false));
    signal?.addEventListener('abort', cancel, { once: true });
    this.#interest.signal.addEventListener('abort', close, { once: true });
    if (signal?.aborted) cancel();
    if (this.#interest.signal.aborted) close();
    try { return await Promise.race([promise, stop.promise]); }
    finally { signal?.removeEventListener('abort', cancel); this.#interest.signal.removeEventListener('abort', close); }
  }
  #markUnsafe(problem: ConversationFailure): void {
    if (this.#infoSource) this.#releaseInfoSource(this.#infoSource);
    const value = problem.conversationError;
    this.#unsafe ??= new ConversationFailure({ ...value, retryable: false });
    if (this.#scope.active && this.#attachment !== 'none') {
      this.#session.blocked.add(this.topicKey); this.#handoff.blockTopic(this.topicKey);
    }
  }
  #emit(value: Omit<Extract<ConversationReadEvent, { kind: 'messageUpsert' }>, 'identity' | 'revision'> |
    Omit<Extract<ConversationReadEvent, { kind: 'metadataUpdated' }>, 'identity' | 'revision'> |
    Omit<Extract<ConversationReadEvent, { kind: 'outgoingUpdated' }>, 'identity' | 'revision'> |
    Omit<Extract<ConversationReadEvent, { kind: 'messagesDeleted' }>, 'identity' | 'revision'> |
    Omit<Extract<ConversationReadEvent, { kind: 'permissionsChanged' }>, 'identity' | 'revision'> |
    Omit<Extract<ConversationReadEvent, { kind: 'unavailable' }>, 'identity' | 'revision'> |
    Omit<Extract<ConversationReadEvent, { kind: 'readUpdated' }>, 'identity' | 'revision'> |
    Omit<Extract<ConversationReadEvent, { kind: 'readPending' }>, 'identity' | 'revision'> |
    Omit<Extract<ConversationReadEvent, { kind: 'receiptUpdated' }>, 'identity' | 'revision'> | { kind: 'closed' }): void {
    if (value.kind !== 'closed' && (!this.#scope.active || !this.#handoff.active || (this.#phase !== 'ready' && this.#phase !== 'opening'))) return;
    // Group info reads its own description and roster. Header updates from the
    // same presence events must not invalidate its read again.
    if (value.kind === 'metadataUpdated' && value.header.kind === 'personal') this.#infoChanged('details');
    const event = Object.freeze({ ...value, identity: this.#identity, revision: ++this.#revision });
    for (const listener of [...this.#listeners]) {
      try { listener(event); } catch { console.error('Conversation subscriber notification failed.'); }
    }
  }

  close(): Promise<ConversationCloseResult> {
    if (this.#closePromise) return this.#closePromise;
    this.#phase = 'closing';
    this.#infoPortWork = undefined;
    if (this.#infoSource) this.#releaseInfoSource(this.#infoSource);
    for (const work of this.#publications.values()) {
      if (work.state.phase === 'preparing' || work.state.phase === 'publishing') this.#finishPublication(work,
        work.sent ? { phase: 'unknown', messageCode: 'conversationSendUnknown' } : { phase: 'cancelled' });
    }
    this.#refreshKeys.clear(); this.#hydrateTargets.clear();
    this.#closePromise = Promise.resolve().then(() => this.#close());
    this.#interest.abort();
    return this.#closePromise;
  }
  async #close(): Promise<ConversationCloseResult> {
    let detachConfirmed = this.#attachment === 'none' || this.#attachment === 'refused';
    try {
      if (this.#command) await this.#command.result.promise.catch(() => {});
      if (this.#history && !this.#unsafe && this.#scope.active) await this.#history.finished.promise;
      if (!this.#unsafe && this.#reads.size && this.#scope.active) {
        const done = Promise.all([...this.#reads.values()].map(read => read.done.promise));
        let timer!: ReturnType<typeof setTimeout>;
        await Promise.race([done, new Promise<void>((resolve) => { timer = setTimeout(() => {
          this.#markUnsafe(error('conversationAttachUnconfirmed', 'timeout', false)); resolve();
        }, responseTimeoutMs); })]).finally(() => clearTimeout(timer));
      }
      if (this.#infoWrites.size && this.#scope.active) await Promise.allSettled([...this.#infoWrites]);
      if (this.#attachment === 'none' || this.#attachment === 'refused') this.#topicInterest.refused();
      const physicalLeave = this.#topicInterest.release();
      detachConfirmed = !physicalLeave;
      if (!physicalLeave) this.#attachment = 'none';
      if (physicalLeave && this.#scope.active) {
        const clean = this.#attachment === 'confirmed' && !this.#unsafe && this.#reads.size === 0 && !this.#history && !this.#infoWriteMayReply;
        try { await this.#startCommand('leave', clean); detachConfirmed = true; }
        catch (reason: unknown) { this.#markUnsafe(failure(reason)); }
      }
      if (!detachConfirmed || !this.#scope.active || this.#attachment === 'unknown') {
        this.#markUnsafe(error(this.#scope.active ? 'conversationAttachUnconfirmed' : 'conversationSessionClosed',
          this.#scope.active ? 'timeout' : 'sessionClosed', false));
      }
    } finally {
      if (this.#history) this.#failHistory(this.#history, error('conversationSessionClosed', 'sessionClosed', false), true);
      if (this.#command) this.#finishCommand(this.#command, undefined, error('conversationSessionClosed', 'sessionClosed', false));
      this.#transport.abort(); this.#subscription?.dispose(); this.#subscription = undefined;
      for (const read of this.#reads.values()) read.done.resolve();
      for (const work of this.#publications.values()) { clearTimeout(work.timer); work.detach(); work.request?.dispose(); work.content = undefined; }
      this.#publications.clear(); this.#publicationRequests.clear();
      this.#topicInterest.release();
      this.#infoWrites.clear(); this.#reads.clear(); this.#knownCommandIds.clear(); this.#avatars?.dispose(); this.#avatars = undefined;
      this.#avatarQueue.length = 0; this.#avatarCandidates.clear(); this.#avatarOwners.clear();
      this.#profiles.clear(); this.#messages.clear(); this.#header = undefined;
      this.#versionTargets.clear(); this.#avatarVersions.clear(); this.#deleteIntents.clear(); this.#deletion = { transactionId: 0, ranges: [] }; this.#description = {}; this.#permissions = undefined; this.#deletionLogCursor = 0;
      this.#detachScope(); this.#detachReadState();
      this.#memberPresence.clear(); this.#membershipValid = false; this.#peerPresence = { state: 'unknown' };
      this.#confirmedRead = 0; this.#pendingRead = 0; this.#sentRecv = 0; this.#receivedMaximum = 0;
      this.#phase = 'closed';
      if (this.#session.owner === this) this.#session.owner = undefined;
      this.#handoff.release();
      if (!this.#openFailureCleanup) this.#emit({ kind: 'closed' });
      this.#listeners.clear();
    }
    return Object.freeze(this.#unsafe ? { identity: this.#identity, state: 'blocked', error: this.#unsafe.conversationError }
      : { identity: this.#identity, state: 'detached' });
  }
  dispose(): void { void this.close(); }
}
