import { ConversationFailure } from '../conversation/conversation-normalize';
import type { ChatInfoAddMembersResult, ChatInfoData, ChatInfoError, ChatInfoEvent, ChatInfoGroupPatch, ChatInfoGroupSaveResult, ChatInfoIdentity, ChatInfoPort, ChatInfoSeed, ChatInfoSnapshot } from './chat-info-types';
import {
  ChatInfoFailure, canManageChatInfoMembers, chatInfoFailure, chatInfoRevision, copyChatInfoData,
  normalizeChatInfoIdentity, normalizeChatInfoSeed, sameChatInfoIdentity,
} from './chat-info-normalize';

interface Operation {
  readonly abort: AbortController;
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly events: Map<string, ChatInfoEvent>;
}
interface GroupOperation {
  readonly abort: AbortController;
  readonly promise: Promise<ChatInfoGroupSaveResult | undefined>;
  readonly resolve: (result?: ChatInfoGroupSaveResult) => void;
}

const idle = Object.freeze({ state: 'idle' } as const);
const pending = Object.freeze({ state: 'pending' } as const);
const unknown = Object.freeze({ state: 'unknown' } as const);
const activeControllers = new Set<ChatInfoController>();
function unavailable(): ChatInfoFailure { return chatInfoFailure('chatInfoUnavailable', 'unavailable', true); }
function invalid(): ChatInfoFailure { return chatInfoFailure('chatInfoInvalidResponse', 'invalidResponse', true); }
function requestError(reason: unknown): ChatInfoError {
  if (reason instanceof ChatInfoFailure) return new ChatInfoFailure(reason.chatInfoError).chatInfoError;
  if (reason instanceof DOMException && reason.name === 'AbortError') return chatInfoFailure('chatInfoSessionClosed', 'sessionClosed', false).chatInfoError;
  if (reason instanceof ConversationFailure) {
    const error = reason.conversationError;
    return error.kind === 'sessionClosed' ? chatInfoFailure('chatInfoSessionClosed', 'sessionClosed', false).chatInfoError
      : error.kind === 'permission' ? chatInfoFailure('chatInfoPermission', 'permission', false).chatInfoError
        : chatInfoFailure('chatInfoUnavailable', 'unavailable', error.retryable).chatInfoError;
  }
  return unavailable().chatInfoError;
}
function terminal(error: ChatInfoError): boolean { return error.kind === 'permission' || error.kind === 'sessionClosed' || !error.retryable; }
function emptySeed(identity: ChatInfoIdentity): ChatInfoSeed {
  return Object.freeze({ kind: identity.kind, title: unknown, avatar: Object.freeze({ state: 'missing' }) });
}

export class ChatInfoController {
  readonly identity: ChatInfoIdentity;
  readonly #openPort: () => Promise<ChatInfoPort>;
  #seed: ChatInfoSeed;
  #snapshot: ChatInfoSnapshot;
  #port: ChatInfoPort | undefined;
  #portPromise: Promise<ChatInfoPort> | undefined;
  #detachPort: () => void = () => {};
  #operation: Operation | undefined;
  #muteOperation: { readonly abort: AbortController; readonly promise: Promise<void>; readonly resolve: () => void } | undefined;
  #groupOperation: GroupOperation | undefined;
  #memberOperation: AbortController | undefined;
  #started = false;
  #disposed = false;
  #latestRevision = 0;
  #detailsRevision = -1;
  #accessRevision = -1;
  #membersRevision = -1;
  #managed = false;
  #owners = 0;
  #ownerVersion = 0;
  #listeners = new Set<() => void>();

  constructor(identity: ChatInfoIdentity, seed: ChatInfoSeed, openPort: () => Promise<ChatInfoPort>) {
    this.identity = normalizeChatInfoIdentity(identity);
    this.#seed = normalizeChatInfoSeed(seed, this.identity);
    this.#openPort = openPort;
    this.#snapshot = Object.freeze({ identity: this.identity, revision: 0, phase: 'idle', seed: this.#seed });
  }
  readonly getSnapshot = (): ChatInfoSnapshot => this.#snapshot;
  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.#disposed) return () => {};
    const wrapped = () => listener(); this.#listeners.add(wrapped);
    return () => { this.#listeners.delete(wrapped); };
  };
  get busy(): boolean { return this.#operation !== undefined || this.#muteOperation !== undefined || this.#groupOperation !== undefined || this.#memberOperation !== undefined; }
  attach(): () => void {
    if (this.#disposed) return () => {};
    this.#managed = true; this.#owners++; this.#ownerVersion++; activeControllers.add(this);
    let attached = true;
    return () => {
      if (!attached) return;
      attached = false; this.#owners--;
      const version = ++this.#ownerVersion;
      queueMicrotask(() => { if (!this.#owners && this.#ownerVersion === version) this.dispose(); });
    };
  }
  #canRun(): boolean { return !this.#disposed && (!this.#managed || this.#owners > 0); }
  readonly setVisibleMembers = (uids: readonly string[]): void => {
    if (this.#canRun() && this.#snapshot.phase === 'ready' && this.#snapshot.data.kind === 'group') this.#port?.setVisibleMembers(uids);
  };
  readonly start = (): Promise<void> => this.#run(false);
  readonly retry = (): Promise<void> => {
    if (this.#operation) return this.#operation.promise;
    const error = this.#snapshot.phase === 'failed' ? this.#snapshot.error
      : this.#snapshot.phase === 'ready' && this.#snapshot.refresh.state === 'failed' ? this.#snapshot.refresh.error : undefined;
    return error && !error.retryable ? Promise.resolve() : this.#run(true);
  };
  readonly setMuted = (target: boolean): Promise<void> => {
    if (!this.#canRun() || typeof target !== 'boolean') return Promise.resolve();
    if (this.#muteOperation) return this.#muteOperation.promise;
    if (this.#operation || this.#groupOperation || this.#memberOperation || this.#snapshot.phase !== 'ready' || !this.#port) return Promise.resolve();
    const current = this.#snapshot.data;
    if (current.permissions.ownAccess.state !== 'known' ||
      ((current.mute.state === 'failed' || current.mute.state === 'reconciling') && !current.mute.error.retryable)) return Promise.resolve();
    const previous = !current.permissions.ownAccess.mode.includes('P');
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    const operation = { abort: new AbortController(), promise, resolve };
    this.#muteOperation = operation;
    this.#publish(Object.freeze({ ...this.#snapshot, data: copyChatInfoData({ ...current,
      mute: { state: 'saving', target, previous } }, this.identity) }));
    const port = this.#port;
    void Promise.resolve().then(() => {
      if (!this.#canRun() || this.#muteOperation !== operation) return;
      return port.setMuted(target, operation.abort.signal);
    }).then(result => {
      if (!result || !this.#canRun() || this.#muteOperation !== operation) return;
      if (!sameChatInfoIdentity(this.identity, normalizeChatInfoIdentity(result.identity))) throw invalid();
      chatInfoRevision(result.revision);
      this.#onEvent(Object.freeze({ ...result, kind: 'ownAccessUpdated' }));
    }).catch((reason: unknown) => {
      if (!this.#canRun() || this.#muteOperation !== operation || this.#snapshot.phase !== 'ready') return;
      const error = reason instanceof ChatInfoFailure && reason.chatInfoError.area === 'ownAccess' ? reason.chatInfoError
        : chatInfoFailure('chatInfoMuteUnavailable', 'unavailable', true, 'ownAccess').chatInfoError;
      const data = this.#snapshot.data;
      this.#publish(Object.freeze({ ...this.#snapshot, data: copyChatInfoData({ ...data,
        mute: { state: 'failed', target, previous, error } }, this.identity) }));
    }).finally(() => {
      if (this.#muteOperation === operation) this.#muteOperation = undefined;
      resolve();
    });
    return promise;
  };

  readonly saveGroup = (patch: ChatInfoGroupPatch): Promise<ChatInfoGroupSaveResult | undefined> =>
    this.#runGroupSave('saving', (port, signal) => port.saveGroup(patch, signal));

  readonly checkGroupSave = (): Promise<ChatInfoGroupSaveResult | undefined> =>
    this.#runGroupSave('checking', (port, signal) => port.checkGroupSave(signal));

  #runGroupSave(state: 'saving' | 'checking',
    run: (port: ChatInfoPort, signal: AbortSignal) => Promise<ChatInfoGroupSaveResult>): Promise<ChatInfoGroupSaveResult | undefined> {
    if (this.#groupOperation) return this.#groupOperation.promise;
    const snapshot = this.#snapshot, port = this.#port;
    if (!this.#canRun() || this.#operation || this.#muteOperation || this.#memberOperation || !port || snapshot.phase !== 'ready' ||
      snapshot.data.kind !== 'group' || (state === 'checking' && snapshot.groupSave?.state !== 'unknown')) return Promise.resolve(undefined);
    let resolve!: GroupOperation['resolve'];
    const promise = new Promise<ChatInfoGroupSaveResult | undefined>(done => { resolve = done; });
    const operation = { abort: new AbortController(), promise, resolve };
    this.#groupOperation = operation;
    this.#publish(Object.freeze({ ...snapshot, groupSave: Object.freeze({ state }) }));

    const active = () => this.#canRun() && this.#groupOperation === operation && !operation.abort.signal.aborted;
    void Promise.resolve().then(async () => {
      if (!active()) return undefined;
      const result = await run(port, operation.abort.signal);
      if (!active()) return undefined;
      if (!sameChatInfoIdentity(this.identity, normalizeChatInfoIdentity(result.identity))) throw invalid();
      const revision = chatInfoRevision(result.revision);
      this.#latestRevision = Math.max(this.#latestRevision, revision);
      return result;
    }).catch((reason: unknown): ChatInfoGroupSaveResult => Object.freeze({
      identity: this.identity, revision: this.#latestRevision, state: state === 'checking' ? 'unknown' : 'failed',
      error: reason instanceof ChatInfoFailure && reason.chatInfoError.area === 'groupSave' ? reason.chatInfoError
        : chatInfoFailure(state === 'checking' ? 'chatInfoGroupSaveUnknown' : 'chatInfoGroupSaveFailed', 'unavailable', true, 'groupSave').chatInfoError,
    })).then(result => {
      if (!active()) return resolve();
      this.#groupOperation = undefined;
      if (result && this.#snapshot.phase === 'ready') {
        this.#publish(Object.freeze({ ...this.#snapshot, revision: this.#latestRevision, groupSave: result }));
      }
      resolve(result);
    });
    return promise;
  }

  readonly removeMember = async (uid: string): Promise<ChatInfoError | undefined> => {
    const snapshot = this.#snapshot, port = this.#port;
    if (!this.#canRun() || this.busy || !port || snapshot.phase !== 'ready' || snapshot.data.kind !== 'group' ||
      uid === this.identity.account.uid || !canManageChatInfoMembers(this.identity, snapshot.data.permissions.ownAccess)) {
      return chatInfoFailure('chatInfoMemberRemoveDenied', 'permission', false, 'members').chatInfoError;
    }
    const operation = new AbortController();
    this.#memberOperation = operation;
    this.#publish(Object.freeze({ ...snapshot, removingMember: uid }));
    try {
      if (!operation.signal.aborted) await port.removeMember(uid, operation.signal);
    } catch (reason) {
      if (!operation.signal.aborted) {
        return reason instanceof ChatInfoFailure && reason.chatInfoError.area === 'members' ? reason.chatInfoError
          : chatInfoFailure('chatInfoMemberRemoveFailed', 'unavailable', true, 'members').chatInfoError;
      }
    } finally {
      if (this.#memberOperation === operation) {
        this.#memberOperation = undefined;
        if (this.#snapshot.phase === 'ready') this.#publish(Object.freeze({ ...this.#snapshot, removingMember: undefined }));
      }
    }
  };

  readonly addMembers = async (uids: readonly string[]): Promise<ChatInfoAddMembersResult> => {
    const snapshot = this.#snapshot, port = this.#port;
    if (!this.#canRun() || this.busy || !port || snapshot.phase !== 'ready' || snapshot.data.kind !== 'group' ||
      !canManageChatInfoMembers(this.identity, snapshot.data.permissions.ownAccess)) {
      return { failed: uids, error: chatInfoFailure('chatInfoMemberAddDenied', 'permission', false, 'members').chatInfoError };
    }
    const operation = new AbortController();
    this.#memberOperation = operation;
    let failed: readonly string[];
    try {
      failed = await port.addMembers(uids, operation.signal);
    } catch (reason) {
      return { failed: uids, error: reason instanceof ChatInfoFailure && reason.chatInfoError.area === 'members'
        ? reason.chatInfoError : chatInfoFailure('chatInfoMemberAddFailed', 'unavailable', true, 'members').chatInfoError };
    } finally {
      if (this.#memberOperation === operation) this.#memberOperation = undefined;
    }
    if (operation.signal.aborted || !this.#canRun()) return { failed: uids };
    await this.#run(true);
    const current = this.#snapshot;
    const roster = current.phase === 'ready' && current.data.kind === 'group' ? current.data.members : undefined;
    if (roster?.state === 'ready' || roster?.state === 'available' || roster?.state === 'partial') {
      const members = new Set(roster.members.map(member => member.uid));
      failed = failed.filter(uid => !members.has(uid));
    }
    return { failed, ...(failed.length === uids.length ? {
      error: chatInfoFailure('chatInfoMemberAddFailed', 'unavailable', true, 'members').chatInfoError,
    } : {}) };
  };

  #run(force: boolean): Promise<void> {
    if (!this.#canRun() || this.#memberOperation) return Promise.resolve();
    if (this.#muteOperation) return this.#muteOperation.promise;
    if (this.#groupOperation) return this.#groupOperation.promise.then(() => undefined);
    if (this.#operation) return this.#operation.promise;
    if (this.#started && !force) return Promise.resolve();
    this.#started = true;
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    const operation: Operation = { abort: new AbortController(), promise, resolve, events: new Map() };
    this.#operation = operation;
    this.#publish(this.#snapshot.phase === 'ready'
      ? Object.freeze({ ...this.#snapshot, refresh: pending })
      : Object.freeze({ identity: this.identity, revision: this.#latestRevision, phase: 'loading', seed: this.#seed }));
    if (this.#current(operation)) void this.#load(operation);
    else { if (this.#operation === operation) this.#operation = undefined; resolve(); }
    return promise;
  }
  #current(operation: Operation): boolean { return this.#canRun() && this.#operation === operation && !operation.abort.signal.aborted; }
  #getPort(): Promise<ChatInfoPort> {
    if (this.#port) return Promise.resolve(this.#port);
    if (this.#portPromise) return this.#portPromise;
    const promise = Promise.resolve().then(() => {
      if (!this.#canRun()) throw unavailable();
      return this.#openPort();
    }).then(port => {
      if (!this.#canRun()) { port.dispose(); throw unavailable(); }
      try {
        if (!sameChatInfoIdentity(this.identity, normalizeChatInfoIdentity(port.identity))) throw invalid();
        const seed = normalizeChatInfoSeed(port.seed, this.identity);
        this.#port = port; this.#seed = seed;
        const detach = port.subscribe(this.#onEvent);
        if (!this.#canRun() || this.#port !== port) { detach(); port.dispose(); throw unavailable(); }
        this.#detachPort = detach;
        if (this.#snapshot.phase === 'loading') this.#publish(Object.freeze({ ...this.#snapshot, seed }));
        return port;
      } catch (reason: unknown) {
        if (this.#port === port) this.#dropPort(); else port.dispose();
        throw reason;
      }
    }).finally(() => { if (this.#portPromise === promise) this.#portPromise = undefined; });
    this.#portPromise = promise;
    return promise;
  }
  async #load(operation: Operation): Promise<void> {
    try {
      const port = await this.#getPort();
      if (!this.#current(operation)) return;
      const result = await port.load(operation.abort.signal);
      if (!this.#current(operation)) return;
      if (!sameChatInfoIdentity(this.identity, normalizeChatInfoIdentity(result.identity))) throw invalid();
      const revision = chatInfoRevision(result.revision);
      const data = copyChatInfoData(result.data, this.identity);
      this.#detailsRevision = revision; this.#accessRevision = revision; this.#membersRevision = revision;
      this.#latestRevision = Math.max(this.#latestRevision, revision);
      let next: ChatInfoSnapshot = Object.freeze({ identity: this.identity, revision: this.#latestRevision, phase: 'ready', data, refresh: idle });
      for (const event of [...operation.events.values()].sort((a, b) => a.revision - b.revision)) next = this.#apply(next, event);
      if (this.#current(operation)) this.#publish(next);
    } catch (reason: unknown) {
      if (this.#current(operation)) this.#showError(requestError(reason));
    } finally {
      operation.events.clear();
      if (this.#operation === operation) this.#operation = undefined;
      operation.resolve();
    }
  }
  readonly #onEvent = (event: ChatInfoEvent): void => {
    if (!this.#canRun()) return;
    try {
      if (!sameChatInfoIdentity(this.identity, normalizeChatInfoIdentity(event.identity))) return;
      chatInfoRevision(event.revision);
    } catch { return; }
    // Keep the current snapshot while the panel is open, even if the server signals a change.
    if (event.kind === 'invalidated') return;
    this.#latestRevision = Math.max(this.#latestRevision, event.revision);
    if (event.kind === 'closed') { this.dispose(); return; }
    if (event.kind === 'unavailable') {
      this.#cancelOperation(); this.#showError(requestError(new ChatInfoFailure(event.error))); return;
    }
    if (this.#operation) {
      const previous = this.#operation.events.get(event.kind);
      if (!previous || previous.revision < event.revision) this.#operation.events.set(event.kind, event);
    } else {
      try { this.#publish(this.#apply(this.#snapshot, event)); }
      catch (reason: unknown) { this.#showError(requestError(reason)); }
    }
  };
  #apply(snapshot: ChatInfoSnapshot, event: ChatInfoEvent): ChatInfoSnapshot {
    if (snapshot.phase !== 'ready') return snapshot;
    let data: ChatInfoData = snapshot.data;
    if (event.kind === 'detailsUpdated' && event.revision > this.#detailsRevision) {
      if (event.details.kind !== data.kind) throw invalid();
      data = copyChatInfoData({ ...data, ...event.details } as ChatInfoData, this.identity); this.#detailsRevision = event.revision;
    } else if (event.kind === 'membersUpdated' && data.kind === 'group' && event.revision > this.#membersRevision) {
      data = copyChatInfoData({ ...data, members: event.members }, this.identity); this.#membersRevision = event.revision;
    } else if (event.kind === 'ownAccessUpdated' && event.revision > this.#accessRevision) {
      data = copyChatInfoData({ ...data, permissions: event.permissions, mute: event.mute }, this.identity); this.#accessRevision = event.revision;
    } else return snapshot;
    return Object.freeze({ ...snapshot, revision: Math.max(snapshot.revision, event.revision), data });
  }
  #showError(error: ChatInfoError): void {
    if (this.#disposed) return;
    if (!terminal(error) && this.#snapshot.phase === 'ready') {
      this.#publish(Object.freeze({ ...this.#snapshot, revision: this.#latestRevision,
        refresh: Object.freeze({ state: 'failed', error }) })); return;
    }
    if (terminal(error)) { this.#dropPort(); this.#seed = emptySeed(this.identity); }
    this.#publish(Object.freeze({ identity: this.identity, revision: this.#latestRevision, phase: 'failed', error,
      ...(terminal(error) ? {} : { seed: this.#seed }) }));
  }
  #cancelOperation(): void {
    const member = this.#memberOperation; this.#memberOperation = undefined;
    member?.abort();
    const group = this.#groupOperation; this.#groupOperation = undefined;
    group?.abort.abort(); group?.resolve();
    const mute = this.#muteOperation; this.#muteOperation = undefined;
    mute?.abort.abort(); mute?.resolve();
    const operation = this.#operation; this.#operation = undefined;
    operation?.abort.abort(); operation?.events.clear(); operation?.resolve();
  }
  #dropPort(): void {
    const port = this.#port; this.#port = undefined;
    try { this.#detachPort(); } catch { console.error('Chat info subscription cleanup failed.'); }
    this.#detachPort = () => {};
    try { port?.dispose(); } catch { console.error('Chat info port cleanup failed.'); }
  }
  #publish(snapshot: ChatInfoSnapshot): void {
    if (snapshot === this.#snapshot) return;
    this.#snapshot = snapshot;
    for (const listener of [...this.#listeners]) {
      try { listener(); } catch { console.error('Chat info controller subscriber notification failed.'); }
    }
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true; activeControllers.delete(this); this.#cancelOperation(); this.#dropPort();
    this.#portPromise = undefined; this.#seed = emptySeed(this.identity);
    this.#publish(Object.freeze({ identity: this.identity, revision: this.#latestRevision, phase: 'closed' }));
    this.#listeners.clear();
  }
}
if (import.meta.hot) import.meta.hot.dispose(() => {
  for (const controller of activeControllers) controller.dispose();
});
