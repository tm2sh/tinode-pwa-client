import type {
  AccountScope, AvatarResource, ChatActionDetails, ChatLastActivity, ChatListError, ChatListEvent,
  ChatDepartureAction, ChatDepartureResult, ChatListItem, ChatListPort, ChatMuteResult, ChatListRefresh, ChatListSnapshot, ChatRecord,
  ChatSequence, ChatTitle, CurrentUserProfile, LastMessage, LastMessagePreview, ChatPreviewPause,
} from './chat-list-types';
import type { GroupCreationKind } from '../groups/group-creation-types';
import { ChatListFailure, unreadCount, applyChatRecordUpdate, mergeChatListSnapshot } from './chat-list-normalize';

type Listener = () => void;
type PortFactory = () => Promise<ChatListPort>;
interface ChatListControllerOptions {
  readonly deferPreviews?: boolean;
  readonly scheduleInitialRetry?: (error: ChatListError, retry: () => void) => boolean;
  readonly onInitialLoadFinished?: () => void;
}

interface Operation {
  readonly abort: AbortController;
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly events: ChatListEvent[];
}
interface PreviewInterest {
  readonly epoch: number;
  readonly abort: AbortController;
}

const idleRefresh = Object.freeze({ state: 'idle' } as const);
const activeControllers = new Set<ChatListController>();

function copyError(error: ChatListError): ChatListError {
  return Object.freeze({ kind: error.kind, area: error.area, messageCode: error.messageCode,
    retryable: error.retryable,
    ...(error.serverCode === undefined ? {} : { serverCode: error.serverCode }),
    ...(error.messageParams === undefined ? {} : {
      messageParams: Object.freeze({ seconds: error.messageParams.seconds }),
    }) });
}

function requestError(reason: unknown, area: 'list' | 'preview'): ChatListError {
  if (reason instanceof DOMException && reason.name === 'AbortError') {
    return Object.freeze({ kind: 'sessionClosed', area, messageCode: 'chatListSessionClosed', retryable: false });
  }
  return reason instanceof ChatListFailure ? copyError(reason.chatListError)
    : Object.freeze({ kind: 'unavailable', area, retryable: true,
      messageCode: area === 'list' ? 'chatListUnavailable' : 'chatPreviewUnavailable' });
}

function profileReadError(error: ChatListError): CurrentUserProfile {
  return Object.freeze({ state: 'unavailable',
    error: Object.freeze({ ...error, area: 'profile', messageCode: 'chatProfileUnavailable' }) });
}

function invalidResponse(): ChatListFailure {
  return new ChatListFailure({ kind: 'invalidResponse', area: 'list',
    messageCode: 'chatListInvalidResponse', retryable: true });
}

function copyTitle(title: ChatTitle): ChatTitle {
  return title.state === 'known' ? Object.freeze({ state: 'known', text: title.text })
    : Object.freeze({ state: 'unknown' });
}

function copyAvatar(avatar: AvatarResource): AvatarResource {
  return avatar.state === 'ready' ? Object.freeze({ state: 'ready', imageSource: avatar.imageSource })
    : Object.freeze({ state: avatar.state });
}

function copySequence(sequence: ChatSequence): ChatSequence {
  return sequence.state === 'known' ? Object.freeze({ state: 'known', value: sequence.value })
    : Object.freeze({ state: 'unknown' });
}

function copyActivity(activity: ChatLastActivity): ChatLastActivity {
  return activity.state === 'known'
    ? Object.freeze({ state: 'known', at: activity.at, source: activity.source })
    : Object.freeze({ state: 'unknown' });
}

function copyMessage(message: LastMessage): LastMessage {
  const sender = message.sender;
  const copiedSender = sender.state === 'self' ? { state: 'self' as const }
    : sender.state === 'known' ? { state: 'known' as const, profileKey: sender.profileKey, displayName: sender.displayName }
      : { state: 'unknown' as const, ...(sender.profileKey === undefined ? {} : { profileKey: sender.profileKey }) };
  return Object.freeze({ mentionedMe: message.mentionedMe === true, seq: message.seq, timestamp: message.timestamp,
    ...(message.versionSeq === undefined ? {} : { versionSeq: message.versionSeq }),
    sender: Object.freeze({ ...copiedSender,
      ...(sender.avatar === undefined ? {} : { avatar: copyAvatar(sender.avatar) }) }),
    content: message.content.kind === 'text' ? Object.freeze({ kind: 'text', text: message.content.text })
      : Object.freeze({ kind: message.content.kind,
        ...(message.content.caption === undefined ? {} : { caption: message.content.caption }) }),
  });
}

function copyPreview(preview: LastMessagePreview): LastMessagePreview {
  switch (preview.state) {
    case 'available': return Object.freeze({ state: 'available', message: copyMessage(preview.message) });
    case 'empty': return Object.freeze({ state: 'empty', reason: preview.reason });
    case 'unavailable': return Object.freeze({ state: 'unavailable', error: copyError(preview.error),
      ...(preview.lastKnown === undefined ? {} : { lastKnown: copyMessage(preview.lastKnown) }) });
    case 'pending': return Object.freeze({ state: 'pending',
      ...(preview.lastKnown === undefined ? {} : { lastKnown: copyMessage(preview.lastKnown) }) });
  }
}

function copyOwnProfile(profile: CurrentUserProfile): CurrentUserProfile {
  if (profile.state === 'available') return Object.freeze({ state: 'available',
    displayName: copyTitle(profile.displayName), avatar: copyAvatar(profile.avatar) });
  if (profile.state === 'unavailable') return Object.freeze({ state: 'unavailable', error: copyError(profile.error) });
  return Object.freeze({ state: 'pending' });
}

function copyItem(record: ChatRecord, pending?: number): ChatListItem {
  const readSeq = pending === undefined ? record.readSeq : { state: 'known' as const, value: Math.max(pending, record.readSeq.state === 'known' ? record.readSeq.value : 0) };
  return Object.freeze({ mentionUnread: record.preview.state === 'available' && record.preview.message.mentionedMe === true &&
    readSeq.state === 'known' && record.preview.message.seq > readSeq.value,
    topicKey: record.topicKey, kind: record.kind,
    ...(record.notificationsMuted === undefined ? {} : { notificationsMuted: record.notificationsMuted }),
    title: copyTitle(record.title), avatar: copyAvatar(record.avatar),
    ...(record.draft === undefined ? {} : { draft: Object.freeze({ ...record.draft }) }),
    ...(record.participantCount === undefined ? {} : { participantCount: copySequence(record.participantCount) }), unread: copySequence(pending === undefined ? record.unread : unreadCount(record.serverSeq, readSeq)),
    preview: copyPreview(record.preview), lastActivityAt: copyActivity(record.lastActivityAt) });
}

function copyRecord(record: ChatRecord): ChatRecord {
  return Object.freeze({ ...copyItem(record), actionTopic: Object.freeze({ ...record.actionTopic }),
    serverSeq: copySequence(record.serverSeq),
    readSeq: copySequence(record.readSeq), revision: record.revision });
}

function validScope(scope: AccountScope): boolean {
  return typeof scope?.serverId === 'string' && scope.serverId !== '' &&
    typeof scope.uid === 'string' && scope.uid !== '' &&
    Number.isSafeInteger(scope.generation) && scope.generation >= 0;
}

function sameScope(one: AccountScope, two: AccountScope): boolean {
  return one.serverId === two.serverId && one.uid === two.uid && one.generation === two.generation;
}

export class ChatListController {
  #openPort: PortFactory;
  #port: ChatListPort | undefined;
  #portPromise: Promise<ChatListPort> | undefined;
  #detachPort: () => void = () => {};
  #scope: AccountScope | undefined;
  #snapshot: ChatListSnapshot = Object.freeze({ phase: 'idle' });
  #records = new Map<string, ChatRecord>();
  #removedRevisions = new Map<string, number>();
  #pendingReads = new Map<string, number>();
  #items: readonly ChatListItem[] = Object.freeze([]);
  #ownProfile: CurrentUserProfile = Object.freeze({ state: 'pending' });
  #ownRevision = -1;
  #hasReady = false;
  #refresh: ChatListRefresh = idleRefresh;
  #operation: Operation | undefined;
  #previews = new Map<string, PreviewInterest>();
  #epoch = 0;
  readonly #options: ChatListControllerOptions;
  #previewReady = false;
  #previewsSuspended = false;
  #previewPause: ChatPreviewPause | undefined;
  #priority: readonly string[] = [];
  #attemptedPreviews = new Set<string>();
  #started = false;
  #disposed = false;
  #managed = false;
  #owners = 0;
  #ownershipVersion = 0;
  #listeners = new Set<Listener>();

  constructor(openPort: PortFactory, options: ChatListControllerOptions = {}) {
    this.#openPort = openPort;
    this.#options = options;
  }

  readonly prioritizePreviews = (topicKeys: readonly string[]): void => {
    if (!this.#canRun() || !this.#hasReady) return;
    this.#priority = Object.freeze([...new Set(topicKeys)].filter((key) => this.#records.has(key)));
    this.#previewReady = true;
    if (this.#port) this.#loadPreviews(this.#port);
  };

  pausePreviews(consumerId: number): ChatPreviewPause {
    if (!this.#canRun() || !this.#port || !this.#hasReady) {
      throw new ChatListFailure({ kind: 'unavailable', area: 'list',
        messageCode: 'chatListUnavailable', retryable: true });
    }
    if (this.#previewPause?.navigationGeneration === consumerId) return this.#previewPause;
    const previous = this.#previewPause;
    let inner: ChatPreviewPause | undefined;
    const handle: ChatPreviewPause = Object.freeze({ account: this.#port.account,
      navigationGeneration: consumerId,
      get active() { return inner?.active === true; },
      waitTopicIdle: (topicKey: string, signal?: AbortSignal) => inner
        ? inner.waitTopicIdle(topicKey, signal) : Promise.reject(invalidResponse()),
      preparePersonalChat: (userId: string, signal: AbortSignal) => inner?.preparePersonalChat
        ? inner.preparePersonalChat(userId, signal) : Promise.reject(invalidResponse()),
      prepareCreatedGroup: (topicKey: string, signal: AbortSignal, kind: GroupCreationKind) => inner?.prepareCreatedGroup
        ? inner.prepareCreatedGroup(topicKey, signal, kind) : Promise.reject(invalidResponse()),
      refreshPreview: (topicKey: string, change: 'message' | 'delete') => { inner?.refreshPreview(topicKey, change); },
      blockTopic: (topicKey: string) => {
        if (!inner) throw invalidResponse();
        inner.blockTopic(topicKey);
      },
      release: () => {
        inner?.release();
        if (this.#previewPause !== handle) return;
        this.#previewPause = undefined;
        for (const record of this.#records.values()) {
          if (record.preview.state === 'pending') this.#attemptedPreviews.delete(record.topicKey);
        }
        if (this.#port) this.#loadPreviews(this.#port);
      },
    });
    // Set this before the adapter can emit synchronous pending events. Let work in progress continue.
    this.#previewPause = handle;
    try { inner = this.#port.pausePreviews(consumerId); }
    catch (reason: unknown) {
      if (this.#previewPause === handle) this.#previewPause = previous;
      throw reason;
    }
    return handle;
  }

  readonly getSnapshot = (): ChatListSnapshot => this.#snapshot;

  readonly actionDetails = (topicKey: string): ChatActionDetails | undefined => {
    const record = this.#records.get(topicKey);
    return record && this.#canRun() ? { ...record.actionTopic, notificationsMuted: record.notificationsMuted } : undefined;
  };

  readonly readActionDetails = async (topicKey: string, signal: AbortSignal): Promise<ChatActionDetails> => {
    const port = this.#port;
    if (signal.aborted || !port || !this.actionDetails(topicKey)) throw invalidResponse();
    const result = await port.readActionDetails(topicKey, signal);
    if (signal.aborted || this.#port !== port || !this.actionDetails(topicKey)) throw invalidResponse();
    return result;
  };

  readonly setMuted = (topicKey: string, muted: boolean): Promise<ChatMuteResult> => {
    const port = this.#port;
    if (!port || !this.actionDetails(topicKey)) {
      return Promise.resolve({ state: 'failed', error: { messageCode: 'chatInfoMuteUnavailable', retryable: true } });
    }
    return port.setMuted(topicKey, muted);
  };

  readonly departChat = (topicKey: string, action: ChatDepartureAction): Promise<ChatDepartureResult> => {
    const port = this.#port;
    if (!port || !this.actionDetails(topicKey)) {
      return Promise.resolve({ state: 'failed', messageCode: 'chatDepartureUnavailable' });
    }
    return port.departChat(topicKey, action);
  };

  readonly openDraft = (topicKey: string) => this.#canRun() ? this.#port?.openDraft?.(topicKey) : undefined;

  readonly subscribe = (listener: Listener): (() => void) => {
    if (this.#disposed) return () => {};
    const subscription = () => listener();
    this.#listeners.add(subscription);
    return () => { this.#listeners.delete(subscription); };
  };

  get busy(): boolean { return this.#operation !== undefined; }

  // Keep the owner and its single port through React StrictMode's same-turn setup, cleanup, and setup.
  attach(): () => void {
    if (this.#disposed) return () => {};
    activeControllers.add(this);
    this.#managed = true;
    this.#owners += 1;
    this.#ownershipVersion += 1;
    let attached = true;
    return () => {
      if (!attached) return;
      attached = false;
      this.#owners -= 1;
      const version = ++this.#ownershipVersion;
      queueMicrotask(() => {
        if (this.#owners === 0 && this.#ownershipVersion === version) this.dispose();
      });
    };
  }

  readonly reconcileForeground = (recover: () => Promise<void>): void => {
    if (!this.#canRun()) return;
    if (this.#hasReady) this.#port?.reconcileForeground();
    else this.recoverInitialLoad(recover);
  };

  readonly recoverInitialLoad = (recover: () => Promise<void>): void => {
    if (!this.#canRun() || this.#hasReady || !navigator.onLine) return;
    const snapshot = this.#snapshot;
    if (snapshot.phase === 'loading' || (snapshot.phase === 'error' && snapshot.error.retryable)) {
      void recover();
    }
  };

  readonly start = (): Promise<void> => {
    if (!this.#canRun()) return Promise.resolve();
    if (this.#operation) return this.#operation.promise;
    if (this.#started) return Promise.resolve();
    return this.#load();
  };

  readonly retry = (): Promise<void> => {
    if (!this.#canRun()) return Promise.resolve();
    return this.#operation?.promise ?? this.#load();
  };

  readonly refreshOwnProfile = (account: AccountScope): void => {
    const port = this.#port;
    if (this.#canRun() && port && sameScope(port.account, account)) void port.refreshOwnProfile();
  };

  readonly retryOwnProfile = async (): Promise<void> => {
    if (!this.#canRun() || this.#ownProfile.state !== 'unavailable' || !this.#ownProfile.error.retryable) return;
    try {
      const port = await this.#getPort();
      if (this.#canRun() && this.#ownProfile.state === 'unavailable') await port.refreshOwnProfile();
    } catch (reason: unknown) {
      if (this.#canRun() && this.#ownProfile.state === 'unavailable') {
        this.#ownProfile = profileReadError(requestError(reason, 'list'));
        this.#publishProfile();
      }
    }
  };

  #load(): Promise<void> {
    this.#started = true;
    activeControllers.add(this);
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    const operation: Operation = { promise, resolve, abort: new AbortController(), events: [] };
    this.#operation = operation;
    this.#epoch += 1;
    this.#cancelPreviews();
    if (this.#hasReady) {
      this.#refresh = Object.freeze({ state: 'pending' });
      this.#publishReady();
    } else this.#publish(Object.freeze({ phase: 'loading', ownProfile: this.#ownProfile }));
    void this.#run(operation);
    return promise;
  }

  async #getPort(): Promise<ChatListPort> {
    if (this.#port) return this.#port;
    if (this.#portPromise) return this.#portPromise;
    const pending = Promise.resolve().then(() => {
      if (!this.#canRun()) throw new Error('Chat list context closed.');
      return this.#openPort();
    }).then((port) => {
      if (!this.#canRun()) { port.dispose(); throw new Error('Chat list context closed.'); }
      const account = port.account;
      if (!validScope(account) || (this.#scope !== undefined && !sameScope(this.#scope, account))) {
        port.dispose();
        throw invalidResponse();
      }
      // The account context is known before load(), so the profile can appear before the chat list.
      const previousScope = this.#scope;
      this.#scope ??= Object.freeze({ serverId: account.serverId, uid: account.uid, generation: account.generation });
      this.#port = port;
      try {
        const detach = port.subscribe(this.#onEvent);
        if (!this.#canRun()) { detach(); throw new Error('Chat list context closed.'); }
        this.#detachPort = detach;
      } catch (reason: unknown) {
        this.#port = undefined;
        port.dispose();
        if (previousScope === undefined) {
          this.#scope = undefined;
          this.#ownProfile = Object.freeze({ state: 'pending' });
          this.#ownRevision = -1;
        }
        throw reason;
      }
      return port;
    }).finally(() => {
      if (this.#portPromise === pending) this.#portPromise = undefined;
    });
    this.#portPromise = pending;
    return pending;
  }

  async #run(operation: Operation): Promise<void> {
    try {
      const port = await this.#getPort();
      if (!this.#isCurrent(operation)) return;
      const result = await port.load(operation.abort.signal);
      if (!this.#isCurrent(operation)) return;
      if (!validScope(result.scope) || !Number.isSafeInteger(result.revision) || result.revision < 0 ||
        (this.#scope !== undefined && !sameScope(this.#scope, result.scope))) throw invalidResponse();
      this.#scope ??= Object.freeze({ serverId: result.scope.serverId, uid: result.scope.uid,
        generation: result.scope.generation });
      this.#previewReady = !this.#options.deferPreviews;
      const events = operation.events.filter(event => sameScope(event.scope, result.scope));
      this.#records = new Map(mergeChatListSnapshot(result.records, events, result.revision)
        .map(record => [record.topicKey, copyRecord(record)]));
      if (this.#ownRevision <= result.revision) {
        this.#ownProfile = copyOwnProfile(result.ownProfile);
        this.#ownRevision = result.revision;
      }
      this.#refresh = idleRefresh;
      this.#previewsSuspended = false;
      for (const event of [...events].sort((one, two) => one.revision - two.revision)) {
        if (event.revision > result.revision && (event.kind === 'ownProfileUpdated' || event.kind === 'unavailable')) this.#applyEvent(event);
      }
      this.#rebuildItems();
      if (!this.#hasReady) this.#options.onInitialLoadFinished?.();
      this.#hasReady = true;
      this.#finish(operation);
      this.#publishReady();
      this.#loadPreviews(port);
    } catch (reason: unknown) {
      if (!this.#isCurrent(operation)) return;
      const error = requestError(reason, 'list');
      if (error.kind === 'sessionClosed') { this.dispose(); return; }
      this.#finish(operation);
      if (!this.#hasReady && this.#options.scheduleInitialRetry?.(error, () => { void this.retry(); })) return;
      if (this.#hasReady) {
        this.#refresh = Object.freeze({ state: 'failed', error: copyError(error) });
        this.#publishReady();
        // A failed full sub request does not stop independent previews for known chats.
        if (this.#port) this.#loadPreviews(this.#port);
      } else {
        if (!this.#port && this.#ownProfile.state === 'pending') this.#ownProfile = profileReadError(error);
        this.#publish(Object.freeze({ phase: 'error', error, ownProfile: this.#ownProfile }));
      }
    } finally { operation.resolve(); }
  }

  #finish(operation: Operation): void {
    if (this.#operation !== operation) return;
    this.#operation = undefined;
    operation.events.length = 0;
    operation.resolve();
  }

  readonly #onEvent = (event: ChatListEvent): void => {
    if (!this.#canRun() || !validScope(event.scope) || !Number.isSafeInteger(event.revision) || event.revision < 0) return;
    if (this.#scope !== undefined && !sameScope(this.#scope, event.scope)) return;
    if (event.kind === 'closed') { this.dispose(); return; }
    if (event.kind === 'readPending') {
      if (this.#scope === undefined || !Number.isSafeInteger(event.serverSeq) || event.serverSeq < 1 ||
        !this.#records.has(event.topicKey) || event.serverSeq <= (this.#pendingReads.get(event.topicKey) ?? 0)) return;
      this.#pendingReads.set(event.topicKey, event.serverSeq);
      this.#rebuildItems(); if (this.#hasReady) this.#publishReady(); return;
    }
    if (this.#operation) this.#operation.events.push(event);
    if (this.#scope === undefined) return;
    if (event.kind === 'ownProfileUpdated') {
      if (this.#applyEvent(event)) this.#publishProfile();
      return;
    }
    if (!this.#hasReady) return;
    if (this.#applyEvent(event)) {
      this.#publishReady();
      if (this.#port && event.kind !== 'unavailable') this.#loadPreviews(this.#port);
    }
  };

  #applyEvent(event: ChatListEvent): boolean {
    if (this.#scope === undefined || !sameScope(this.#scope, event.scope)) return false;
    if (event.kind === 'ownProfileUpdated') {
      if (event.revision <= this.#ownRevision) return false;
      this.#ownRevision = event.revision;
      this.#ownProfile = copyOwnProfile(event.profile);
      return true;
    }
    if (event.kind === 'unavailable') {
      this.#previewsSuspended = true;
      this.#epoch += 1;
      this.#cancelPreviews();
      this.#refresh = Object.freeze({ state: 'failed', error: copyError(event.error) });
      return true;
    }
    if (event.kind === 'chatUpsert') {
      const key = event.record.topicKey;
      const previous = this.#records.get(key);
      if (event.revision <= (previous?.revision ?? this.#removedRevisions.get(key) ?? -1)) return false;
      this.#records.set(key, copyRecord(applyChatRecordUpdate(previous,
        { ...event.record, revision: event.revision }, event.updatedFields)));
    } else if (event.kind === 'chatRemoved') {
      const previous = this.#records.get(event.topicKey);
      if (event.revision <= (previous?.revision ?? this.#removedRevisions.get(event.topicKey) ?? -1)) return false;
      this.#removedRevisions.set(event.topicKey, event.revision);
      this.#records.delete(event.topicKey);
      this.#previews.get(event.topicKey)?.abort.abort();
      this.#previews.delete(event.topicKey);
      this.#attemptedPreviews.delete(event.topicKey);
    } else if (event.kind === 'readUpdated') {
      const previous = this.#records.get(event.topicKey);
      if (!previous || event.revision <= previous.revision || event.readSeq.state !== 'known' ||
        (previous.readSeq.state === 'known' && previous.readSeq.value >= event.readSeq.value)) return false;
      const readSeq = copySequence(event.readSeq);
      this.#records.set(previous.topicKey, Object.freeze({ ...previous, revision: event.revision,
        readSeq, unread: unreadCount(previous.serverSeq, readSeq) }));
    } else if (event.kind === 'previewUpdated') {
      const previous = this.#records.get(event.topicKey);
      if (!previous || event.revision <= previous.revision) return false;
      this.#records.set(previous.topicKey, Object.freeze({ ...previous, revision: event.revision,
        preview: copyPreview(event.preview), lastActivityAt: copyActivity(event.lastActivityAt) }));
    } else return false;
    this.#rebuildItems();
    return true;
  }

  #rebuildItems(): void {
    for (const [topic, pending] of this.#pendingReads) {
      const record = this.#records.get(topic);
      if (!record || (record.readSeq.state === 'known' && record.readSeq.value >= pending)) this.#pendingReads.delete(topic);
    }
    this.#items = Object.freeze([...this.#records.values()].map(record => copyItem(record, this.#pendingReads.get(record.topicKey))));
  }

  #loadPreviews(port: ChatListPort): void {
    if (!this.#canRun() || !this.#previewReady || this.#operation || this.#previewsSuspended || this.#previewPause) return;
    const order = new Map(this.#priority.map((key, index) => [key, index]));
    const records = [...this.#records.values()].sort((a, b) =>
      (order.get(a.topicKey) ?? order.size) - (order.get(b.topicKey) ?? order.size));
    for (const record of records) {
      if (this.#previews.size >= 2) break;
      if (record.preview.state !== 'pending' || this.#previews.has(record.topicKey) ||
        this.#attemptedPreviews.has(record.topicKey)) continue;
      this.#attemptedPreviews.add(record.topicKey);
      const interest: PreviewInterest = { epoch: this.#epoch, abort: new AbortController() };
      this.#previews.set(record.topicKey, interest);
      void this.#readPreview(port, record.topicKey, interest);
    }
  }

  async #readPreview(port: ChatListPort, topicKey: string, interest: PreviewInterest): Promise<void> {
    try {
      if (!this.#previewCurrent(topicKey, interest)) return;
      const result = await port.loadPreview(topicKey, interest.abort.signal);
      if (!this.#previewCurrent(topicKey, interest)) return;
      if (!validScope(result.scope) || this.#scope === undefined || !sameScope(this.#scope, result.scope) ||
        result.topicKey !== topicKey || !Number.isSafeInteger(result.revision) || result.revision < 0) {
        throw new ChatListFailure({ kind: 'invalidResponse', area: 'preview',
          messageCode: 'chatPreviewInvalidResponse', retryable: true });
      }
      if (this.#applyEvent({ kind: 'previewUpdated', ...result })) this.#publishReady();
    } catch (reason: unknown) {
      if (!this.#previewCurrent(topicKey, interest)) return;
      // Del and term cancel the affected stream without ending the chat list session.
      if (reason instanceof DOMException && reason.name === 'AbortError') return;
      const error = requestError(reason, 'preview');
      if (error.kind === 'sessionClosed') { this.dispose(); return; }
      const record = this.#records.get(topicKey);
      if (!record || record.preview.state !== 'pending') return;
      this.#records.set(topicKey, Object.freeze({ ...record,
        preview: Object.freeze({ state: 'unavailable', error,
          ...(record.preview.lastKnown === undefined ? {} : { lastKnown: copyMessage(record.preview.lastKnown) }) }) }));
      this.#rebuildItems();
      this.#publishReady();
    } finally {
      if (this.#previews.get(topicKey) === interest) {
        this.#previews.delete(topicKey);
        if (this.#port === port) this.#loadPreviews(port);
      }
    }
  }

  #previewCurrent(topicKey: string, interest: PreviewInterest): boolean {
    return this.#canRun() && interest.epoch === this.#epoch && !interest.abort.signal.aborted &&
      this.#records.has(topicKey) && this.#previews.get(topicKey) === interest;
  }

  #cancelPreviews(): void {
    for (const interest of this.#previews.values()) interest.abort.abort();
    this.#previews.clear();
    this.#attemptedPreviews.clear();
  }

  #canRun(): boolean { return !this.#disposed && (!this.#managed || this.#owners > 0); }

  #isCurrent(operation: Operation): boolean {
    return this.#canRun() && this.#operation === operation && !operation.abort.signal.aborted;
  }

  #publishProfile(): void {
    if (!this.#canRun()) return;
    if (this.#hasReady) this.#publishReady();
    else if (this.#snapshot.phase !== 'closed') {
      this.#publish(Object.freeze({ ...this.#snapshot, ownProfile: this.#ownProfile }));
    }
  }

  #publishReady(): void {
    if (!this.#canRun()) return;
    this.#publish(Object.freeze({ phase: 'ready', items: this.#items,
      ownProfile: this.#ownProfile, refresh: this.#refresh }));
  }

  #publish(snapshot: ChatListSnapshot): void {
    this.#snapshot = snapshot;
    for (const listener of [...this.#listeners]) {
      if (this.#snapshot !== snapshot) break;
      try { listener(); }
      catch { console.error('Chat list subscriber notification failed.'); }
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    activeControllers.delete(this);
    this.#epoch += 1;
    const operation = this.#operation;
    this.#operation = undefined;
    operation?.abort.abort();
    if (operation) { operation.events.length = 0; operation.resolve(); }
    this.#cancelPreviews();
    const port = this.#port;
    this.#port = undefined;
    try { this.#detachPort(); }
    catch { console.error('Chat list subscription cleanup failed.'); }
    this.#detachPort = () => {};
    try { port?.dispose(); }
    catch { console.error('Chat list port cleanup failed.'); }
    this.#records.clear();
    // The handle belongs to the transition. A late release must not detach its still-open chat.
    this.#previewPause = undefined;
    this.#removedRevisions.clear(); this.#pendingReads.clear();
    this.#items = Object.freeze([]);
    this.#scope = undefined;
    this.#ownProfile = Object.freeze({ state: 'pending' });
    this.#publish(Object.freeze({ phase: 'closed' }));
    this.#listeners.clear();
  }
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    for (const controller of activeControllers) controller.dispose();
  });
}
