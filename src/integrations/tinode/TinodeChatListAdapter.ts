import type {
  AccountScope, ChatActionDetails, ChatDepartureAction, ChatDepartureResult, ChatMuteResult, ChatListError, ChatListEvent, ChatListListener, ChatListLoadResult, ChatListPort,
  ChatPreviewResult, ChatPreviewPause, ChatRecord, ChatSequence, CurrentUserProfile, LastMessage, LastMessagePreview, MessageSender, SenderProfile,
} from '../../chats/chat-list-types';
import {
  ChatListFailure, normalizeChatActionTopic, normalizeChatSubscriptions, normalizeOwnProfile, normalizePreviewMessage,
  normalizeChatTitle, normalizeServerTimestamp, normalizeChatSequence, normalizeChatPermissions, unreadCount, mergeChatListSnapshot,
} from '../../chats/chat-list-normalize';
import type { PreviewFrame } from '../../chats/chat-list-normalize';
import type { GroupCreationKind } from '../../groups/group-creation-types';
import { TinodeMutedTopics } from './TinodeMutedTopics';
import { normalizeChatOwnState } from '../../chat-info/chat-info-normalize';
import { changeTinodeChatMute } from './tinode-chat-mute';
import { isConversationDraftId, normalizeConversationDraft } from '../../conversation/ConversationDraft';
import type { ConversationDraft, ConversationDraftPort } from '../../conversation/ConversationDraft';
import type { TinodeTopicInterest } from './TinodeTopicInterests';
import { TinodeAvatarLoader } from './tinode-avatar';
import { TinodeSessionFailure } from './TinodeSessionScope';
import type { TinodeSessionObject, TinodeSessionPacket, TinodeSessionScope } from './TinodeSessionScope';

function cancelled(): DOMException {
  return new DOMException('Chat list request cancelled.', 'AbortError');
}

function failure(reason: unknown, area: ChatListError['area']): ChatListFailure {
  if (reason instanceof ChatListFailure) return reason;
  const code = reason instanceof TinodeSessionFailure ? reason.code : undefined;
  let kind: ChatListError['kind'];
  let retryable: boolean;
  if (reason instanceof TinodeSessionFailure && reason.reason === 'closed') {
    kind = 'sessionClosed'; retryable = false;
  } else if (reason instanceof TinodeSessionFailure && reason.reason === 'invalidResponse') {
    kind = 'invalidResponse'; retryable = true;
  } else if (code === 504) { kind = 'timeout'; retryable = true; }
  else if (code === 401 || code === 403) { kind = 'permission'; retryable = false; }
  else if (code === undefined || code === 503) { kind = 'network'; retryable = true; }
  else { kind = 'unavailable'; retryable = code === 429 || code >= 500; }
  const messageCode = kind === 'sessionClosed' ? 'chatListSessionClosed'
    : area === 'profile' ? 'chatProfileUnavailable'
      : area === 'preview' ? kind === 'timeout' ? 'chatPreviewTimeout'
        : kind === 'permission' ? 'chatPreviewPermission'
          : kind === 'invalidResponse' ? 'chatPreviewInvalidResponse' : 'chatPreviewUnavailable'
      : kind === 'network' ? 'chatListNetwork'
        : kind === 'timeout' ? 'chatListTimeout'
          : kind === 'permission' ? 'chatListPermission'
            : kind === 'invalidResponse' ? 'chatListInvalidResponse' : 'chatListUnavailable';
  return new ChatListFailure({ kind, area, messageCode, retryable,
    ...(code === undefined ? {} : { serverCode: code }) });
}

function isSessionObject(value: unknown): value is TinodeSessionObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function checkControl(response: TinodeSessionObject): void {
  if (typeof response.code === 'number' && response.code >= 400) {
    throw new TinodeSessionFailure('rejected', response.code);
  }
}

// A confirmed rejection leaves no stream or attachment initiated by that request.
function previewRequestRejected(reason: unknown): boolean {
  return reason instanceof TinodeSessionFailure && reason.reason === 'rejected' &&
    reason.code !== undefined && reason.code >= 400 && reason.code < 500 && reason.code !== 408;
}

const previewTimeoutMs = 15_000;

interface PreviewSession {
  owner?: TinodeChatListAdapter;
  readonly blocked: Set<string>;
  // An ambiguous metadata reply blocks the handoff of an already open attachment.
  readonly uncertainReads: Set<string>;
}

// A stream with an unknown outcome cannot be reused by a new adapter on the same SDK.
const previewSessions = new WeakMap<TinodeSessionScope, PreviewSession>();

interface PreviewPauseState {
  released: boolean;
  readonly handle: ChatPreviewPause;
  readonly lifetime: AbortController;
  readonly topics: Set<string>;
}

interface PreviewJob {
  readonly topicKey: string;
  readonly epoch: number;
  readonly topicVersion: number;
  readonly finished: Promise<void>;
  readonly finish: () => void;
  readonly previous: ChatRecord;
  readonly abort: AbortController;
  readonly promise: Promise<ChatPreviewResult>;
  readonly resolve: (result: ChatPreviewResult) => void;
  readonly reject: (reason: unknown) => void;
  detach: () => void;
  started: boolean;
  settled: boolean;
  queryStarted: boolean;
  drained: boolean;
}

export class TinodeChatListAdapter implements ChatListPort {
  #scope: TinodeSessionScope;
  #muted: TinodeMutedTopics;
  readonly #draftWrites = new Map<string, Promise<void>>();
  readonly #draftRevisions = new Map<string, number>();
  readonly #draftMetadataKnown = new Set<string>();
  #disposed = false;
  #records = new Map<string, ChatRecord>();
  #avatars: TinodeAvatarLoader;
  #profiles = new Map<string, SenderProfile>();
  #previewProfileKeys = new Set<string>();
  #profileRequests = new Map<string, Promise<void>>();
  #senderControllers = new Map<string, AbortController>();
  #senderVersions = new Map<string, number>();
  #senderDirty = new Set<string>();
  #topicVersions = new Map<string, number>();
  #metadataVersions = new Map<string, number>();
  #forcePreviews = new Set<string>();
  // Wire progress is independent of the original displayed on the card.
  #previewHeads = new Map<string, number>();
  #readable = new Map<string, boolean>();
  #readableRevisions = new Map<string, number>();
  #snapshotEvents: {
    readonly baseRevision: number;
    readonly events: ChatListEvent[];
    readonly ownPushModes: Map<string, string>;
  } | undefined;
  #meTerminated = false;
  #meVersion = 0;
  #ownVersion = 0;
  #ownDirty = false;
  #ownPromise: Promise<void> | undefined;
  #senderKeys = new Set<string>();
  #membershipEpoch = 0;
  #previewSession: PreviewSession;
  #previewJobs = new Map<string, PreviewJob>();
  #muteWorks = new Map<string, Promise<ChatMuteResult>>();
  #departures = new Map<string, Promise<ChatDepartureResult>>();
  #previewQueue: PreviewJob[] = [];
  #previewRunning = 0;
  #previewDrains = new Map<string, PreviewJob>();
  #topicReads = new Map<string, Set<Promise<void>>>();
  #previewPause: PreviewPauseState | undefined;
  #topicReservations = new Set<PreviewPauseState>();
  #lastConsumerGeneration = -1;
  #pausedPreviews = new Set<string>();
  #lifetime = new AbortController();
  #generation = 0;
  #revision = 0;
  #meAttached = false;
  #attachPromise: Promise<void> | undefined;
  #loadPromise: Promise<ChatListLoadResult> | undefined;
  #loadAbort: AbortController | undefined;
  #detachSignal: (() => void) | undefined;
  #detachScope: () => void = () => {};
  #detachPackets: () => void = () => {};
  #detachReadState: () => void = () => {};
  #detachOwnPush: () => void = () => {};
  #detachGroupProfile: () => void = () => {};
  #messageAbort = new AbortController();
  #messageSignals = new Map<string, number>();
  #mutedGaps = new Map<string, number>();
  #dirtyMessages = new Set<string>();
  #updatingMessages = new Set<string>();
  #readSequences = new Map<string, number>();
  #recvSequences = new Map<string, number>();
  #listeners = new Set<ChatListListener>();
  #ownProfile: CurrentUserProfile = Object.freeze({ state: 'pending' });

  constructor(scope: TinodeSessionScope) {
    this.#scope = scope;
    if (!scope.active) throw this.#closed();
    let session = previewSessions.get(scope);
    if (!session) {
      const created: PreviewSession = { blocked: new Set(), uncertainReads: new Set() };
      session = created;
      previewSessions.set(scope, created);
      scope.onClose(() => { created.blocked.clear(); created.uncertainReads.clear(); created.owner = undefined; });
    }
    if (session.owner) throw new ChatListFailure({ kind: 'unavailable', area: 'list',
      messageCode: 'chatListUnavailable', retryable: true });
    this.#muted = new TinodeMutedTopics(scope, topic => {
      if (this.#records.has(topic)) this.#queueMetadata(topic, false);
    });
    this.#avatars = new TinodeAvatarLoader(scope);
    this.#previewSession = session;
    session.owner = this;
    this.#detachScope = scope.onClose(() => this.dispose());
    this.#detachPackets = scope.subscribePackets(this.#onPacket);
    this.#detachOwnPush = scope.subscribeOwnPush((topic, mode) => {
      const previous = this.#records.get(topic);
      if (!this.active || this.#meTerminated || !previous) return;
      if (mode !== undefined) {
        this.#snapshotEvents?.ownPushModes.set(topic, mode);
        this.#muted.update({ topic, acs: { mode } });
        const notificationsMuted = !mode.includes('P');
        const record = Object.freeze({ ...previous, notificationsMuted, revision: ++this.#revision });
        this.#records.set(topic, record);
        this.#emit(Object.freeze({ kind: 'chatUpsert', scope: this.account, record, revision: record.revision,
          updatedFields: Object.freeze(['notificationsMuted'] as const) }));
      }
      this.#queueMetadata(topic, false);
    });
    this.#detachGroupProfile = scope.subscribeGroupProfile(topic => {
      if (this.active && !this.#meTerminated && this.#records.has(topic)) this.#queueMetadata(topic, false);
    });
    this.#detachReadState = scope.subscribeReadState(value => {
      if (!this.active || this.#meTerminated) return;
      if (value.state === 'pending') this.#emit(Object.freeze({ kind: 'readPending', scope: this.account,
        topicKey: value.topic, serverSeq: value.seq, revision: ++this.#revision }));
      else {
        const seq = Math.max(this.#readSequences.get(value.topic) ?? 0, value.seq);
        this.#readSequences.set(value.topic, seq);
        this.#applyRead(value.topic, seq);
        const record = this.#records.get(value.topic);
        if (record && this.#muted.has(value.topic) &&
          (record.serverSeq.state === 'unknown' || seq > record.serverSeq.value)) this.#recordMutedGap(value.topic, seq);
      }
    });
  }

  async readActionDetails(topicKey: string, signal: AbortSignal): Promise<ChatActionDetails> {
    const record = this.#records.get(topicKey);
    if (!this.active || this.#meTerminated || !record || signal.aborted) throw cancelled();
    const version = this.#metadataVersions.get(topicKey);
    let details: ChatActionDetails = { ...record.actionTopic, notificationsMuted: record.notificationsMuted };

    const read = async (what: 'description' | 'subscription') => {
      try {
        const reply = await this.#scope.readChatActionMetadata(topicKey, what, signal);
        checkControl(reply);
        return reply;
      } catch (reason) {
        if (signal.aborted || !this.active || this.#meTerminated) throw cancelled();
        return undefined;
      }
    };
    if (topicKey.startsWith('grp') && (details.kind === 'unknown' || details.role === 'unknown')) {
      const reply = await read('description');
      const desc = reply?.desc;
      if (isSessionObject(desc) && !desc.deleted &&
        (typeof desc.chan === 'boolean' || normalizeServerTimestamp(desc.updated) || normalizeServerTimestamp(desc.created))) {
        const topic = normalizeChatActionTopic(topicKey, desc.chan, desc.acs, 'description');
        details = { ...details, kind: topic.kind === 'unknown' ? details.kind : topic.kind,
          role: desc.acs === undefined ? details.role : topic.role };
      }
    }
    if (details.notificationsMuted === undefined || details.role === 'unknown') {
      const reply = await read('subscription');
      if (reply && Array.isArray(reply.sub)) {
        const matched = reply.sub.find(row => isSessionObject(row) && row.topic === topicKey);
        if (isSessionObject(matched) && !matched.deleted) {
          const topic = normalizeChatActionTopic(topicKey, matched.chan, matched.acs, 'subscription');
          details = { kind: topic.kind === 'unknown' ? details.kind : topic.kind,
            role: matched.acs === undefined ? details.role : topic.role,
            notificationsMuted: normalizeChatPermissions(matched.acs)?.notificationsMuted ?? details.notificationsMuted };
        }
      }
    }
    const current = this.#records.get(topicKey);
    if (!this.active || this.#meTerminated || !current || signal.aborted) throw cancelled();
    if (version !== this.#metadataVersions.get(topicKey)) {
      return { ...current.actionTopic, notificationsMuted: current.notificationsMuted };
    }
    return { ...details, notificationsMuted: current.notificationsMuted ?? details.notificationsMuted };
  }

  setMuted(topicKey: string, muted: boolean): Promise<ChatMuteResult> {
    const running = this.#muteWorks.get(topicKey);
    if (running) return running;
    const record = this.#records.get(topicKey);
    const unavailable = { state: 'failed', error: { messageCode: 'chatInfoMuteUnavailable', retryable: true } } as const;
    if (!this.active || this.#meTerminated || !record || typeof muted !== 'boolean') return Promise.resolve(unavailable);
    if (this.#departures.has(topicKey) || [...this.#topicReservations].some(state => state.topics.has(topicKey))) {
      return Promise.resolve({ state: 'failed', error: { messageCode: 'chatInfoMuteBusy', retryable: true } });
    }
    const signal = this.#lifetime.signal;
    const assertActive = () => {
      if (!this.active || this.#meTerminated || !this.#records.has(topicKey) || signal.aborted) throw cancelled();
    };
    // Prevent a metadata reply started before this action from overwriting its result.
    this.#metadataVersions.set(topicKey, (this.#metadataVersions.get(topicKey) ?? 0) + 1);
    const work = Promise.resolve().then(() => changeTinodeChatMute({
      topic: topicKey, target: muted, assertActive,
      read: async () => {
        const response = await this.#scope.readChatActionMetadata(topicKey, 'subscription', signal);
        assertActive();
        checkControl(response);
        const row = Array.isArray(response.sub) ? response.sub.find(value => isSessionObject(value) && value.topic === topicKey) : undefined;
        return normalizeChatOwnState(isSessionObject(row) && !row.deleted ? row.acs : undefined, record.kind);
      },
      write: async (want, enabled) => {
        if (topicKey.startsWith('chn')) {
          // Let any preview already reading this channel drain before a physical detach.
          const job = this.#previewDrains.get(topicKey) ?? this.#previewJobs.get(topicKey);
          if (job) await this.#wait(job.finished, signal);
          assertActive();
        }
        return this.#scope.writeChatListOwnPush(topicKey, want, enabled, signal);
      },
      report: mode => this.#scope.reportOwnPush(topicKey, mode),
    })).then((result): ChatMuteResult => result.state === 'confirmed'
      ? { state: 'confirmed', muted: result.mute.muted }
      : { state: result.state, error: { messageCode: result.messageCode, retryable: result.messageCode !== 'chatInfoMuteDenied' } },
    () => unavailable).finally(() => {
      this.#muteWorks.delete(topicKey);
      if (this.active && !this.#meTerminated && this.#records.has(topicKey)) this.#queueMetadata(topicKey, false);
    });
    this.#muteWorks.set(topicKey, work);
    return work;
  }

  departChat(topicKey: string, action: ChatDepartureAction): Promise<ChatDepartureResult> {
    const running = this.#departures.get(topicKey);
    if (running) return running;
    const deleting = action === 'deleteGroupForAll' || action === 'deleteChannelForAll';
    const unavailable = { state: 'failed',
      messageCode: deleting ? 'chatDeleteForAllUnavailable' : 'chatDepartureUnavailable' } as const;
    if (!this.active || this.#meTerminated || !this.#records.has(topicKey) || this.#muteWorks.has(topicKey) ||
      [...this.#topicReservations].some(state => state.topics.has(topicKey))) return Promise.resolve(unavailable);
    this.#metadataVersions.set(topicKey, (this.#metadataVersions.get(topicKey) ?? 0) + 1);
    const job = this.#previewDrains.get(topicKey) ?? this.#previewJobs.get(topicKey);
    const work = Promise.resolve().then(async (): Promise<ChatDepartureResult> => {
      const signal = this.#lifetime.signal;
      const available = () => this.active && !this.#meTerminated && !signal.aborted;
      const canSend = () => available() && this.#records.has(topicKey);
      const read = async () => {
        const reply = await this.#scope.readChatActionMetadata(topicKey, 'subscription', signal);
        if (!available()) throw cancelled();
        const record = normalizeChatSubscriptions(reply, this.#revision).find(entry => entry.topicKey === topicKey);
        return record?.actionTopic;
      };
      const confirmed = { state: 'confirmed' } as const;
      // A running preview must finish its old attach/data/leave flow before this write.
      if (job?.started) await this.#wait(job.finished, signal);
      if (!available()) return unavailable;
      if (!this.#records.has(topicKey)) {
        if (!deleting) return confirmed;
        return await this.#scope.isChatDeleted(topicKey, signal) && available() ? confirmed : unavailable;
      }

      const current = await read();
      if (!current) {
        this.#acceptChatDeparture(topicKey);
        if (!deleting) return confirmed;
        return await this.#scope.isChatDeleted(topicKey, signal) && available() ? confirmed : unavailable;
      }
      if (deleting) {
        if (!topicKey.startsWith('grp') || current.role !== 'owner') return unavailable;
        const expectedKind = action === 'deleteGroupForAll' ? 'group' : 'channel';
        const reply = await this.#scope.readChatActionMetadata(topicKey, 'description', signal);
        const desc = reply.desc;
        if (!canSend() || !isSessionObject(desc) || desc.deleted ||
          (typeof desc.chan !== 'boolean' && !normalizeServerTimestamp(desc.updated) && !normalizeServerTimestamp(desc.created))) {
          return unavailable;
        }
        const fresh = normalizeChatActionTopic(topicKey, desc.chan, desc.acs, 'description');
        if (fresh.kind !== expectedKind || fresh.role !== 'owner') return unavailable;
        const outcome = await this.#scope.deleteChatForAll(topicKey, signal);
        if (!available()) return unavailable;
        if (outcome === 'confirmed') {
          this.#acceptChatDeparture(topicKey);
          return confirmed;
        }
        return { state: 'failed', messageCode: outcome === 'rejected' ? 'chatDeleteForAllFailed' : 'chatDeleteForAllUnknown' };
      }
      if (!canSend()) return available() ? confirmed : unavailable;
      let kind = current.kind;
      if (kind === 'unknown' && topicKey.startsWith('grp')) {
        const reply = await this.#scope.readChatActionMetadata(topicKey, 'description', signal);
        const desc = reply.desc;
        if (!isSessionObject(desc) || desc.deleted ||
          (typeof desc.chan !== 'boolean' && !normalizeServerTimestamp(desc.updated) && !normalizeServerTimestamp(desc.created))) {
          return unavailable;
        }
        kind = normalizeChatActionTopic(topicKey, desc.chan, desc.acs, 'description').kind;
      }
      const expected = action === 'deletePersonal' ? 'personal' : action === 'leaveGroup' ? 'group' : 'channel';
      if (current.role !== 'member' || kind !== expected) return unavailable;

      const result = await this.#scope.unsubscribeChat(topicKey, signal, canSend,
        async () => !this.#records.has(topicKey) || !(await read()));
      if (!available()) return unavailable;
      if (result === 'confirmed' || !this.#records.has(topicKey)) {
        this.#acceptChatDeparture(topicKey);
        return confirmed;
      }
      return { state: 'failed', messageCode: result === 'rejected' ? 'chatDepartureFailed' : 'chatDepartureUnknown' };
    }).catch(() => unavailable).finally(() => {
      this.#departures.delete(topicKey);
      if (this.active && !this.#meTerminated && this.#records.has(topicKey)) this.#queueMetadata(topicKey, !!job);
    });
    this.#departures.set(topicKey, work);
    if (job && !job.started) this.#cancelPreview(job);
    return work;
  }

  get account(): AccountScope { return this.#scope.account; }

  get active(): boolean { return !this.#disposed && this.#scope.active; }

  subscribe(listener: ChatListListener): () => void {
    if (this.#disposed || !this.#scope.active) return () => {};
    const subscription: ChatListListener = (event) => listener(event);
    this.#listeners.add(subscription);
    return () => { this.#listeners.delete(subscription); };
  }

  pausePreviews(consumerId: number): ChatPreviewPause {
    if (!this.active) throw this.#closed();
    if (this.#meTerminated) throw this.#listUnavailable();
    if (!Number.isSafeInteger(consumerId) || consumerId < 0) {
      throw failure(new TinodeSessionFailure('invalidResponse'), 'list');
    }
    if (this.#previewPause?.handle.navigationGeneration === consumerId) return this.#previewPause.handle;
    if (consumerId <= this.#lastConsumerGeneration) throw cancelled();
    const lifetime = new AbortController();
    const topics = new Set<string>();
    const current = () => this.active && this.#previewPause === state && !lifetime.signal.aborted;
    const state: PreviewPauseState = { released: false, lifetime, topics, handle: Object.freeze({
      account: this.account, navigationGeneration: consumerId,
      get active() { return current(); },
      waitTopicIdle: async (topicKey: string, signal?: AbortSignal) => {
        await this.#waitTopicIdle(state, topicKey, signal);
        const count = this.#records.get(topicKey)?.participantCount;
        // Tinode's attached description may disagree with the group's roster.
        if (count?.state === 'known') {
          this.#scope.rememberGroupCountBeforeAttach(topicKey);
        }
      },
      preparePersonalChat: (userId: string, signal: AbortSignal) => this.#preparePersonalChat(state, userId, signal),
      prepareCreatedGroup: (topicKey: string, signal: AbortSignal, kind: GroupCreationKind) =>
        this.#prepareCreatedGroup(state, topicKey, signal, kind),
      refreshPreview: (topicKey: string, change: 'message' | 'delete') => {
        if (!this.active || !state.topics.has(topicKey) || state.released || !this.#records.has(topicKey)) return;
        this.#invalidatePreview(topicKey, change === 'delete');
        this.#queueMetadata(topicKey, true);
      },
      blockTopic: (topicKey: string) => {
        // An old consumer may isolate its own topic but cannot resume previews for a newer pause.
        if (!this.#scope.active || !state.topics.has(topicKey)) return;
        this.#previewSession.blocked.add(topicKey);
        if (this.active && this.#records.has(topicKey)) this.#updatePreview(topicKey,
          this.#unavailablePreview(this.#previewUnavailable(false), this.#records.get(topicKey)!));
      },
      release: () => this.#releasePause(state),
    }) };
    const previous = this.#previewPause;
    this.#previewPause = state;
    this.#lastConsumerGeneration = consumerId;
    previous?.lifetime.abort();
    // Let active streams finish. Defer queued requests before they send any SDK commands.
    for (const job of [...this.#previewQueue]) {
      if (this.#previewPause !== state) break;
      this.#deferQueuedPreview(job);
    }
    return state.handle;
  }

  async #preparePersonalChat(state: PreviewPauseState, userId: string, signal: AbortSignal): Promise<void> {
    if (!/^usr[A-Za-z0-9_-]+$/.test(userId) || userId === this.account.uid) {
      throw new TinodeSessionFailure('invalidResponse');
    }
    await this.#waitTopicIdle(state, userId, signal, true);
    if (signal.aborted || !state.handle.active) throw cancelled();
    if (this.#records.has(userId)) return;

    const interest = this.#scope.topicInterest(userId, 'conversation');
    let attached = false;
    try {
      const physical = await interest.acquire(signal);
      if (signal.aborted || !state.handle.active) {
        if (physical) interest.refused();
        throw cancelled();
      }
      if (physical) {
        try {
          // Given a peer's ID, Tinode returns an existing P2P topic or creates one.
          // After sending, wait for the outcome before safely leaving, even if the user navigates away.
          const reply = await this.#previewDeadline(this.#scope.subscribe(userId, null));
          checkControl(reply);
          if (reply.code !== 200 && reply.code !== 201 && reply.code !== 304) {
            throw new TinodeSessionFailure('invalidResponse');
          }
          attached = true;
          interest.attached();
        } catch (reason: unknown) {
          if (previewRequestRejected(reason)) interest.refused();
          throw reason;
        }
      }
      if (!this.#records.has(userId)) await this.#refreshMessage(userId, this.#membershipEpoch, true);
      if (!this.#records.has(userId)) throw new TinodeSessionFailure('invalidResponse');
      if (this.#readable.get(userId) === false) throw new TinodeSessionFailure('rejected', 403);
    } finally {
      if (interest.release()) {
        let detached = false;
        try {
          if (this.#scope.active) {
            const reply = await this.#previewDeadline(this.#scope.leave(userId));
            checkControl(reply);
            detached = attached && (reply.code === 200 || reply.code === 304);
          }
        } catch {
          // An unconfirmed leave blocks reopening this topic in the current scope.
        } finally { interest.detached(detached); }
        if (!detached && this.#scope.active) throw this.#previewUnavailable(false);
      }
    }
    if (signal.aborted || !state.handle.active) throw cancelled();
  }

  async #prepareCreatedGroup(state: PreviewPauseState, topicKey: string, signal: AbortSignal, kind: GroupCreationKind): Promise<void> {
    if (!/^grp[A-Za-z0-9_-]+$/.test(topicKey)) throw new TinodeSessionFailure('invalidResponse');
    await this.#waitTopicIdle(state, topicKey, signal, true);
    await this.#refreshMessage(topicKey, this.#membershipEpoch, true);
    if (signal.aborted || !state.handle.active) throw cancelled();
    if (!this.#records.has(topicKey) || this.#readable.get(topicKey) === false) {
      throw new TinodeSessionFailure('invalidResponse');
    }
    if (kind === 'channel') {
      const reply = await this.#scope.getMeta(topicKey, { what: 'desc' });
      if (signal.aborted || !state.handle.active) throw cancelled();
      if (reply.topic !== topicKey || !isSessionObject(reply.desc) || reply.desc.chan !== true) {
        throw new TinodeSessionFailure('invalidResponse');
      }
      this.#scope.rememberGroupCountBeforeAttach(topicKey, reply.desc.subcnt);
    }
  }

  async #waitTopicIdle(state: PreviewPauseState, topicKey: string, signal?: AbortSignal, allowUnlisted = false): Promise<void> {
    const assertCurrent = () => {
      if (!this.active) throw this.#closed('preview');
      if (this.#meTerminated) throw this.#listUnavailable();
      if (this.#previewPause !== state || state.lifetime.signal.aborted || signal?.aborted) throw cancelled();
      if (!/^(?:usr|grp|chn)[A-Za-z0-9_-]+$/.test(topicKey) || (!allowUnlisted && !this.#records.has(topicKey))) {
        throw this.#previewUnavailable(false);
      }
    };
    assertCurrent();
    // Defer new direct profile queries while the consumer owns the topic.
    state.topics.add(topicKey);
    this.#topicReservations.add(state);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    const signals = [state.lifetime.signal, this.#lifetime.signal, ...(signal ? [signal] : [])];
    for (const source of signals) {
      source.addEventListener('abort', cancel, { once: true });
      if (source.aborted) cancel();
    }
    try {
      while (true) {
        assertCurrent();
        // A settled job promise or abort does not prove finally or leave has completed. Wait for the separate drain.
        const job = this.#previewDrains.get(topicKey) ?? this.#previewJobs.get(topicKey);
        const reads = [...(this.#topicReads.get(topicKey) ?? [])];
        const mute = this.#muteWorks.get(topicKey);
        const departure = this.#departures.get(topicKey);
        const pending = [...(job ? [job.finished] : []), ...reads, ...(mute ? [mute] : []),
          ...(departure ? [departure] : [])];
        if (pending.length === 0) {
          if (this.#previewSession.blocked.has(topicKey) || this.#scope.isTopicAttachmentBlocked(topicKey) || this.#previewSession.uncertainReads.has(topicKey)) throw this.#previewUnavailable(false);
          return;
        }
        await this.#wait(Promise.all(pending), controller.signal);
      }
    } finally {
      for (const source of signals) source.removeEventListener('abort', cancel);
    }
  }

  #previewsPaused(): boolean {
    return this.#previewPause !== undefined || this.#topicReservations.size > 0;
  }

  #releasePause(state: PreviewPauseState): void {
    if (state.released) return;
    state.released = true;
    this.#topicReservations.delete(state);
    if (this.#previewPause === state) {
      this.#previewPause = undefined;
      state.lifetime.abort();
    }
    if (this.active && !this.#meTerminated) {
      for (const topic of state.topics) if (this.#muted.has(topic)) this.#queueMetadata(topic, true);
    }
    for (const key of this.#senderDirty) this.#startSender(key);
    this.#resumePreviews();
    this.#releasePreviewOwner();
  }

  #resumePreviews(): void {
    // B may finish before A closes. A still protects its own topic.
    if (this.#previewsPaused()) return;
    if (this.active && !this.#meTerminated) {
      const dirty = [...this.#pausedPreviews];
      this.#pausedPreviews.clear();
      for (const topicKey of dirty) {
        if (!this.#records.has(topicKey)) continue;
        this.#dirtyMessages.add(topicKey);
        this.#updatePreview(topicKey, this.#pendingPreview(this.#records.get(topicKey)!));
      }
      this.#pumpMessages();
      this.#pumpPreviews();
    } else this.#pausedPreviews.clear();
  }

  #pendingPreview(record: ChatRecord): LastMessagePreview & { readonly state: 'pending' } {
    const lastKnown = this.#lastMessage(record.preview);
    return Object.freeze({ state: 'pending', ...(lastKnown === undefined ? {} : { lastKnown }) });
  }

  #deferTopic(topicKey: string): ChatPreviewResult {
    this.#pausedPreviews.add(topicKey);
    const record = this.#records.get(topicKey)!;
    const running = this.#previewJobs.get(topicKey) ?? this.#previewDrains.get(topicKey);
    const lastKnown = this.#lastMessage(record.preview) ?? (running && this.#previewCurrent(running) ? this.#lastMessage(running.previous.preview) : undefined);
    // Repeated calls during the same pause do not publish new events or revisions.
    if (record.preview.state === 'pending' && (record.preview.lastKnown !== undefined || lastKnown === undefined)) {
      return Object.freeze({ scope: this.account, topicKey, revision: record.revision,
        preview: record.preview, lastActivityAt: record.lastActivityAt });
    }
    return this.#updatePreview(topicKey, Object.freeze({ state: 'pending',
      ...(lastKnown === undefined ? {} : { lastKnown }) }));
  }

  #deferQueuedPreview(job: PreviewJob): void {
    if (job.started || job.settled) return;
    this.#previewQueue = this.#previewQueue.filter(entry => entry !== job);
    const result = this.#deferTopic(job.topicKey);
    if (this.#previewJobs.get(job.topicKey) === job) this.#previewJobs.delete(job.topicKey);
    job.settled = true;
    job.detach();
    job.resolve(result);
    job.finish();
  }

  #trackTopicRead<T>(topicKey: string, request: Promise<T>): Promise<T> {
    let commands = this.#topicReads.get(topicKey);
    if (!commands) { commands = new Set(); this.#topicReads.set(topicKey, commands); }
    const bucket = commands;
    // Observe the underlying scope promise independently of the UI's 15-second deadline or cancellation.
    const finished = request.then(() => {}, (reason: unknown) => {
      if (this.#scope.active && !previewRequestRejected(reason)) this.#previewSession.uncertainReads.add(topicKey);
    }).finally(() => {
      bucket.delete(finished);
      if (bucket.size === 0 && this.#topicReads.get(topicKey) === bucket) this.#topicReads.delete(topicKey);
      this.#releasePreviewOwner();
    });
    bucket.add(finished);
    return request;
  }

  openDraft(topicKey: string): ConversationDraftPort | undefined {
    if (!this.active || !this.#records.has(topicKey)) return;
    let obsolete: readonly string[] = [];
    const assertTopic = () => {
      if (!this.active || !this.#records.has(topicKey)) throw this.#closed();
    };
    return Object.freeze({
      initial: this.#records.get(topicKey)?.draft,
      load: async () => {
        await this.#draftWrites.get(topicKey)?.catch(() => {});
        assertTopic();
        const revision = this.#draftRevisions.get(topicKey);
        const response = await this.#scope.getMeta('me', { what: 'sub', sub: { topic: topicKey } });
        assertTopic();
        if (revision !== this.#draftRevisions.get(topicKey)) throw this.#closed();
        const row = Array.isArray(response.sub)
          ? response.sub.find(entry => isSessionObject(entry) && entry.topic === topicKey) : undefined;
        if (!isSessionObject(row) || row.deleted) throw this.#closed();
        obsolete = Array.isArray(row.draftIds) ? row.draftIds.filter(isConversationDraftId) : [];
        const draft = this.#subscriptionDraft(topicKey, row);
        this.#publishDraft(topicKey, draft);
        return draft;
      },
      save: (draft: ConversationDraft | undefined) => this.#writeDraft(topicKey, async () => {
        assertTopic();
        const previousId = this.#records.get(topicKey)?.draft?.id;
        const removeIds = previousId === undefined ? obsolete : [...obsolete, previousId];
        await this.#scope.writeOwnDraft(topicKey, draft, true, removeIds);
        obsolete = [];
        this.#publishDraft(topicKey, draft);
      }),
      clear: (ids: readonly string[]) => this.#writeDraft(topicKey, async () => {
        assertTopic();
        await this.#scope.writeOwnDraft(topicKey, undefined, false, ids);
        const current = this.#records.get(topicKey)?.draft;
        if (current && ids.includes(current.id)) this.#publishDraft(topicKey, undefined);
      }),
    });
  }

  #subscriptionDraft(topicKey: string, row: unknown): ConversationDraft | undefined {
    if (isSessionObject(row) && row.draftKnown === true) {
      this.#draftMetadataKnown.add(topicKey);
      return normalizeConversationDraft(row.draft);
    }
    // Some Tinode deployments omit private metadata in me.sub.
    return this.#draftMetadataKnown.has(topicKey) ? undefined : this.#records.get(topicKey)?.draft;
  }

  #writeDraft(topicKey: string, run: () => Promise<void>): Promise<void> {
    this.#draftRevisions.set(topicKey, (this.#draftRevisions.get(topicKey) ?? 0) + 1);
    const previous = this.#draftWrites.get(topicKey);
    const write = async () => {
      try { await run(); }
      finally {
        // Invalidate a metadata read started before this write settled.
        if (this.active && this.#records.has(topicKey)) this.#queueMetadata(topicKey, false);
      }
    };
    const task = previous ? previous.catch(() => {}).then(write) : write();
    this.#draftWrites.set(topicKey, task);
    const release = () => { if (this.#draftWrites.get(topicKey) === task) this.#draftWrites.delete(topicKey); };
    void task.then(release, release);
    return task;
  }

  #publishDraft(topicKey: string, draft: ConversationDraft | undefined): void {
    const previous = this.#records.get(topicKey);
    if (!this.active || !previous || previous.draft?.id === draft?.id) return;
    const record = Object.freeze({ ...previous, draft, revision: ++this.#revision });
    this.#records.set(topicKey, record);
    this.#emit(Object.freeze({ kind: 'chatUpsert', scope: this.account, record, revision: record.revision,
      updatedFields: Object.freeze(['draft'] as const) }));
  }

  reconcileForeground(): void {
    if (!this.active || this.#meTerminated) return;
    for (const { topic } of this.#muted.snapshot()) this.#queueMetadata(topic, true);
  }

  load(signal?: AbortSignal): Promise<ChatListLoadResult> {
    if (this.#disposed || !this.#scope.active) return Promise.reject(this.#closed());
    if (signal?.aborted) return Promise.reject(cancelled());
    if (this.#loadPromise) return this.#loadPromise;
    if (this.#meTerminated) {
      this.#meTerminated = false;
    }
    const generation = ++this.#generation;
    this.#cancelLoad();
    const controller = new AbortController();
    this.#loadAbort = controller;
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    this.#detachSignal = () => signal?.removeEventListener('abort', abort);
    const revision = ++this.#revision;
    this.#snapshotEvents = { baseRevision: revision, events: [], ownPushModes: new Map() };
    // Old replies cannot affect the new snapshot, even if they arrive before its metadata.
    this.#membershipEpoch += 1;
    this.#messageAbort.abort();
    this.#messageAbort = new AbortController();
    for (const job of [...this.#previewJobs.values()]) if (!job.started) this.#cancelPreview(job);
    this.#resetSenders();
    // Keep update listeners for visible authors active while the new snapshot is in flight.
    for (const record of this.#records.values()) {
      const sender = this.#lastMessage(record.preview)?.sender;
      if (record.kind === 'group' && sender && sender.state !== 'self' && sender.profileKey) this.#senderKeys.add(sender.profileKey);
    }
    this.#avatars.cancelPending();
    const pending = this.#read(generation, revision, controller).catch((reason: unknown) => {
      if (this.#meTerminated && this.active) throw this.#listUnavailable();
      if (reason instanceof DOMException && reason.name === 'AbortError') throw reason;
      throw failure(reason, 'list');
    }).finally(() => {
      if (this.#loadPromise === pending) {
        this.#loadPromise = undefined;
        this.#snapshotEvents = undefined;
        this.#pumpMessages();
      }
    });
    this.#loadPromise = pending;
    return pending;
  }

  async #read(generation: number, revision: number, controller: AbortController): Promise<ChatListLoadResult> {
    const signal = controller.signal;
    // desc and sub share the me subscription and run independently.
    const profile = this.refreshOwnProfile();
    try {
      await this.#wait(this.#attachMe(), signal);
      this.#assertCurrent(generation, signal);
      const response = await this.#scope.readChatList(signal);
      this.#assertCurrent(generation, signal);
      checkControl(response);
      const events = this.#snapshotEvents?.events ?? [];
      const rows = new Map<string, TinodeSessionObject>();
      if (Array.isArray(response.sub)) for (const row of response.sub) {
        if (isSessionObject(row) && typeof row.topic === 'string') rows.set(row.topic, row);
      }
      const snapshot = normalizeChatSubscriptions(response, revision).map(record => Object.freeze({
        ...record, draft: this.#subscriptionDraft(record.topicKey, rows.get(record.topicKey)),
        ...(this.#muteWorks.has(record.topicKey)
          ? { notificationsMuted: this.#records.get(record.topicKey)?.notificationsMuted } : {}),
      }));
      for (const record of snapshot) this.#confirmMutedGap(record.topicKey, record.serverSeq);
      const records = mergeChatListSnapshot(snapshot, events, revision);
      const topics = new Set(records.map(record => record.topicKey));
      const liveAvatars = new Set<string>();
      for (const event of events) if (event.revision > revision && event.kind === 'chatUpsert' &&
        (event.updatedFields === undefined || event.updatedFields.includes('metadata') || event.updatedFields.includes('avatar'))) {
        liveAvatars.add(event.record.topicKey);
      }
      const readable = new Map<string, boolean>();
      const readableRevisions = new Map<string, number>();
      if (Array.isArray(response.sub)) for (const row of response.sub) {
        if (isSessionObject(row) && typeof row.topic === 'string' && topics.has(row.topic)) {
          const permissions = normalizeChatPermissions(row.acs);
          if (permissions) { readable.set(row.topic, permissions.readable); readableRevisions.set(row.topic, revision); }
        }
      }
      for (const [key, value] of this.#readable) if (topics.has(key) && (this.#readableRevisions.get(key) ?? -1) > revision) {
        readable.set(key, value); readableRevisions.set(key, this.#readableRevisions.get(key)!);
      }
      for (const key of [...this.#records.keys()]) if (!topics.has(key)) this.#removeChat(key);
      this.#assertCurrent(generation, signal);
      this.#records = new Map(records.map(record => {
        if (record.preview.state !== 'pending') return [record.topicKey, record];
        if (this.#previewsPaused()) this.#pausedPreviews.add(record.topicKey);
        else if (!this.#muted.has(record.topicKey)) return [record.topicKey, record];
        const previous = this.#records.get(record.topicKey);
        const lastKnown = previous && this.#lastMessage(previous.preview);
        return [record.topicKey, lastKnown ? Object.freeze({ ...record,
          preview: Object.freeze({ state: 'pending' as const, lastKnown }) }) : record];
      }));
      this.#readable = readable;
      this.#readableRevisions = readableRevisions;
      // Use the full, confirmed list to retain attachments only for topics muted by this account.
      const ownPushModes = this.#snapshotEvents?.ownPushModes;
      const memberships = Array.isArray(response.sub) ? response.sub.flatMap(row => {
        if (!isSessionObject(row) || typeof row.topic !== 'string' || !topics.has(row.topic)) return [];
        const mode = ownPushModes?.get(row.topic);
        if (mode !== undefined) return [{ ...row, acs: { mode } }];
        // A concurrent snapshot must not add or release the muted interest before readback.
        if (this.#muteWorks.has(row.topic)) return [{ ...row, acs: { mode: this.#muted.has(row.topic) ? 'JR' : 'JRP' } }];
        return [row];
      }) : [];
      this.#muted.replace(memberships, topic => this.#departures.has(topic));
      for (const topic of this.#mutedGaps.keys()) {
        if (this.#muted.has(topic)) this.#dirtyMessages.add(topic);
        else this.#mutedGaps.delete(topic);
      }
      // Do not load an older photo source over metadata or an avatar received during the request.
      const sources = Array.isArray(response.sub) ? response.sub.filter(row =>
        isSessionObject(row) && typeof row.topic === 'string' && !liveAvatars.has(row.topic)) : [];
      this.#loadChatAvatars({ ...response, sub: sources }, this.#membershipEpoch);
      this.#releaseUnusedSenders();
      for (const record of this.#records.values()) {
        const message = this.#lastMessage(record.preview);
        if (message) this.#enrichSender(record.topicKey, message);
      }
      for (const [topicKey, seq] of this.#readSequences) this.#applyRead(topicKey, seq);
      for (const [topicKey, seq] of this.#messageSignals) this.#advanceServerSeq(topicKey, seq);
      return Object.freeze({ scope: this.#scope.account, revision,
        records: Object.freeze([...this.#records.values()]), ownProfile: this.#ownProfile });
    } finally {
      void profile.then(() => this.#release(controller));
    }
  }

  readonly #onPacket = (packet: TinodeSessionPacket): void => {
    if (!this.active) return;
    const p = packet.payload;
    if (packet.kind === 'ctrl' && p.code === 205) {
      if (p.topic === 'me') this.#terminateMe();
      else if (typeof p.topic === 'string' && this.#records.has(p.topic)) {
        if (isSessionObject(p.params) && p.params.unsub === true) this.#acceptChatDeparture(p.topic);
        else { this.#invalidatePreview(p.topic); this.#queueMetadata(p.topic, true); }
      }
      return;
    }
    if (this.#meTerminated) return;
    if (packet.kind === 'pres') {
      if (p.what === 'term' && p.topic === 'me' && (p.src === undefined || p.src === 'me' || p.src === this.#scope.account.uid)) {
        this.#terminateMe(); return;
      }
      if (p.what === 'upd' && p.topic === 'me' && (p.src === 'me' || p.src === this.#scope.account.uid)) {
        void this.refreshOwnProfile(); return;
      }
      const topicKey = p.topic === 'me' ? p.src : p.topic;
      if (typeof topicKey !== 'string' || !/^(?:usr|grp|chn)[A-Za-z0-9_-]+$/.test(topicKey)) return;
      if (p.what === 'gone') { this.#acceptChatDeparture(topicKey); return; }
      if (p.what === 'upd' || p.what === 'acs' || p.what === 'term' || p.what === 'del') {
        if (p.what === 'acs' && typeof p.tgt === 'string' && p.tgt !== this.#scope.account.uid) return;
        if (p.what === 'del' || p.what === 'term') this.#invalidatePreview(topicKey);
        if (p.what === 'upd' && this.#senderKeys.has(topicKey)) this.#refreshSender(topicKey);
        this.#queueMetadata(topicKey, p.what !== 'upd');
        return;
      }
      if (p.topic !== 'me') return;
      const sequence = normalizeChatSequence(p.seq);
      if (sequence.state !== 'known' || sequence.value === 0) return;
      if (p.what === 'msg') {
        this.#signalMessage(topicKey, sequence.value);
      } else if (p.what === 'read' || p.what === 'recv') {
        if (!this.#records.has(topicKey) && !this.#loadPromise) return;
        if (p.what === 'read') {
          const read = Math.max(this.#readSequences.get(topicKey) ?? 0, sequence.value);
          this.#readSequences.set(topicKey, read);
          this.#recvSequences.set(topicKey, Math.max(this.#recvSequences.get(topicKey) ?? 0, read));
          this.#applyRead(topicKey, read);
        } else this.#recvSequences.set(topicKey, Math.max(this.#recvSequences.get(topicKey) ?? 0, sequence.value));
      }
    } else if (packet.kind === 'meta' && p.id === undefined) {
      // Our getMeta promises handle their own replies. Do not apply them again here.
      if (p.topic === 'me' && Array.isArray(p.sub)) {
        try { for (const row of p.sub) {
          if (!isSessionObject(row) || typeof row.topic !== 'string') continue;
          if (row.deleted !== undefined && row.deleted !== null && row.deleted !== false) {
            if (row.deleted === true || normalizeServerTimestamp(row.deleted)) this.#acceptChatDeparture(row.topic);
          } else this.#queueMetadata(row.topic, false);
        } } catch { this.#emitUnavailable(); }
      }
      if (isSessionObject(p.desc)) {
        if (p.topic === 'me' || p.topic === this.#scope.account.uid) void this.refreshOwnProfile();
        else if (typeof p.topic === 'string') {
          if (this.#senderKeys.has(p.topic)) this.#refreshSender(p.topic);
          this.#queueMetadata(p.topic, false);
        }
      }
    } else if (packet.kind === 'data' && typeof p.topic === 'string' && this.#records.has(p.topic)) {
      if (this.#previewSession.blocked.has(p.topic) || this.#readable.get(p.topic) === false) return;
      // The history request owns all data packets until cleanup completes, even if the caller has cancelled.
      // Otherwise, a packet after the count response but before leave could be mistaken for a live message.
      const readingPreview = this.#previewJobs.has(p.topic);
      const muted = this.#muted.has(p.topic);
      if (readingPreview && !muted) return;
      try {
        const { message, replaces } = normalizePreviewMessage(p, p.topic, this.#scope.account.uid);
        const record = this.#records.get(p.topic)!;
        if (message.seq <= (this.#previewHeads.get(p.topic) ?? 0) ||
          (record.serverSeq.state === 'known' && message.seq < record.serverSeq.value)) return;
        if (muted && (this.#mutedGaps.has(p.topic) || record.serverSeq.state === 'unknown' ||
          message.seq > record.serverSeq.value + 1)) this.#recordMutedGap(p.topic, message.seq);
        if (readingPreview || [...this.#topicReservations].some(state => state.topics.has(p.topic as string))) return;
        if (replaces !== undefined) {
          this.#signalMessage(p.topic, message.seq);
          return;
        }
        this.#previewHeads.set(p.topic, message.seq);
        this.#updatePreview(p.topic, Object.freeze({ state: 'available', message }));
        this.#enrichSender(p.topic, message);
      } catch { /* Ignore malformed packets so they cannot replace a confirmed message. */ }
    }
  };

  #listUnavailable(): ChatListFailure {
    return new ChatListFailure({ kind: 'unavailable', area: 'list', messageCode: 'chatListUnavailable', retryable: true });
  }

  #emitUnavailable(): void {
    this.#emit(Object.freeze({ kind: 'unavailable', scope: this.#scope.account,
      revision: ++this.#revision, error: this.#listUnavailable().chatListError }));
  }

  #terminateMe(): void {
    if (this.#meTerminated) return;
    this.#meTerminated = true;
    this.#meAttached = false;
    this.#muted.clear();
    this.#mutedGaps.clear();
    this.#meVersion += 1;
    this.#attachPromise = undefined;
    this.#membershipEpoch += 1;
    this.#ownVersion += 1;
    this.#ownDirty = false;
    if (this.#ownProfile.state !== 'available') {
      this.#publishOwnProfile(Object.freeze({ state: 'unavailable',
        error: Object.freeze({ kind: 'unavailable', area: 'profile',
          messageCode: 'chatProfileUnavailable', retryable: false }) }));
    }
    // The controller cancels its interests first, keeping cards and manual retry available.
    this.#emitUnavailable();
    this.#cancelLoad();
    this.#messageAbort.abort();
    this.#dirtyMessages.clear();
    this.#forcePreviews.clear();
    for (const job of [...this.#previewJobs.values()]) this.#cancelPreview(job);
    this.#resetSenders();
    this.#avatars.clear();
  }

  #acceptChatDeparture(topicKey: string): void {
    this.#scope.confirmChatUnsubscribed(topicKey);
    // Retain one removal event during a snapshot, even if the old card was already absent.
    if (!this.#records.has(topicKey) &&
      (!this.#snapshotEvents || this.#snapshotEvents.events.some(event => event.kind === 'chatRemoved' && event.topicKey === topicKey))) return;
    this.#removeChat(topicKey);
  }

  #removeChat(topicKey: string): void {
    if (!/^(?:usr|grp|chn)[A-Za-z0-9_-]+$/.test(topicKey)) return;
    this.#muted.remove(topicKey);
    this.#mutedGaps.delete(topicKey);
    this.#draftMetadataKnown.delete(topicKey);
    this.#topicVersions.set(topicKey, (this.#topicVersions.get(topicKey) ?? 0) + 1);
    this.#metadataVersions.set(topicKey, (this.#metadataVersions.get(topicKey) ?? 0) + 1);
    this.#records.delete(topicKey);
    this.#pausedPreviews.delete(topicKey);
    this.#readable.delete(topicKey);
    this.#readableRevisions.delete(topicKey);
    this.#messageSignals.delete(topicKey);
    this.#previewHeads.delete(topicKey);
    this.#readSequences.delete(topicKey); this.#scope.forgetRead(topicKey);
    this.#recvSequences.delete(topicKey);
    this.#dirtyMessages.delete(topicKey);
    this.#forcePreviews.delete(topicKey);
    const job = this.#previewJobs.get(topicKey);
    if (job) this.#cancelPreview(job);
    this.#avatars.release('chat:' + topicKey);
    this.#releaseUnusedSenders();
    this.#emit(Object.freeze({ kind: 'chatRemoved', scope: this.#scope.account,
      topicKey, revision: ++this.#revision }));
  }

  #invalidatePreview(topicKey: string, discardLastKnown = true): void {
    this.#topicVersions.set(topicKey, (this.#topicVersions.get(topicKey) ?? 0) + 1);
    this.#previewHeads.delete(topicKey);
    const job = this.#previewJobs.get(topicKey);
    // Let an in-flight response drain before a new reader can attach to this topic.
    if (job && !job.started) this.#cancelPreview(job);
    const record = this.#records.get(topicKey);
    if (record) {
      if (this.#previewsPaused()) this.#pausedPreviews.add(topicKey);
      const preview = discardLastKnown ? Object.freeze({ state: 'pending' as const }) : this.#pendingPreview(record);
      this.#updatePreview(topicKey, preview);
    }
    this.#releaseUnusedSenders();
  }

  #queueMetadata(topicKey: string, force: boolean): void {
    if (!/^(?:usr|grp|chn)[A-Za-z0-9_-]+$/.test(topicKey)) return;
    this.#metadataVersions.set(topicKey, (this.#metadataVersions.get(topicKey) ?? 0) + 1);
    if (force) this.#forcePreviews.add(topicKey);
    this.#dirtyMessages.add(topicKey);
    this.#pumpMessages();
  }

  #topicCurrent(topicKey: string, epoch: number, version: number): boolean {
    return this.#profileCurrent(epoch) && (this.#topicVersions.get(topicKey) ?? 0) === version;
  }

  #lastMessage(preview: LastMessagePreview): LastMessage | undefined {
    return preview.state === 'available' ? preview.message
      : preview.state === 'unavailable' || preview.state === 'pending' ? preview.lastKnown : undefined;
  }

  #applyRead(topicKey: string, seq: number): void {
    const record = this.#records.get(topicKey);
    if (!record || (record.readSeq.state === 'known' && record.readSeq.value >= seq)) return;
    const readSeq = Object.freeze({ state: 'known' as const, value: seq });
    const revision = ++this.#revision;
    this.#records.set(topicKey, Object.freeze({ ...record, readSeq,
      unread: unreadCount(record.serverSeq, readSeq), revision }));
    this.#emit(Object.freeze({ kind: 'readUpdated', scope: this.#scope.account,
      topicKey, readSeq, revision }));
  }

  #advanceServerSeq(topicKey: string, seq: number): void {
    const record = this.#records.get(topicKey);
    if (!record || (record.serverSeq.state === 'known' && record.serverSeq.value >= seq)) return;
    const serverSeq = Object.freeze({ state: 'known' as const, value: seq });
    const updated = Object.freeze({ ...record, serverSeq,
      unread: unreadCount(serverSeq, record.readSeq), revision: ++this.#revision });
    this.#records.set(topicKey, updated);
    this.#emit(Object.freeze({ kind: 'chatUpsert', scope: this.#scope.account,
      record: updated, revision: updated.revision, updatedFields: Object.freeze(['serverSeq'] as const) }));
  }

  #signalMessage(topicKey: string, seq: number): void {
    if (seq <= (this.#messageSignals.get(topicKey) ?? 0)) return;
    const record = this.#records.get(topicKey);
    if (record && this.#muted.has(topicKey) &&
      (this.#mutedGaps.has(topicKey) || record.serverSeq.state === 'unknown' || seq > record.serverSeq.value + 1)) {
      this.#recordMutedGap(topicKey, seq);
      return;
    }
    this.#messageSignals.set(topicKey, seq);
    this.#advanceServerSeq(topicKey, seq);
    if (this.#previewsPaused() && this.#records.has(topicKey)) this.#deferTopic(topicKey);
    this.#dirtyMessages.add(topicKey);
    this.#pumpMessages();
  }

  #recordMutedGap(topic: string, seq: number): void {
    if (seq <= (this.#mutedGaps.get(topic) ?? 0)) return;
    this.#mutedGaps.set(topic, seq);
    this.#dirtyMessages.add(topic);
    this.#pumpMessages();
  }

  #confirmMutedGap(topic: string, seq: ChatSequence): void {
    const expected = this.#mutedGaps.get(topic);
    if (expected !== undefined && seq.state === 'known' && seq.value >= expected) this.#mutedGaps.delete(topic);
  }

  #pumpMessages(): void {
    if (!this.active || this.#meTerminated || !this.#meAttached || this.#snapshotEvents) return;
    for (const topicKey of this.#dirtyMessages) {
      if (this.#updatingMessages.size >= 2) break;
      if (this.#updatingMessages.has(topicKey) || this.#muteWorks.has(topicKey) || this.#departures.has(topicKey)) continue;
      this.#dirtyMessages.delete(topicKey);
      this.#updatingMessages.add(topicKey);
      const epoch = this.#membershipEpoch;
      void this.#refreshMessage(topicKey, epoch).finally(() => {
        this.#updatingMessages.delete(topicKey);
        this.#pumpMessages();
      });
    }
  }

  async #refreshMessage(topicKey: string, epoch: number, requireSubscription = false): Promise<void> {
    const version = this.#topicVersions.get(topicKey) ?? 0;
    const metadataVersion = this.#metadataVersions.get(topicKey) ?? 0;
    const force = this.#forcePreviews.has(topicKey);
    try {
      const response = await this.#previewDeadline(this.#scope.getMeta('me', {
        what: 'sub', sub: { topic: topicKey },
      }), this.#messageAbort.signal);
      if (!this.#topicCurrent(topicKey, epoch, version) ||
        (this.#metadataVersions.get(topicKey) ?? 0) !== metadataVersion) return;
      checkControl(response);
      const metadata = normalizeChatSubscriptions(response, this.#revision).find(r => r.topicKey === topicKey);
      if (!metadata) {
        if (requireSubscription) throw new TinodeSessionFailure('invalidResponse');
        this.#removeChat(topicKey); return;
      }
      const row = Array.isArray(response.sub) ? response.sub.find(r => isSessionObject(r) && r.topic === topicKey) : undefined;
      this.#muted.update(row);
      if (this.#muted.has(topicKey)) this.#confirmMutedGap(topicKey, metadata.serverSeq);
      else this.#mutedGaps.delete(topicKey);
      const permissions = normalizeChatPermissions(isSessionObject(row) ? row.acs : undefined);
      if (permissions) this.#readable.set(topicKey, permissions.readable);
      const previous = this.#records.get(topicKey);
      const serverSeq = previous ? this.#maxSequence(previous.serverSeq, metadata.serverSeq) : metadata.serverSeq;
      const readSeq = previous ? this.#maxSequence(previous.readSeq, metadata.readSeq) : metadata.readSeq;
      // Tinode also changes touched when an old message is edited. Only the resolved preview sets its date.
      const lastActivityAt = previous?.lastActivityAt ?? metadata.lastActivityAt;
      const updated = Object.freeze({ ...metadata, serverSeq, readSeq, draft: this.#subscriptionDraft(topicKey, row),
        notificationsMuted: metadata.notificationsMuted ?? previous?.notificationsMuted,
        unread: unreadCount(serverSeq, readSeq), lastActivityAt,
        preview: previous?.preview ?? metadata.preview, revision: ++this.#revision });
      this.#records.set(topicKey, updated);
      if (permissions) this.#readableRevisions.set(topicKey, updated.revision);
      this.#emit(Object.freeze({ kind: 'chatUpsert', scope: this.#scope.account, record: updated,
        revision: updated.revision, updatedFields: Object.freeze(['metadata', 'avatar', 'notificationsMuted', 'draft', 'serverSeq', 'readSeq', 'activity'] as const) }));
      this.#loadChatAvatars(response, epoch);
      if (permissions?.readable === false) {
        this.#invalidatePreview(topicKey);
        this.#updatePreview(topicKey, Object.freeze({ state: 'unavailable', error: failure(new TinodeSessionFailure('rejected', 403), 'preview').chatListError }));
        this.#forcePreviews.delete(topicKey);
        return;
      }
      if (this.#previewsPaused()) {
        if (this.#needsPreview(updated, force)) this.#deferTopic(topicKey);
        else if ((this.#metadataVersions.get(topicKey) ?? 0) === metadataVersion) this.#forcePreviews.delete(topicKey);
        return;
      }
      const running = this.#previewJobs.get(topicKey);
      if (running) await running.finished;
      if (!this.#topicCurrent(topicKey, epoch, version) || !this.#records.has(topicKey) ||
        (this.#metadataVersions.get(topicKey) ?? 0) !== metadataVersion) return;
      const current = this.#records.get(topicKey)!;
      if (this.#needsPreview(current, force)) {
        const result = await this.loadPreview(topicKey);
        if (result.preview.state === 'pending') return;
      }
      if (!this.#topicCurrent(topicKey, epoch, version) || !this.#records.has(topicKey)) return;
      if ((this.#metadataVersions.get(topicKey) ?? 0) === metadataVersion) this.#forcePreviews.delete(topicKey);
      const confirmedHead = this.#previewHeads.get(topicKey);
      if (confirmedHead !== undefined && confirmedHead >= (this.#messageSignals.get(topicKey) ?? 0) &&
        !this.#mutedGaps.has(topicKey) &&
        (this.#metadataVersions.get(topicKey) ?? 0) === metadataVersion) this.#dirtyMessages.delete(topicKey);
    } catch (reason: unknown) {
      if (requireSubscription) throw reason;
      if (!this.#topicCurrent(topicKey, epoch, version) ||
        (this.#metadataVersions.get(topicKey) ?? 0) !== metadataVersion) return;
      const record = this.#records.get(topicKey);
      if (record) this.#updatePreview(topicKey, this.#unavailablePreview(failure(reason, 'preview'), record));
      else this.#emitUnavailable();
    }
  }

  #needsPreview(record: ChatRecord, force: boolean): boolean {
    const signal = this.#messageSignals.get(record.topicKey) ?? 0;
    const expected = Math.max(signal, record.serverSeq.state === 'known' ? record.serverSeq.value : 0);
    const head = this.#previewHeads.get(record.topicKey) ?? 0;
    return force || (record.preview.state !== 'empty' && record.preview.state !== 'available') || head < expected;
  }

  #maxSequence(previous: ChatSequence, next: ChatSequence): ChatSequence {
    return previous.state === 'known' && next.state === 'known'
      ? Object.freeze({ state: 'known', value: Math.max(previous.value, next.value) }) : next;
  }

  #attachMe(): Promise<void> {
    if (this.#meAttached) return Promise.resolve();
    if (this.#attachPromise) return this.#attachPromise;
    const version = this.#meVersion;
    const pending = this.#scope.subscribe('me').then((response) => {
      checkControl(response);
      const code = response.code;
      if (typeof code !== 'number' || !((code >= 200 && code < 300) || code === 304)) {
        throw new TinodeSessionFailure('invalidResponse');
      }
      if (version !== this.#meVersion || this.#meTerminated) throw this.#listUnavailable();
      if (!this.#disposed && this.#scope.active) this.#meAttached = true;
    }).finally(() => {
      if (this.#attachPromise === pending) this.#attachPromise = undefined;
    });
    this.#attachPromise = pending;
    return pending;
  }

  refreshOwnProfile(): Promise<void> {
    if (!this.active || this.#meTerminated) return Promise.resolve();
    this.#ownVersion += 1;
    this.#ownDirty = true;
    if (this.#ownPromise) return this.#ownPromise;
    const pending = (async () => {
      try {
        while (this.#ownDirty && this.active && !this.#meTerminated) {
          this.#ownDirty = false;
          await this.#readProfile(this.#generation, this.#messageAbort.signal, this.#ownVersion);
        }
      } finally {
        this.#ownPromise = undefined;
      }
    })();
    this.#ownPromise = pending;
    return pending;
  }

  async #readProfile(generation: number, signal: AbortSignal, version: number): Promise<void> {
    let profile: CurrentUserProfile;
    let publicProfile: unknown;
    try {
      this.#assertCurrent(generation, signal);
      if (!this.#meAttached) {
        await this.#wait(this.#attachMe(), signal);
        this.#assertCurrent(generation, signal);
      }
      const response = await this.#wait(this.#scope.getMeta('me', { what: 'desc', desc: {} }), signal);
      this.#assertCurrent(generation, signal);
      checkControl(response);
      profile = normalizeOwnProfile(response);
      publicProfile = isSessionObject(response.desc) ? response.desc.public : undefined;
    } catch (reason: unknown) {
      if (!this.#current(generation, signal) || this.#ownProfile.state === 'available') return;
      profile = Object.freeze({ state: 'unavailable', error: failure(reason, 'profile').chatListError });
    }
    if (!this.#current(generation, signal) || this.#ownVersion !== version) return;
    this.#publishOwnProfile(profile);
    if (profile.state === 'available') {
      const initial = profile;
      void this.#avatars.load('own', publicProfile).then((avatar) => {
        if (!this.#current(generation, signal) || this.#ownProfile !== initial ||
          (avatar.state !== 'ready' && avatar.state === initial.avatar.state)) return;
        this.#publishOwnProfile(Object.freeze({ ...initial, avatar }));
      });
    }
  }

  #publishOwnProfile(profile: CurrentUserProfile): void {
    this.#ownProfile = profile;
    this.#emit(Object.freeze({ kind: 'ownProfileUpdated', scope: this.#scope.account,
      revision: ++this.#revision, profile }));
  }

  #loadChatAvatars(response: TinodeSessionObject, epoch: number): void {
    const sources = new Map<string, { version?: number; publicProfile: unknown }>();
    if (Array.isArray(response.sub)) {
      for (const row of response.sub) {
        if (!isSessionObject(row) || typeof row.topic !== 'string' || !this.#records.has(row.topic)) continue;
        const dates = [normalizeServerTimestamp(row.updated), normalizeServerTimestamp(row.deleted)]
          .filter((date): date is string => date !== undefined);
        const version = dates.length ? Math.max(...dates.map((date) => Date.parse(date))) : undefined;
        const previous = sources.get(row.topic);
        if (previous?.version !== undefined && version !== undefined && previous.version > version) continue;
        sources.set(row.topic, { version, publicProfile: row.public });
      }
    }
    for (const [topicKey, source] of sources) {
      const version = this.#topicVersions.get(topicKey) ?? 0;
      const expected = this.#records.get(topicKey)?.avatar;
      void this.#avatars.load('chat:' + topicKey, source.publicProfile).then((avatar) => {
        if (!this.#topicCurrent(topicKey, epoch, version)) return;
        const record = this.#records.get(topicKey);
        if (!record || record.avatar !== expected || (avatar.state !== 'ready' && avatar.state === record.avatar.state)) return;
        const updated = Object.freeze({ ...record, avatar, revision: ++this.#revision });
        this.#records.set(topicKey, updated);
        this.#emit(Object.freeze({ kind: 'chatUpsert', scope: this.#scope.account,
          revision: updated.revision, record: updated, updatedFields: Object.freeze(['avatar'] as const) }));
      });
    }
  }

  #profileCurrent(epoch: number): boolean {
    return !this.#disposed && !this.#meTerminated && this.#scope.active && this.#membershipEpoch === epoch;
  }

  #resetSenders(): void {
    this.#profileRequests.clear();
    for (const controller of this.#senderControllers.values()) controller.abort();
    this.#senderControllers.clear();
    this.#senderVersions.clear();
    this.#senderDirty.clear();
    this.#profiles.clear();
    this.#previewProfileKeys.clear();
    for (const key of this.#senderKeys) this.#avatars.release('sender:' + key);
    this.#senderKeys.clear();
  }

  #releaseUnusedSenders(): void {
    const used = new Set<string>();
    for (const record of this.#records.values()) {
      const sender = this.#lastMessage(record.preview)?.sender;
      if (record.kind === 'group' && sender && sender.state !== 'self' && sender.profileKey) used.add(sender.profileKey);
    }
    for (const key of this.#senderKeys) if (!used.has(key)) {
      this.#senderControllers.get(key)?.abort();
      this.#senderControllers.delete(key);
      this.#senderVersions.set(key, (this.#senderVersions.get(key) ?? 0) + 1);
      this.#senderDirty.delete(key);
      this.#profiles.delete(key);
      this.#previewProfileKeys.delete(key);
      this.#avatars.release('sender:' + key);
      this.#senderKeys.delete(key);
    }
  }

  #refreshSender(key: string): void {
    this.#senderVersions.set(key, (this.#senderVersions.get(key) ?? 0) + 1);
    this.#senderDirty.add(key);
    this.#profiles.delete(key);
    this.#startSender(key);
  }

  #startSender(key: string): void {
    if (!this.active || this.#meTerminated || !this.#senderKeys.has(key)) return;
    if ([...this.#topicReservations].some(state => state.topics.has(key))) { this.#senderDirty.add(key); return; }
    if (this.#profileRequests.has(key)) {
      if (this.#senderControllers.get(key)?.signal.aborted) this.#senderDirty.add(key);
      return;
    }
    this.#senderDirty.delete(key);
    const controller = new AbortController();
    this.#senderControllers.set(key, controller);
    const epoch = this.#membershipEpoch;
    const version = this.#senderVersions.get(key) ?? 0;
    const pending = this.#readSender(key, epoch, controller.signal, version).finally(() => {
      if (this.#profileRequests.get(key) === pending) this.#profileRequests.delete(key);
      if (this.#senderControllers.get(key) === controller) this.#senderControllers.delete(key);
      if (this.#senderDirty.has(key)) this.#startSender(key);
    });
    this.#profileRequests.set(key, pending);
  }

  #enrichSender(topicKey: string, message: LastMessage): void {
    if (this.#records.get(topicKey)?.kind !== 'group' || message.sender.state === 'self' || !message.sender.profileKey) return;
    const key = message.sender.profileKey;
    this.#senderKeys.add(key);
    const cached = this.#profiles.get(key);
    if (cached) this.#applySender(cached, this.#membershipEpoch);
    else this.#startSender(key);
  }

  async #readSender(key: string, epoch: number, signal: AbortSignal, version: number): Promise<void> {
    let publicProfile: unknown;
    let profile: SenderProfile;
    try {
      const response = await this.#previewDeadline(
        this.#trackTopicRead(key, this.#scope.getMeta(key, { what: 'desc', desc: {} })), signal,
      );
      checkControl(response);
      if (response.topic !== key || !isSessionObject(response.desc) || 'code' in response) {
        throw new TinodeSessionFailure('invalidResponse');
      }
      publicProfile = response.desc.public;
      profile = Object.freeze({ profileKey: key, displayName: normalizeChatTitle(publicProfile),
        avatar: this.#avatars.state(publicProfile) });
    } catch {
      profile = Object.freeze({ profileKey: key, displayName: Object.freeze({ state: 'unknown' }),
        avatar: Object.freeze({ state: 'unavailable' }) });
    }
    if (!this.#profileCurrent(epoch) || signal.aborted || (this.#senderVersions.get(key) ?? 0) !== version) return;
    this.#profiles.set(key, profile);
    this.#applySender(profile, epoch);
    if (!this.#previewProfileKeys.has(key) || profile.avatar.state !== 'pending') return;
    const initial = profile;
    const avatar = await this.#avatars.load('sender:' + key, publicProfile);
    if (!this.#profileCurrent(epoch) || signal.aborted || (this.#senderVersions.get(key) ?? 0) !== version || this.#profiles.get(key) !== initial) return;
    profile = Object.freeze({ ...initial, avatar });
    this.#profiles.set(key, profile);
    this.#applySender(profile, epoch);
  }

  #senderFromProfile(profile: SenderProfile): MessageSender {
    const avatar = this.#previewProfileKeys.has(profile.profileKey) ? { avatar: profile.avatar } : {};
    return profile.displayName.state === 'known'
      ? Object.freeze({ state: 'known', profileKey: profile.profileKey, displayName: profile.displayName.text, ...avatar })
      : Object.freeze({ state: 'unknown', profileKey: profile.profileKey, ...avatar });
  }

  #capturePreviewProfile(key: string, publicProfile: TinodeSessionObject): void {
    const epoch = this.#membershipEpoch;
    if (!this.#profileCurrent(epoch)) return;
    this.#senderKeys.add(key);
    this.#previewProfileKeys.add(key);
    this.#senderControllers.get(key)?.abort();
    this.#senderDirty.delete(key);
    const version = (this.#senderVersions.get(key) ?? 0) + 1;
    this.#senderVersions.set(key, version);
    const profile: SenderProfile = Object.freeze({ profileKey: key, displayName: normalizeChatTitle(publicProfile),
      avatar: this.#avatars.state(publicProfile) });
    this.#profiles.set(key, profile);
    this.#applySender(profile, epoch);
    if (profile.avatar.state === 'pending') void this.#avatars.load('sender:' + key, publicProfile).then(avatar => {
      if (!this.#profileCurrent(epoch) || this.#profiles.get(key) !== profile || this.#senderVersions.get(key) !== version) return;
      const ready = Object.freeze({ ...profile, avatar });
      this.#profiles.set(key, ready);
      this.#applySender(ready, epoch);
    });
  }

  #applySender(profile: SenderProfile, epoch: number): void {
    if (!this.#profileCurrent(epoch)) return;
    this.#emit(Object.freeze({ kind: 'profileUpdated', scope: this.#scope.account,
      revision: ++this.#revision, profile }));
    for (const record of this.#records.values()) {
      if (!this.#profileCurrent(epoch)) return;
      if (record.kind !== 'group') continue;
      const preview = record.preview;
      const message = this.#lastMessage(preview);
      if (!message || message.sender.state === 'self' || message.sender.profileKey !== profile.profileKey) continue;
      const sender = this.#senderFromProfile(profile);
      const before = message.sender.avatar, after = sender.avatar;
      const sameAvatar = before?.state === after?.state && (before?.state !== 'ready' ||
        (after?.state === 'ready' && before.imageSource === after.imageSource));
      if (sameAvatar && message.sender.state === sender.state && (message.sender.state !== 'known' ||
        (sender.state === 'known' && sender.displayName === message.sender.displayName))) continue;
      const updated = Object.freeze({ ...message, sender });
      this.#updatePreview(record.topicKey, preview.state === 'available'
        ? Object.freeze({ state: 'available', message: updated })
        : Object.freeze({ ...preview, lastKnown: updated }));
    }
  }

  loadPreview(topicKey: string, signal?: AbortSignal): Promise<ChatPreviewResult> {
    if (this.#disposed || !this.#scope.active) return Promise.reject(this.#closed('preview'));
    if (signal?.aborted) return Promise.reject(cancelled());
    const record = this.#records.get(topicKey);
    if (this.#meTerminated) return Promise.reject(this.#listUnavailable());
    if (!record) return Promise.reject(this.#previewUnavailable(false));
    if (this.#readable.get(topicKey) === false) return Promise.resolve(this.#updatePreview(topicKey,
      Object.freeze({ state: 'unavailable', error: failure(new TinodeSessionFailure('rejected', 403), 'preview').chatListError })));
    if (this.#departures.has(topicKey)) return Promise.reject(cancelled());
    if (this.#previewsPaused()) return Promise.resolve(this.#deferTopic(topicKey));
    const mute = topicKey.startsWith('chn') ? this.#muteWorks.get(topicKey) : undefined;
    if (mute) return (signal ? this.#wait(mute, signal) : mute).then(() => this.loadPreview(topicKey, signal));
    const previousJob = this.#previewJobs.get(topicKey) ?? this.#previewDrains.get(topicKey);
    if (previousJob) {
      if (!previousJob.settled && previousJob.epoch === this.#membershipEpoch && !previousJob.abort.signal.aborted &&
        previousJob.topicVersion === (this.#topicVersions.get(topicKey) ?? 0)) return previousJob.promise;
      // Cancelling interest does not confirm that the previous history stream has detached.
      const drained = signal ? this.#wait(previousJob.finished, signal) : previousJob.finished;
      return drained.then(() => this.loadPreview(topicKey, signal));
    }
    if (this.#previewSession.blocked.has(topicKey) || this.#scope.isTopicAttachmentBlocked(topicKey)) {
      return Promise.resolve(this.#updatePreview(topicKey, this.#unavailablePreview(
        this.#previewUnavailable(false), record,
      )));
    }
    let resolve!: PreviewJob['resolve'];
    let reject!: PreviewJob['reject'];
    const promise = new Promise<ChatPreviewResult>((done, fail) => { resolve = done; reject = fail; });
    let finish!: () => void;
    const finished = new Promise<void>(done => { finish = done; });
    const job: PreviewJob = { topicKey, epoch: this.#membershipEpoch,
      topicVersion: this.#topicVersions.get(topicKey) ?? 0, finished, finish, previous: record,
      abort: new AbortController(), promise, resolve, reject, detach: () => {},
      started: false, settled: false, queryStarted: false, drained: false };
    const abort = () => this.#cancelPreview(job);
    signal?.addEventListener('abort', abort, { once: true });
    job.detach = () => signal?.removeEventListener('abort', abort);
    this.#previewJobs.set(topicKey, job);
    this.#previewQueue.push(job);
    if (record.preview.state !== 'pending') {
      const pending = this.#muted.has(topicKey) ? this.#pendingPreview(record) : Object.freeze({ state: 'pending' as const });
      this.#updatePreview(topicKey, pending);
    }
    this.#pumpPreviews();
    return promise;
  }

  #previewUnavailable(retryable: boolean): ChatListFailure {
    return new ChatListFailure({ kind: 'unavailable', area: 'preview',
      messageCode: 'chatPreviewUnavailable', retryable });
  }

  #previewCurrent(job: PreviewJob): boolean {
    return !this.#disposed && this.#scope.active && job.epoch === this.#membershipEpoch &&
      this.#records.has(job.topicKey) && !this.#meTerminated &&
      (this.#topicVersions.get(job.topicKey) ?? 0) === job.topicVersion;
  }

  #cancelPreview(job: PreviewJob): void {
    job.abort.abort();
    if (!job.settled) {
      job.settled = true;
      job.reject(this.#disposed || !this.#scope.active ? this.#closed('preview') : cancelled());
    }
    if (!job.started) {
      this.#previewQueue = this.#previewQueue.filter((entry) => entry !== job);
      if (this.#previewJobs.get(job.topicKey) === job) this.#previewJobs.delete(job.topicKey);
      job.detach();
      job.finish();
    }
  }

  #pumpPreviews(): void {
    if (this.#disposed || !this.#scope.active || this.#previewsPaused()) return;
    while (!this.#previewsPaused() && this.#previewRunning < 2 && this.#previewQueue.length > 0) {
      const job = this.#previewQueue.shift()!;
      if (this.#departures.has(job.topicKey) || !this.#previewCurrent(job) || job.abort.signal.aborted) {
        this.#cancelPreview(job);
        continue;
      }
      job.started = true;
      this.#previewDrains.set(job.topicKey, job);
      this.#previewRunning += 1;
      const finish = () => {
        this.#previewRunning -= 1;
        if (this.#previewDrains.get(job.topicKey) === job) this.#previewDrains.delete(job.topicKey);
        if (this.#previewJobs.get(job.topicKey) === job) this.#previewJobs.delete(job.topicKey);
        job.detach();
        job.finish();
        this.#releasePreviewOwner();
        this.#pumpPreviews();
      };
      void this.#readPreview(job).then(finish, finish);
    }
  }

  async #readPreview(job: PreviewJob): Promise<void> {
    let first: PreviewFrame | undefined;
    let latest: LastMessage | undefined;
    const combined = job.previous.kind === 'group' && !job.topicKey.startsWith('chn');
    let participants: { readonly id: string; readonly rows: readonly unknown[] } | undefined;
    let completionCount: number | undefined;
    let requestId: string | undefined;
    const pendingControls = new Map<string, TinodeSessionObject>();
    const pendingAcks = new Set<string>();
    let problem: unknown;
    let interest: TinodeTopicInterest | undefined;
    let physicalAttach = true;
    let attachAttempted = false;
    let attachComplete = false;
    let detachComplete = false;
    let wake!: () => void;
    let failStream!: (reason: unknown) => void;
    let stop!: (reason: unknown) => void;
    const stream = new Promise<void>((resolve, reject) => { wake = resolve; failStream = reject; });
    const interrupted = new Promise<never>((_, reject) => { stop = reject; });
    // Handle rejection before awaiting the stream to avoid an unhandled promise rejection.
    void stream.catch(() => {});
    void interrupted.catch(() => {});
    const invalid = () => new TinodeSessionFailure('invalidResponse');
    const fail = (reason: unknown) => { problem ??= reason; failStream(reason); };
    const tryFinish = () => {
      if (attachComplete) interest?.attached();
      if (completionCount === 0 || (completionCount === 1 && first !== undefined)) {
        job.drained = true;
        if (attachComplete) wake();
      }
    };
    const acceptAck = (control: TinodeSessionObject) => {
      const what = isSessionObject(control.params) ? control.params.what : undefined;
      if (typeof control.id !== 'string' || control.id === '' || typeof control.code !== 'number' ||
        !((control.code >= 200 && control.code < 300) || control.code === 304) || what !== undefined) return;
      if (requestId === undefined) { pendingAcks.add(control.id); return; }
      if (control.id !== requestId) return;
      attachComplete = true;
      tryFinish();
    };
    const acceptCompletion = (control: TinodeSessionObject) => {
      const part = isSessionObject(control.params) ? control.params.what : undefined;
      // sub fetches optional profiles. Its failure does not mean the history read failed.
      if (combined && (part === 'sub' || (typeof control.code === 'number' && control.code >= 400 && part !== 'data'))) return;
      if (typeof control.id !== 'string' || control.id === '') return;
      if (requestId === undefined) {
        // The SDK can call onMessage for the entire response before the subscribe promise's then handler runs.
        pendingControls.set(control.id, control);
        return;
      }
      if (control.id !== requestId) return;
      try {
        checkControl(control);
        const params = control.params;
        if ((control.code !== 204 && control.code !== 208) ||
          !isSessionObject(params) || params.what !== 'data') throw invalid();
        const count = params.count === undefined && control.code === 204 ? 0 : params.count;
        if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > 1) throw invalid();
        completionCount = count;
        tryFinish();
      } catch (reason: unknown) {
        // A nested get failure after successful attach arrives as a separate control packet.
        if (previewRequestRejected(reason)) job.drained = true;
        fail(reason);
      }
    };
    const offPackets = this.#scope.subscribePackets((packet) => {
      if (!job.queryStarted || packet.payload.topic !== job.topicKey) return;
      if (packet.kind === 'ctrl') {
        acceptAck(packet.payload);
        const params = packet.payload.params;
        if ((isSessionObject(params) && params.what === 'data') ||
          (typeof packet.payload.code === 'number' && packet.payload.code >= 400)) acceptCompletion(packet.payload);
      } else if (combined && packet.kind === 'meta' && Array.isArray(packet.payload.sub) &&
        typeof packet.payload.id === 'string' && (requestId === undefined || requestId === packet.payload.id)) {
        participants = { id: packet.payload.id, rows: packet.payload.sub.slice(0, 32) };
      } else if (packet.kind === 'data') {
        try {
          const frame = normalizePreviewMessage(packet.payload, job.topicKey, this.#scope.account.uid);
          if (!first || frame.message.seq > first.message.seq) first = frame;
          tryFinish();
        } catch (reason: unknown) { fail(reason); }
      }
    });
    const abort = () => stop(this.#disposed || !this.#scope.active ? this.#closed('preview') : cancelled());
    job.abort.signal.addEventListener('abort', abort, { once: true });
    if (job.abort.signal.aborted) abort();
    const timer = setTimeout(() => stop(this.#previewTimeout()), previewTimeoutMs);
    try {
      if (!this.#previewCurrent(job)) throw cancelled();
      interest = this.#scope.topicInterest(job.topicKey, 'preview');
      physicalAttach = await interest.acquire(job.abort.signal);
      if (job.abort.signal.aborted || !this.#previewCurrent(job)) {
        if (physicalAttach) interest.refused();
        throw cancelled();
      }
      attachAttempted = physicalAttach;
      attachComplete = !physicalAttach;
      // The stream starts with sub.get, so the listener must already accept data packets.
      job.queryStarted = true;
      const attachment = (physicalAttach ? this.#scope.subscribe(job.topicKey, combined
        ? { what: 'sub data', sub: { limit: 32 }, data: { limit: 1 } }
        : { what: 'data', data: { limit: 1 } }) : this.#scope.getPreview(job.topicKey, combined)).then((response) => {
        checkControl(response);
        // The SDK uses one request ID for the ACK, meta.sub, and end-of-data control packet.
        // Metadata is a valid nested get reply but does not confirm attachment.
        const metadata = response.code === undefined && (Array.isArray(response.sub) || isSessionObject(response.desc));
        if (!metadata && (typeof response.code !== 'number' ||
          !((response.code >= 200 && response.code < 300) || response.code === 304))) throw invalid();
        if (typeof response.id !== 'string' || response.id === '') throw invalid();
        requestId = response.id;
        if (pendingAcks.has(requestId)) attachComplete = true;
        pendingAcks.clear();
        acceptAck(response);
        const completion = pendingControls.get(requestId);
        pendingControls.clear();
        if (completion) acceptCompletion(completion);
        tryFinish();
      }).catch((reason: unknown) => {
        if (previewRequestRejected(reason)) {
          if (physicalAttach) interest?.refused();
          attachComplete = true;
          job.drained = true;
        }
        throw reason;
      });
      await Promise.race([attachment, interrupted]);
      if (job.abort.signal.aborted) throw cancelled();
      await Promise.race([stream, interrupted]);
      offPackets();
      if (!this.#previewCurrent(job)) throw cancelled();
      if (completionCount === 1 && first) latest = await this.#resolvePreview(job, first, interrupted);
    } catch (reason: unknown) { problem ??= reason; }
    finally {
      clearTimeout(timer);
      job.abort.signal.removeEventListener('abort', abort);
      const physicalLeave = interest?.release() === true;
      if (!physicalLeave) detachComplete = true;
      else {
        try {
          if (!this.#scope.active) throw this.#closed('preview');
          const reply = await this.#previewDeadline(this.#scope.leave(job.topicKey));
          checkControl(reply);
          if (typeof reply.code !== 'number' || !((reply.code >= 200 && reply.code < 300) || reply.code === 304)) throw invalid();
          detachComplete = true;
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        } catch (reason: unknown) { problem ??= reason; }
        finally { interest?.detached(detachComplete && attachComplete && (!job.queryStarted || job.drained)); }
      }
      offPackets();
      // After handing off an attached topic, late optional meta or ctrl replies from the old sub.get
      // do not belong to the new owner. The count above already verifies the data stream.
      if (requestId) this.#scope.retirePreviewRequest(requestId);
      if (this.#scope.active && (this.#scope.isTopicAttachmentBlocked(job.topicKey) || (job.queryStarted && !job.drained) ||
        (attachAttempted && (!attachComplete || !detachComplete)))) {
        // leave alone does not establish the outcome of an unconfirmed subscribe.
        this.#previewSession.blocked.add(job.topicKey);
      }
    }
    if (job.settled) return;
    if (!this.#previewCurrent(job) || job.abort.signal.aborted) {
      this.#cancelPreview(job);
      return;
    }
    const record = this.#records.get(job.topicKey)!;
    const previousHead = job.previous.serverSeq.state === 'known' ? job.previous.serverSeq.value : 0;
    const coveredHead = Math.max(previousHead, first?.message.seq ?? 0);
    const currentHead = this.#previewHeads.get(job.topicKey) ?? 0;
    const current = record.preview.state === 'available' ? record.preview.message : undefined;
    if (current && currentHead > (first?.message.seq ?? 0)) {
      // A live frame confirmed newer history while this job was draining.
      job.settled = true;
      job.detach();
      job.resolve(Object.freeze({ scope: this.account, topicKey: job.topicKey, revision: record.revision,
        preview: record.preview, lastActivityAt: record.lastActivityAt }));
      return;
    }
    if (combined && latest && latest.sender.state !== 'self' && latest.sender.profileKey) {
      const key = latest.sender.profileKey;
      const row = participants?.id === requestId ? participants?.rows.find(row => isSessionObject(row) &&
        row.user === key && (row.deleted === undefined || row.deleted === null || row.deleted === false)) : undefined;
      if (isSessionObject(row) && isSessionObject(row.public)) this.#capturePreviewProfile(key, row.public);
      const profile = this.#profiles.get(key);
      if (profile) latest = Object.freeze({ ...latest, sender: this.#senderFromProfile(profile) });
    }
    let preview: LastMessagePreview;
    if (problem !== undefined) {
      const error = failure(problem, 'preview').chatListError;
      preview = this.#unavailablePreview(new ChatListFailure({ ...error,
        retryable: error.retryable && !this.#previewSession.blocked.has(job.topicKey) }), job.previous, latest);
    }
    else if (latest) preview = Object.freeze({ state: 'available', message: latest });
    else preview = Object.freeze({ state: 'empty', reason: 'noAvailableMessages' });
    if (problem === undefined) {
      this.#previewHeads.set(job.topicKey, coveredHead);
      const wantedHead = this.#messageSignals.get(job.topicKey) ?? 0;
      if (wantedHead > coveredHead) {
        this.#dirtyMessages.add(job.topicKey);
        preview = this.#pendingPreview(record);
      }
    }
    const result = this.#updatePreview(job.topicKey, preview, problem === undefined);
    if (!job.settled) {
      if (!this.#previewCurrent(job) || job.abort.signal.aborted) this.#cancelPreview(job);
      else {
        job.settled = true;
        if (this.#previewJobs.get(job.topicKey) === job) this.#previewJobs.delete(job.topicKey);
        job.detach();
        job.resolve(result);
        if (latest && this.#previewCurrent(job)) this.#enrichSender(job.topicKey, latest);
      }
    }
  }

  async #resolvePreview(job: PreviewJob, first: PreviewFrame, interrupted: Promise<never>): Promise<LastMessage | undefined> {
    const versions = new Map<string, LastMessage>();
    let page = [first];
    while (page.length) {
      for (const frame of page) {
        const { message, replaces, author } = frame;
        if (replaces === undefined) {
          const version = author && versions.get(message.seq + ':' + author);
          return version ? Object.freeze({ ...message, content: version.content,
            mentionedMe: version.mentionedMe, versionSeq: version.seq }) : message;
        }
        if (author) {
          const key = replaces + ':' + author;
          if (!versions.has(key)) versions.set(key, message);
        }
      }
      const before = page.at(-1)!.message.seq;
      if (before <= 1 || !this.#previewCurrent(job)) return;
      page = await this.#readOlderPreviewPage(job, before, interrupted);
    }
  }

  async #readOlderPreviewPage(job: PreviewJob, before: number, interrupted: Promise<never>): Promise<PreviewFrame[]> {
    const frames = new Map<number, TinodeSessionObject>();
    let expectedCount: number | undefined;
    let complete!: () => void;
    const received = new Promise<void>(resolve => { complete = resolve; });
    const off = this.#scope.subscribePackets(packet => {
      const p = packet.payload;
      if (packet.kind !== 'data' || p.topic !== job.topicKey || typeof p.seq !== 'number' ||
        p.seq >= before || frames.size > 32) return;
      frames.set(p.seq, p);
      if (frames.size === expectedCount) complete();
    });
    job.drained = false;
    try {
      const reply = await Promise.race([this.#scope.getPreview(job.topicKey, false, before), interrupted]);
      if (typeof reply.id === 'string') this.#scope.retirePreviewRequest(reply.id);
      const params = isSessionObject(reply.params) ? reply.params : undefined;
      const count = reply.code === 204 ? 0 : params?.count;
      if ((reply.code !== 204 && reply.code !== 208) || params?.what !== 'data' ||
        typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > 32) {
        throw new TinodeSessionFailure('invalidResponse');
      }
      // Tinode may send ctrl 208 before the messages themselves.
      expectedCount = count;
      if (frames.size < count) await Promise.race([received, interrupted]);
      job.drained = true;
      if (frames.size !== count) throw new TinodeSessionFailure('invalidResponse');
      return [...frames.values()]
        .map(frame => normalizePreviewMessage(frame, job.topicKey, this.account.uid))
        .sort((a, b) => b.message.seq - a.message.seq);
    } catch (reason: unknown) {
      if (previewRequestRejected(reason)) job.drained = true;
      throw reason;
    } finally { off(); }
  }

  #previewTimeout(): ChatListFailure {
    return new ChatListFailure({ kind: 'timeout', area: 'preview',
      messageCode: 'chatPreviewTimeout', retryable: true });
  }

  async #previewDeadline<T>(request: Promise<T>, signal?: AbortSignal): Promise<T> {
    let timer!: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(this.#previewTimeout()), previewTimeoutMs);
    });
    const pending = Promise.race([request, timeout]);
    try { return await (signal ? this.#wait(pending, signal) : pending); }
    finally { clearTimeout(timer); }
  }

  #unavailablePreview(reason: ChatListFailure, record: ChatRecord, latest?: LastMessage): LastMessagePreview {
    const lastKnown = latest ?? this.#lastMessage(record.preview);
    return Object.freeze({ state: 'unavailable', error: reason.chatListError,
      ...(lastKnown === undefined ? {} : { lastKnown }) });
  }

  #updatePreview(topicKey: string, preview: LastMessagePreview, replace = false): ChatPreviewResult {
    let record = this.#records.get(topicKey)!;
    if (preview.state === 'available') {
      const previous = this.#lastMessage(record.preview);
      if (!replace && previous && (previous.seq > preview.message.seq ||
        (previous.seq === preview.message.seq && (previous.versionSeq ?? previous.seq) > (preview.message.versionSeq ?? preview.message.seq)))) {
        return Object.freeze({ scope: this.#scope.account, topicKey, revision: record.revision,
          preview: record.preview, lastActivityAt: record.lastActivityAt });
      }
      const head = this.#previewHeads.get(topicKey) ?? preview.message.versionSeq ?? preview.message.seq;
      if (!this.#mutedGaps.has(topicKey) && record.serverSeq.state === 'known' && head > record.serverSeq.value) {
        this.#advanceServerSeq(topicKey, head);
        record = this.#records.get(topicKey)!;
      }
    }
    if (this.#previewsPaused() && preview.state === 'available' && this.#pausedPreviews.has(topicKey) &&
      (this.#forcePreviews.has(topicKey) || (record.serverSeq.state === 'known' && (this.#previewHeads.get(topicKey) ?? 0) < record.serverSeq.value))) {
      preview = Object.freeze({ state: 'pending', lastKnown: preview.message });
    }
    const lastActivityAt = preview.state === 'available'
      ? Object.freeze({ state: 'known' as const, at: preview.message.timestamp, source: 'message' as const })
      : preview.state === 'empty' ? Object.freeze({ state: 'unknown' as const }) : record.lastActivityAt;
    const revision = ++this.#revision;
    this.#records.set(topicKey, Object.freeze({ ...record, revision, preview, lastActivityAt }));
    this.#releaseUnusedSenders();
    const result = Object.freeze({ scope: this.#scope.account, topicKey, revision, preview, lastActivityAt });
    this.#emit(Object.freeze({ kind: 'previewUpdated', ...result }));
    return result;
  }

  #releasePreviewOwner(): void {
    if (this.#disposed && this.#previewRunning === 0 && this.#topicReads.size === 0 && !this.#previewPause && this.#topicReservations.size === 0 && this.#previewSession.owner === this) {
      this.#previewSession.owner = undefined;
    }
  }

  async #wait<T>(request: Promise<T>, signal: AbortSignal): Promise<T> {
    let stop!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      stop = () => reject(this.#disposed || !this.#scope.active ? this.#closed() : cancelled());
    });
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    try { return await Promise.race([request, aborted]); }
    finally { signal.removeEventListener('abort', stop); }
  }

  #current(generation: number, signal: AbortSignal): boolean {
    return !this.#disposed && this.#scope.active && this.#generation === generation && !signal.aborted;
  }

  #assertCurrent(generation: number, signal: AbortSignal): void {
    if (this.#disposed || !this.#scope.active) throw this.#closed();
    if (this.#generation !== generation || signal.aborted) throw cancelled();
  }

  #closed(area: 'list' | 'preview' = 'list'): ChatListFailure {
    return failure(new TinodeSessionFailure('closed'), area);
  }

  #emit(event: ChatListEvent): void {
    if (this.#snapshotEvents && event.revision > this.#snapshotEvents.baseRevision) this.#snapshotEvents.events.push(event);
    for (const listener of [...this.#listeners]) {
      if (this.#disposed || !this.#scope.active) break;
      try { listener(event); }
      catch { console.error('Chat list subscriber notification failed.'); }
    }
  }

  #release(controller: AbortController): void {
    if (this.#loadAbort !== controller) return;
    this.#detachSignal?.();
    this.#detachSignal = undefined;
    this.#loadAbort = undefined;
  }

  #cancelLoad(): void {
    const controller = this.#loadAbort;
    this.#loadAbort = undefined;
    this.#detachSignal?.();
    this.#detachSignal = undefined;
    controller?.abort();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#muted.dispose();
    this.#draftWrites.clear();
    this.#draftRevisions.clear();
    this.#draftMetadataKnown.clear();
    this.#lifetime.abort();
    if (!this.#scope.active) {
      this.#previewPause?.lifetime.abort();
      for (const state of this.#topicReservations) { state.lifetime.abort(); state.released = true; }
      this.#topicReservations.clear();
      this.#previewPause = undefined;
    }
    this.#pausedPreviews.clear();
    this.#generation += 1;
    this.#membershipEpoch += 1;
    this.#cancelLoad();
    this.#detachPackets(); this.#detachReadState(); this.#detachOwnPush(); this.#detachGroupProfile();
    this.#detachPackets = () => {}; this.#detachReadState = () => {}; this.#detachOwnPush = () => {}; this.#detachGroupProfile = () => {};
    this.#messageAbort.abort();
    this.#topicVersions.clear();
    this.#metadataVersions.clear();
    this.#forcePreviews.clear();
    this.#previewHeads.clear();
    this.#readable.clear();
    this.#readableRevisions.clear();
    this.#snapshotEvents = undefined;
    this.#messageSignals.clear();
    this.#mutedGaps.clear();
    this.#updatingMessages.clear();
    this.#dirtyMessages.clear();
    this.#readSequences.clear();
    this.#recvSequences.clear();
    for (const job of [...this.#previewJobs.values()]) this.#cancelPreview(job);
    this.#resetSenders();
    this.#avatars.dispose();
    this.#records.clear();
    this.#releasePreviewOwner();
    this.#detachScope();
    this.#detachScope = () => {};
    this.#meAttached = false;
    this.#ownProfile = Object.freeze({ state: 'pending' });
    const closed = Object.freeze({ kind: 'closed' as const, scope: this.#scope.account,
      revision: ++this.#revision });
    const listeners = [...this.#listeners];
    this.#listeners.clear();
    for (const listener of listeners) {
      try { listener(closed); }
      catch { console.error('Chat list subscriber notification failed.'); }
    }
    // Authentication still owns the parent scope and SDK. This does not sign out or disconnect.
  }
}
