import { isGroupTitle, maxGroupAvatarBytes } from '../../chat-info/group-public-patch';
import type { GroupPublicPatch } from '../../chat-info/group-public-patch';
import type { AvatarResource } from '../../chats/chat-list-types';
import type { ChatInfoData, ChatInfoEvent, ChatInfoGroupPatch, ChatInfoGroupSaveResult, ChatInfoIdentity, ChatInfoListener, ChatInfoLoadResult, ChatInfoMuteResult, ChatInfoMuteState, ChatInfoPermissions, ChatInfoMembersState, ChatInfoLoadedMembers, ChatInfoPort, ChatInfoSeed } from '../../chat-info/chat-info-types';
import {
  ChatInfoFailure, chatInfoFailure, chatInfoRevision, copyChatInfoData, chatInfoMemberLimit,
  canManageChatInfoMembers, normalizeChatInfoMembers, normalizeGroupChatInfo, normalizeChatInfoOwnState, readChatInfoMember,
  normalizeChatInfoIdentity, normalizeChatInfoSeed, normalizePersonalChatInfo,
  sameChatInfoIdentity, sameChatInfoPhoto,
} from '../../chat-info/chat-info-normalize';
import { ConversationFailure } from '../../conversation/conversation-normalize';
import { TinodeSessionFailure } from './TinodeSessionScope';
import { changeTinodeChatMute } from './tinode-chat-mute';
import type { TinodeSessionObject } from './TinodeSessionScope';
import type { TinodeChatInfoMetadataResult, TinodeChatInfoSource, TinodeChatInfoSourceEvent, TinodeChatInfoSourceSnapshot } from './TinodeConversationAdapter';
import type { TinodeAvatarLoader } from './tinode-avatar';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function matchesGroupPatch(value: unknown, patch: GroupPublicPatch): boolean {
  if (!record(value) || (patch.fn !== undefined && value.fn !== patch.fn)) return false;
  if (patch.photo === undefined) return true;
  const photo = value.photo;
  return record(photo) && photo.type === patch.photo.type && photo.data === patch.photo.data &&
    (photo.ref === undefined || photo.ref === null || photo.ref === '' || photo.ref === '␡');
}

function aborted(): DOMException { return new DOMException('Chat info interest cancelled.', 'AbortError'); }
function failure(reason: unknown): ChatInfoFailure {
  if (reason instanceof ChatInfoFailure) return reason;
  if (reason instanceof ConversationFailure) {
    const error = reason.conversationError;
    return error.kind === 'sessionClosed' ? chatInfoFailure('chatInfoSessionClosed', 'sessionClosed', false)
      : error.kind === 'permission' ? chatInfoFailure('chatInfoPermission', 'permission', false)
        : chatInfoFailure('chatInfoUnavailable', 'unavailable', error.retryable);
  }
  if (reason instanceof TinodeSessionFailure) {
    if (reason.reason === 'closed') return chatInfoFailure('chatInfoSessionClosed', 'sessionClosed', false);
    if (reason.reason === 'invalidResponse' || reason.reason === 'tooLarge' || reason.reason === 'limitsUnavailable') {
      return chatInfoFailure('chatInfoInvalidResponse', 'invalidResponse', true);
    }
    const code = reason.code;
    if (code === 401 || code === 403) return chatInfoFailure('chatInfoPermission', 'permission', false, 'details', code);
    if (code === 404 || code === 410) return chatInfoFailure('chatInfoUnavailable', 'unavailable', false, 'details', code);
    if (code === 504) return chatInfoFailure('chatInfoTimeout', 'timeout', true, 'details', code);
    return chatInfoFailure('chatInfoNetwork', 'network', code === undefined || code >= 500 || code === 429, 'details', code);
  }
  return chatInfoFailure('chatInfoNetwork', 'network', true);
}

export class TinodeChatInfoAdapter implements ChatInfoPort {
  readonly identity: ChatInfoIdentity;
  readonly seed: ChatInfoSeed;
  readonly #source: TinodeChatInfoSource;
  readonly #avatars: TinodeAvatarLoader;
  readonly #lifetime = new AbortController();
  #closed = false;
  #revision = 0;
  #sourceRevision = 0;
  #avatarVersion = 0;
  #data: ChatInfoData | undefined;
  #profile: unknown;
  #memberProfiles = new Map<string, unknown>();
  #visibleMembers = new Set<string>();
  #memberJobs = new Map<string, object>();
  #memberAttempts = new Set<string>();
  #memberActive = 0;
  #headerActive = 0;
  #pendingHeader: { readonly data: ChatInfoData; readonly profile: unknown; readonly version: number } | undefined;
  #work: Promise<ChatInfoLoadResult> | undefined;
  #muteWork: Promise<ChatInfoMuteResult> | undefined;
  #groupWork: Promise<ChatInfoGroupSaveResult> | undefined;
  #memberWork: Promise<void | readonly string[]> | undefined;
  #rosterNeedsRefresh = false;
  #pendingGroupPatch: GroupPublicPatch | undefined;
  #detachSource: () => void = () => {};
  #listeners = new Set<ChatInfoListener>();

  constructor(source: TinodeChatInfoSource, avatars: TinodeAvatarLoader) {
    this.identity = normalizeChatInfoIdentity(source.identity);
    this.#source = source; this.#avatars = avatars;
    const initial = this.#view();
    this.seed = normalizeChatInfoSeed(initial.seed, this.identity);
    this.#sourceRevision = initial.revision;
    const detach = source.subscribe(this.#onSource);
    this.#detachSource = detach;
    if (!this.active) { detach(); throw chatInfoFailure('chatInfoSessionClosed', 'sessionClosed', false); }
  }
  get active(): boolean { return !this.#closed && this.#source.active; }
  subscribe(listener: ChatInfoListener): () => void {
    if (!this.active) return () => {};
    const wrapped = (event: ChatInfoEvent) => listener(event);
    this.#listeners.add(wrapped);
    return () => { this.#listeners.delete(wrapped); };
  }
  load(signal?: AbortSignal): Promise<ChatInfoLoadResult> {
    if (signal?.aborted) return Promise.reject(aborted());
    if (!this.active) return Promise.reject(chatInfoFailure('chatInfoSessionClosed', 'sessionClosed', false));
    if (this.#muteWork || this.#groupWork || this.#memberWork) return Promise.reject(chatInfoFailure('chatInfoMuteBusy', 'unavailable', true, 'ownAccess'));
    if (!this.#work) {
      const pending = this.#read(); this.#work = pending;
      const finish = () => { if (this.#work === pending) this.#work = undefined; };
      void pending.then(finish, finish);
    }
    return signal ? this.#interest(this.#work, signal) : this.#work;
  }
  setMuted(target: boolean, signal?: AbortSignal): Promise<ChatInfoMuteResult> {
    if (typeof target !== 'boolean') return Promise.reject(chatInfoFailure('chatInfoMuteUnavailable', 'invalidResponse', false, 'ownAccess'));
    if (signal?.aborted) return Promise.reject(aborted());
    if (!this.active) return Promise.reject(chatInfoFailure('chatInfoSessionClosed', 'sessionClosed', false));
    if (this.#work || this.#muteWork || this.#groupWork || this.#memberWork) return Promise.reject(chatInfoFailure('chatInfoMuteBusy', 'unavailable', true, 'ownAccess'));
    const promise = this.#changeMute(target, signal);
    this.#muteWork = promise;
    const finish = () => { if (this.#muteWork === promise) this.#muteWork = undefined; };
    void promise.then(finish, finish);
    return promise;
  }
  async #readOwn(signal?: AbortSignal): Promise<{ permissions: ChatInfoPermissions; mute: ChatInfoMuteState }> {
    if (this.identity.topicKey.startsWith('chn')) {
      // A channel desc may expose a transient mode for an attached reader.
      const own = normalizeChatInfoOwnState(await this.#source.readOwnChannelAccess(signal), this.identity);
      if (own.permissions.ownAccess.state !== 'known') throw chatInfoFailure('chatInfoMuteUnavailable', 'unavailable', true, 'ownAccess');
      return own;
    }
    const response = await this.#source.readMetadata({ what: 'desc' }, signal ?? this.#lifetime.signal);
    this.#assertActive(); this.#answer(response);
    const desc = response.payload.desc;
    if (!record(desc) || desc.deleted) throw chatInfoFailure('chatInfoMuteUnavailable', 'invalidResponse', true, 'ownAccess');
    let own = normalizeChatInfoOwnState(desc.acs, this.identity);
    if (own.permissions.ownAccess.state !== 'known') {
      const response = await this.#source.readMetadata({ what: 'sub', sub: { limit: 1, user: this.identity.account.uid } }, signal ?? this.#lifetime.signal);
      this.#assertActive(); this.#answer(response);
      const rows = response.payload.sub;
      if (!Array.isArray(rows)) throw chatInfoFailure('chatInfoMuteUnavailable', 'invalidResponse', true, 'ownAccess');
      const self = rows.filter(row => record(row) && row.user === this.identity.account.uid && !row.deleted &&
        (row.topic === undefined || row.topic === this.identity.topicKey));
      if (self.length !== 1 || !record(self[0])) throw chatInfoFailure('chatInfoMuteUnavailable', 'invalidResponse', true, 'ownAccess');
      own = normalizeChatInfoOwnState(self[0].acs, this.identity);
    }
    if (own.permissions.ownAccess.state !== 'known' || own.mute.state !== 'confirmed') {
      throw chatInfoFailure('chatInfoMuteUnavailable', 'unavailable', true, 'ownAccess');
    }
    return own;
  }
  #ownResult(permissions: ChatInfoPermissions, mute: ChatInfoMuteState): ChatInfoMuteResult {
    this.#assertActive();
    if (!this.#data || mute.state === 'saving') throw chatInfoFailure('chatInfoMuteUnavailable', 'unavailable', true, 'ownAccess');
    const data = copyChatInfoData({ ...this.#data, permissions, mute }, this.identity);
    if (data.mute.state === 'saving') throw chatInfoFailure('chatInfoMuteUnavailable', 'invalidResponse', true, 'ownAccess');
    this.#data = data;
    const result: ChatInfoMuteResult = Object.freeze({ identity: this.identity, revision: ++this.#revision,
      permissions: data.permissions, mute: data.mute });
    this.#emitOwn(result);
    return result;
  }
  #emitOwn(result: ChatInfoMuteResult): void {
    const event: ChatInfoEvent = Object.freeze({ ...result, kind: 'ownAccessUpdated' });
    for (const listener of [...this.#listeners]) {
      if (!this.active) break;
      try { listener(event); } catch { console.error('Chat info adapter subscriber notification failed.'); }
    }
  }
  async #changeMute(target: boolean, signal?: AbortSignal): Promise<ChatInfoMuteResult> {
    this.#assertActive();
    const confirmed = this.#data?.permissions;
    if (confirmed?.ownAccess.state !== 'known') throw chatInfoFailure('chatInfoMuteUnavailable', 'unavailable', true, 'ownAccess');
    const result = await changeTinodeChatMute({
      topic: this.identity.topicKey, target,
      read: () => this.#readOwn(signal),
      write: (want, enabled) => this.#source.writeOwnPush(want, enabled, signal ?? this.#lifetime.signal),
      report: mode => this.#source.reportOwnPush(mode),
      assertActive: () => {
        this.#assertActive();
        if (signal?.aborted) throw aborted();
      },
    });
    if (result.state === 'confirmed') return this.#ownResult(result.permissions, result.mute);
    const kind = result.state === 'reconciling' ? 'timeout'
      : result.messageCode === 'chatInfoMuteDenied' || result.serverCode !== undefined ? 'permission' : 'unavailable';
    return this.#ownResult(confirmed, {
      state: result.state, target, previous: !confirmed.ownAccess.mode.includes('P'),
      error: chatInfoFailure(result.messageCode, kind, result.messageCode !== 'chatInfoMuteDenied',
        'ownAccess', result.serverCode).chatInfoError,
    });
  }

  saveGroup(patch: ChatInfoGroupPatch, signal?: AbortSignal): Promise<ChatInfoGroupSaveResult> {
    return this.#runGroupSave(false, patch, signal);
  }

  checkGroupSave(signal?: AbortSignal): Promise<ChatInfoGroupSaveResult> {
    return this.#runGroupSave(true, undefined, signal);
  }

  #runGroupSave(checkOnly: boolean, patch: ChatInfoGroupPatch | undefined, signal?: AbortSignal): Promise<ChatInfoGroupSaveResult> {
    if (signal?.aborted) return Promise.reject(aborted());
    if (!this.active) return Promise.reject(chatInfoFailure('chatInfoSessionClosed', 'sessionClosed', false));
    if (this.#work || this.#muteWork || this.#groupWork || this.#memberWork) {
      return Promise.reject(chatInfoFailure('chatInfoGroupSaveBusy', 'unavailable', true, 'groupSave'));
    }
    const work = this.#saveGroup(checkOnly, patch, signal ?? this.#lifetime.signal);
    this.#groupWork = work;
    const finish = () => { if (this.#groupWork === work) this.#groupWork = undefined; };
    void work.then(finish, finish);
    return work;
  }

  async #prepareGroupPatch(patch: ChatInfoGroupPatch | undefined): Promise<GroupPublicPatch> {
    const invalidPatch = () => chatInfoFailure('chatInfoGroupSaveInvalid', 'invalidResponse', false, 'groupSave');
    if (!record(patch) || Object.keys(patch).some(key => key !== 'title' && key !== 'avatar') ||
      (patch.title === undefined && patch.avatar === undefined)) throw invalidPatch();
    const { title, avatar } = patch;
    const fn = typeof title === 'string' ? title.trim() : undefined;
    if (title !== undefined && !isGroupTitle(fn)) throw invalidPatch();
    if (avatar === undefined) return { fn };
    if (!record(avatar)) throw invalidPatch();
    const { blob, edge, photoType } = avatar;
    if (!(blob instanceof Blob) || typeof edge !== 'number' || !Number.isSafeInteger(edge) || edge < 1 || edge > 512 ||
      (photoType !== 'jpeg' && photoType !== 'png') || blob.type !== 'image/' + photoType || blob.size === 0) throw invalidPatch();
    if (blob.size > maxGroupAvatarBytes) throw chatInfoFailure('chatInfoGroupSaveTooLarge', 'invalidResponse', false, 'groupSave');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return { fn, photo: { type: photoType, data: btoa(String.fromCharCode(...bytes)) } };
  }

  async #readGroupDescription(signal: AbortSignal): Promise<TinodeChatInfoMetadataResult> {
    const result = await this.#source.readMetadata({ what: 'desc' }, signal);
    this.#assertActive(); this.#answer(result);
    if (signal.aborted) throw aborted();
    if (result.payload.topic !== this.identity.topicKey || !record(result.payload.desc) || result.payload.desc.deleted) {
      throw chatInfoFailure('chatInfoGroupSaveFailed', 'invalidResponse', true, 'groupSave');
    }
    return result;
  }

  #groupResult(outcome: { state: 'confirmed' } | { state: 'failed' | 'unknown'; error: ChatInfoFailure }): ChatInfoGroupSaveResult {
    const context = { identity: this.identity, revision: ++this.#revision };
    return outcome.state === 'confirmed' ? Object.freeze({ ...context, state: outcome.state })
      : Object.freeze({ ...context, state: outcome.state, error: outcome.error.chatInfoError });
  }

  async #saveGroup(checkOnly: boolean, patch: ChatInfoGroupPatch | undefined, signal: AbortSignal): Promise<ChatInfoGroupSaveResult> {
    const denied = () => chatInfoFailure('chatInfoGroupSaveDenied', 'permission', false, 'groupSave');
    const unknown = () => this.#groupResult({ state: 'unknown',
      error: chatInfoFailure('chatInfoGroupSaveUnknown', 'timeout', true, 'groupSave') });
    let written = false;
    try {
      if (this.#data?.kind !== 'group' || !this.identity.topicKey.startsWith('grp')) throw denied();
      const desired = checkOnly ? this.#pendingGroupPatch : await this.#prepareGroupPatch(patch);
      if (!desired) throw chatInfoFailure('chatInfoGroupSaveInvalid', 'invalidResponse', false, 'groupSave');
      this.#assertActive();
      if (signal.aborted) throw aborted();
      const before = await this.#readGroupDescription(signal);
      const desc = before.payload.desc as Record<string, unknown>;
      if (checkOnly) {
        if (!matchesGroupPatch(desc.public, desired)) return unknown();
        return this.#confirmGroup(before, desired);
      }
      if (normalizeChatInfoOwnState(desc.acs, this.identity).permissions.canEditGroup.state !== 'allowed') throw denied();
      if (matchesGroupPatch(desc.public, desired)) return this.#confirmGroup(before, desired);

      const changes: GroupPublicPatch = {
        ...(desired.fn !== undefined && !matchesGroupPatch(desc.public, { fn: desired.fn }) ? { fn: desired.fn } : {}),
        ...(desired.photo !== undefined && !matchesGroupPatch(desc.public, { photo: desired.photo }) ? { photo: desired.photo } : {}),
      };
      const result = await this.#source.writeGroupPublic(changes, signal);
      this.#assertActive();
      if (signal.aborted) throw aborted();
      if (result.state === 'rejected') {
        if (result.serverCode === 401 || result.serverCode === 403) throw denied();
        if (result.serverCode === 413) throw chatInfoFailure('chatInfoGroupSaveTooLarge', 'invalidResponse', false, 'groupSave', 413);
        throw chatInfoFailure('chatInfoGroupSaveFailed', 'unavailable', true, 'groupSave', result.serverCode);
      }
      written = true;
      this.#pendingGroupPatch = desired;
      const after = await this.#readGroupDescription(signal);
      const readback = after.payload.desc as Record<string, unknown>;
      if (matchesGroupPatch(readback.public, desired)) return this.#confirmGroup(after, desired);
      if (result.state === 'unknown') return unknown();
      this.#pendingGroupPatch = undefined;
      return this.#groupResult({ state: 'failed', error: chatInfoFailure('chatInfoGroupSaveFailed', 'unavailable', true, 'groupSave') });
    } catch (reason: unknown) {
      this.#assertActive();
      if (signal.aborted) throw aborted();
      if (written || (checkOnly && this.#pendingGroupPatch)) return unknown();
      if (reason instanceof ChatInfoFailure) {
        if (reason.chatInfoError.area === 'groupSave') return this.#groupResult({ state: 'failed', error: reason });
        if (reason.chatInfoError.kind === 'permission') return this.#groupResult({ state: 'failed', error: denied() });
      }
      if (reason instanceof TinodeSessionFailure) {
        if (reason.code === 401 || reason.code === 403) return this.#groupResult({ state: 'failed', error: denied() });
        if (reason.reason === 'tooLarge') return this.#groupResult({ state: 'failed',
          error: chatInfoFailure('chatInfoGroupSaveTooLarge', 'invalidResponse', false, 'groupSave') });
        if (reason.reason === 'limitsUnavailable') return this.#groupResult({ state: 'failed',
          error: chatInfoFailure('chatInfoGroupSaveLimits', 'unavailable', true, 'groupSave') });
      }
      return this.#groupResult({ state: 'failed',
        error: chatInfoFailure('chatInfoGroupSaveFailed', 'unavailable', true, 'groupSave') });
    }
  }

  #confirmGroup(result: TinodeChatInfoMetadataResult, patch: GroupPublicPatch): ChatInfoGroupSaveResult {
    const current = this.#data;
    if (current?.kind !== 'group') throw chatInfoFailure('chatInfoGroupSaveFailed', 'invalidResponse', true, 'groupSave');
    const desc = result.payload.desc as Record<string, unknown>;
    const profile = desc.public;
    const loaded = patch.photo && !sameChatInfoPhoto(this.#profile, profile) ? this.#avatars.state(profile) : current.avatar;
    const group = normalizeGroupChatInfo(result.payload, this.identity, current.members, loaded);
    const details = Object.freeze({ kind: 'group' as const, title: patch.fn === undefined ? current.title : group.title,
      avatar: loaded, participantCount: current.participantCount, ...(current.isChannel ? { isChannel: true as const } : {}) });
    this.#data = copyChatInfoData({ ...current, ...details }, this.identity);
    this.#pendingGroupPatch = undefined;
    if (patch.photo && !sameChatInfoPhoto(this.#profile, profile)) {
      this.#avatars.release('header');
      this.#profile = profile;
      const version = ++this.#avatarVersion;
      const data = this.#data;
      if (loaded.state === 'pending') queueMicrotask(() => this.#loadAvatar(data, profile, version));
    }
    this.#emit({ kind: 'detailsUpdated', details });
    this.#source.reportGroupDescription?.(result.payload.desc as TinodeSessionObject);
    return this.#groupResult({ state: 'confirmed' });
  }

  addMembers(uids: readonly string[], signal: AbortSignal): Promise<readonly string[]> {
    if (this.#memberWork || this.#groupWork || this.#muteWork || this.#work) {
      return Promise.reject(chatInfoFailure('chatInfoMemberAddFailed', 'unavailable', true, 'members'));
    }
    const work = this.#addMembers([...new Set(uids)], signal).finally(() => { this.#memberWork = undefined; });
    this.#memberWork = work;
    return work;
  }

  async #addMembers(uids: readonly string[], signal: AbortSignal): Promise<readonly string[]> {
    const denied = () => chatInfoFailure('chatInfoMemberAddDenied', 'permission', false, 'members');
    const current = this.#data;
    if (current?.kind !== 'group' || !canManageChatInfoMembers(this.identity, current.permissions.ownAccess) ||
      uids.some(uid => uid === this.identity.account.uid || !/^usr[A-Za-z0-9_-]+$/.test(uid))) throw denied();
    if (uids.length === 0) return [];

    const check = () => {
      this.#assertActive();
      if (signal.aborted) throw aborted();
    };
    const present = async (uid: string) => {
      const result = await this.#source.readMetadata({ what: 'sub', sub: { limit: 1, user: uid } }, signal);
      check();
      this.#answer(result);
      return readChatInfoMember(result.payload, this.identity, uid) !== 'absent';
    };
    check();
    const description = await this.#readGroupDescription(signal).catch((reason: unknown) => {
      if (reason instanceof TinodeSessionFailure && (reason.code === 401 || reason.code === 403)) throw denied();
      throw chatInfoFailure('chatInfoMemberAddFailed', 'unavailable', true, 'members');
    });
    const desc = description.payload.desc as TinodeSessionObject;
    const own = normalizeChatInfoOwnState(desc.acs, this.identity);
    if (!canManageChatInfoMembers(this.identity, own.permissions.ownAccess)) throw denied();

    const failed: string[] = [];
    for (const uid of uids) {
      check();
      try {
        // A retry must not change permissions of an existing member.
        if (await present(uid)) continue;
        this.#rosterNeedsRefresh = true;
        const result = await this.#source.addMember(uid, signal);
        if (result.state !== 'rejected' && await present(uid)) continue;
      } catch {
        check();
      }
      failed.push(uid);
    }
    return failed;
  }

  removeMember(uid: string, signal: AbortSignal): Promise<void> {
    if (this.#memberWork || this.#groupWork || this.#muteWork || this.#work) {
      return Promise.reject(chatInfoFailure('chatInfoMemberRemoveFailed', 'unavailable', true, 'members'));
    }
    const work = this.#removeMember(uid, signal).finally(() => { this.#memberWork = undefined; });
    this.#memberWork = work;
    return work;
  }

  async #removeMember(uid: string, signal: AbortSignal): Promise<void> {
    const denied = () => chatInfoFailure('chatInfoMemberRemoveDenied', 'permission', false, 'members');
    const failed = () => chatInfoFailure('chatInfoMemberRemoveFailed', 'unavailable', true, 'members');
    const unknown = () => chatInfoFailure('chatInfoMemberRemoveUnknown', 'unavailable', true, 'members');
    const current = this.#data;
    if (current?.kind !== 'group' || !canManageChatInfoMembers(this.identity, current.permissions.ownAccess) ||
      uid === this.identity.account.uid || !/^usr[A-Za-z0-9_-]+$/.test(uid)) throw denied();
    const roster = current.members;
    if ((roster.state !== 'ready' && roster.state !== 'available' && roster.state !== 'partial') ||
      !roster.members.some(member => member.uid === uid && member.removable)) throw denied();

    const check = () => {
      this.#assertActive();
      if (signal.aborted) throw aborted();
    };
    const readMember = async () => {
      const result = await this.#source.readMetadata({ what: 'sub', sub: { limit: 1, user: uid } }, signal);
      check();
      this.#answer(result);
      return readChatInfoMember(result.payload, this.identity, uid);
    };
    const verifyAdmin = (description: TinodeChatInfoMetadataResult) => {
      const desc = description.payload.desc as Record<string, unknown>;
      const own = normalizeChatInfoOwnState(desc.acs, this.identity);
      if (!canManageChatInfoMembers(this.identity, own.permissions.ownAccess)) throw denied();
    };

    let writeStarted = false;
    try {
      check();
      const before = await this.#readGroupDescription(signal);
      verifyAdmin(before);
      const member = await readMember();
      if (member === 'protected') throw denied();
      if (member !== 'absent') {
        writeStarted = true;
        const result = await this.#source.removeMember(uid, signal);
        check();
        if (result.state === 'rejected') {
          writeStarted = false;
          throw result.serverCode === 401 || result.serverCode === 403 ? denied() : failed();
        }
        if (await readMember() !== 'absent') throw result.state === 'unknown' ? unknown() : failed();
      }
      // A hidden row is not proof of deletion if the actor lost moderation rights.
      const after = await this.#readGroupDescription(signal);
      check();
      verifyAdmin(after);
      this.#confirmMemberRemoved(uid, after);
    } catch (reason) {
      check();
      if (reason instanceof ChatInfoFailure && reason.chatInfoError.messageCode.startsWith('chatInfoMemberRemove')) throw reason;
      if (writeStarted) throw unknown();
      if (reason instanceof TinodeSessionFailure && (reason.code === 401 || reason.code === 403)) throw denied();
      throw failed();
    }
  }

  #confirmMemberRemoved(uid: string, result: TinodeChatInfoMetadataResult): void {
    const current = this.#data;
    if (current?.kind !== 'group') return;
    const roster = current.members;
    if (roster.state !== 'ready' && roster.state !== 'available' && roster.state !== 'partial') return;
    const members = roster.members.filter(member => member.uid !== uid);
    if (members.length === roster.members.length) return;
    const desc = result.payload.desc as TinodeSessionObject;
    const header = normalizeGroupChatInfo(result.payload, this.identity, roster, current.avatar);
    const totalCount = roster.state === 'ready' ? { state: 'known' as const, value: members.length }
      : roster.state === 'partial' && roster.totalCount.state === 'known'
        ? { state: 'known' as const, value: Math.max(members.length, roster.totalCount.value - 1) } : roster.totalCount;
    const updated: ChatInfoLoadedMembers = { ...roster, members, totalCount };
    const participantCount = current.isChannel ? header.participantCount : totalCount;
    const details = { kind: 'group' as const, title: current.title, avatar: current.avatar,
      participantCount, ...(current.isChannel ? { isChannel: true as const } : {}) };
    this.#memberProfiles.delete(uid);
    this.#memberJobs.delete(uid);
    this.#memberAttempts.delete(uid);
    this.#avatars.release('member:' + uid);
    this.#data = copyChatInfoData({ ...current, ...details, members: updated }, this.identity);
    if (this.#data.kind === 'group') this.#emit({ kind: 'membersUpdated', members: this.#data.members });
    this.#emit({ kind: 'detailsUpdated', details });
    const rosterCount = !current.isChannel && updated.state === 'ready' && totalCount.state === 'known' ? totalCount.value : undefined;
    this.#source.reportGroupDescription?.(desc, rosterCount);
  }

  async #interest<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    let cancel!: () => void;
    const stop = new Promise<never>((_, reject) => {
      cancel = () => reject(aborted());
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
    });
    try { return await Promise.race([promise, stop]); }
    finally { signal.removeEventListener('abort', cancel); }
  }
  #assertActive(): void {
    if (!this.active || this.#lifetime.signal.aborted) throw chatInfoFailure('chatInfoSessionClosed', 'sessionClosed', false);
  }
  #view(): TinodeChatInfoSourceSnapshot {
    this.#assertActive();
    const view = this.#source.getSnapshot();
    if (!sameChatInfoIdentity(this.identity, normalizeChatInfoIdentity(view.identity)) ||
      chatInfoRevision(view.revision) < this.#sourceRevision || !record(view.cachedDescription)) {
      throw chatInfoFailure('chatInfoInvalidResponse', 'invalidResponse', true);
    }
    return view;
  }
  #answer(value: TinodeChatInfoMetadataResult): void {
    if (!sameChatInfoIdentity(this.identity, normalizeChatInfoIdentity(value.identity))) {
      throw chatInfoFailure('chatInfoInvalidResponse', 'invalidResponse', true);
    }
    chatInfoRevision(value.revision);
  }
  async #read(): Promise<ChatInfoLoadResult> {
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const start = this.#view();
        const response = await this.#source.readMetadata({ what: 'desc' }, this.#lifetime.signal);
        this.#assertActive(); this.#answer(response);
        let current = this.#view();
        if (response.revision !== start.revision || current.revision !== start.revision) continue;
        const payload = response.payload;
        if (!record(payload.desc) || (payload.desc.deleted !== undefined && payload.desc.deleted !== null && payload.desc.deleted !== false)) {
          if (record(payload.desc) && payload.desc.deleted) throw chatInfoFailure('chatInfoUnavailable', 'unavailable', false);
          throw chatInfoFailure('chatInfoInvalidResponse', 'invalidResponse', true);
        }
        const profile = payload.desc.public;
        let loaded: AvatarResource = this.#avatars.state(profile);
        if (sameChatInfoPhoto(profile, current.cachedDescription.public) && current.seed.avatar.state === 'ready') {
          loaded = current.seed.avatar;
        } else if (this.#data?.avatar.state === 'ready' && sameChatInfoPhoto(profile, this.#profile)) loaded = this.#data.avatar;
        let data: ChatInfoData;
        let memberPacket: unknown;
        if (this.identity.kind === 'personal') data = normalizePersonalChatInfo(payload, this.identity, current.seed, loaded);
        else {
          const count = response.participantCountOverride;
          const description = count === undefined ? payload : { ...payload, desc: { ...payload.desc, subcnt: count } };
          const base = normalizeGroupChatInfo(description, this.identity, { state: 'loading' }, loaded);
          // The previously reported count may exclude this batch of new members.
          const limit = chatInfoMemberLimit(this.#rosterNeedsRefresh ? { state: 'unknown' } : base.participantCount, start.subscriberLimit);
          let members: ChatInfoMembersState;
          let ownPacket: unknown;
          if (this.identity.topicKey.startsWith('chn')) {
            // The full group roster may be unavailable to an ordinary channel reader.
            members = normalizeChatInfoMembers(undefined, this.identity, base.participantCount, limit);
          } else {
            try {
              const roster = await this.#source.readMetadata({ what: 'sub', sub: { limit } }, this.#lifetime.signal);
              this.#assertActive(); this.#answer(roster);
              current = this.#view();
              if (roster.revision !== start.revision || current.revision !== start.revision) continue;
              members = normalizeChatInfoMembers(roster.payload, this.identity, base.participantCount, limit,
                start.subscriberLimit, base.permissions.ownAccess, base.isChannel === true);
              ownPacket = roster.payload; memberPacket = roster.payload;
            } catch (reason: unknown) {
              this.#assertActive();
              if (this.#view().revision !== start.revision) continue;
              const error = failure(reason).chatInfoError;
              if (error.kind === 'sessionClosed') throw reason;
              // A failed or timed-out roster request does not invalidate the available chat details.
              const memberError = chatInfoFailure(error.kind === 'permission' ? 'chatInfoMembersPermission'
                : error.kind === 'timeout' ? 'chatInfoMembersTimeout'
                  : error.kind === 'invalidResponse' ? 'chatInfoMembersInvalidResponse' : 'chatInfoMembersUnavailable',
                error.kind, error.retryable, 'members', error.serverCode).chatInfoError;
              const previous = this.#data?.kind === 'group' ? this.#data.members : undefined;
              const lastKnown = previous?.state === 'ready' || previous?.state === 'partial' || previous?.state === 'available' ? previous
                : previous?.state === 'failed' ? previous.lastKnown : undefined;
              members = error.kind === 'permission' ? Object.freeze({ state: 'unavailable', reason: 'permission', error: memberError })
                : Object.freeze({ state: 'failed', error: memberError, ...(lastKnown && error.retryable ? { lastKnown } : {}) });
            }
          }
          data = normalizeGroupChatInfo(description, this.identity, members, loaded, ownPacket);
          if (this.identity.topicKey.startsWith('chn')) {
            let access: unknown;
            try { access = await this.#source.readOwnChannelAccess(this.#lifetime.signal); }
            catch { this.#assertActive(); }
            this.#assertActive();
            if (this.#view().revision !== start.revision) continue;
            data = Object.freeze({ ...data, ...normalizeChatInfoOwnState(access, this.identity) });
          }
        }
        if (data.avatar.state !== 'pending' || !sameChatInfoPhoto(profile, this.#profile)) this.#avatars.release('header');
        const priorData = this.#data;
        if (data.kind === 'group' && record(memberPacket) && Array.isArray(memberPacket.sub) &&
          (data.members.state === 'ready' || data.members.state === 'partial' || data.members.state === 'available')) {
          const ids = new Set(data.members.members.map(member => member.uid)), profiles = new Map<string, unknown>();
          for (const value of memberPacket.sub) if (record(value) && typeof value.user === 'string' && ids.has(value.user) &&
            (value.topic === undefined || value.topic === this.identity.topicKey) && !value.deleted) profiles.set(value.user, value.public);
          const previousMembers = priorData?.kind === 'group' && (priorData.members.state === 'ready' || priorData.members.state === 'partial' || priorData.members.state === 'available')
            ? priorData.members.members : [];
          const members = data.members.members.map(member => {
            const previous = previousMembers.find(row => row.uid === member.uid);
            return this.#visibleMembers.has(member.uid) && previous?.avatar.state === 'ready' &&
              sameChatInfoPhoto(profiles.get(member.uid), this.#memberProfiles.get(member.uid))
              ? Object.freeze({ ...member, avatar: previous.avatar }) : member;
          });
          for (const uid of this.#memberProfiles.keys()) this.#avatars.release('member:' + uid);
          this.#memberJobs.clear(); this.#memberAttempts.clear(); this.#memberProfiles = profiles;
          data = copyChatInfoData({ ...data, members: { ...data.members, members } }, this.identity);
        } else if (data.kind === 'group' && data.members.state === 'unavailable') {
          for (const uid of this.#memberProfiles.keys()) this.#avatars.release('member:' + uid);
          this.#memberJobs.clear(); this.#memberAttempts.clear(); this.#memberProfiles.clear();
        }
        this.#data = data; this.#profile = profile;
        if (data.kind === 'group') {
          const count = !data.isChannel && data.members.state === 'ready' && data.members.totalCount.state === 'known'
            ? data.members.totalCount.value : undefined;
          if (this.#rosterNeedsRefresh || (count !== undefined && count !== payload.desc.subcnt)) {
            this.#rosterNeedsRefresh = !memberPacket;
            this.#source.reportGroupDescription?.(payload.desc as TinodeSessionObject, count);
          }
        }
        const version = ++this.#avatarVersion;
        const result: ChatInfoLoadResult = Object.freeze({ identity: this.identity, revision: ++this.#revision, data });
        if (data.avatar.state === 'pending') queueMicrotask(() => this.#loadAvatar(data, profile, version));
        queueMicrotask(() => this.#pumpMemberAvatars());
        return result;
      }
      throw chatInfoFailure('chatInfoRefreshFailed', 'unavailable', true);
    } catch (reason: unknown) {
      if (this.#closed || this.#lifetime.signal.aborted) throw aborted();
      throw failure(reason);
    }
  }
  #loadAvatar(data: ChatInfoData, profile: unknown, version: number): void {
    if (!this.active || this.#avatarVersion !== version || !this.#data || this.#data.kind !== data.kind) return;
    if (this.#memberActive + this.#headerActive >= 2) { this.#pendingHeader = { data, profile, version }; return; }
    this.#pendingHeader = undefined; this.#headerActive++;
    const finish = (resource: AvatarResource) => {
      if (!this.active || this.#avatarVersion !== version || !this.#data || this.#data.kind !== data.kind) return;
      const updated = copyChatInfoData({ ...this.#data, avatar: resource } as ChatInfoData, this.identity);
      this.#data = updated;
      const details = updated.kind === 'personal'
        ? Object.freeze({ kind: 'personal' as const, peerUid: updated.peerUid,
          title: updated.title, avatar: updated.avatar, presence: updated.presence })
        : Object.freeze({ kind: 'group' as const, title: updated.title, avatar: updated.avatar, participantCount: updated.participantCount, ...(updated.isChannel ? { isChannel: true as const } : {}) });
      this.#emit({ kind: 'detailsUpdated', details });
    };
    void this.#avatars.load('header', profile).then(finish, () => finish({ state: 'unavailable' })).finally(() => {
      this.#headerActive--; this.#pumpMemberAvatars();
    }).catch(() => {});
  }
  setVisibleMembers(uids: readonly string[]): void {
    if (!this.active || this.identity.kind !== 'group' || !Array.isArray(uids)) return;
    const next = new Set(uids.filter(uid => typeof uid === 'string' && this.#memberProfiles.has(uid)).slice(0, 32));
    const changed = new Map<string, AvatarResource>();
    for (const uid of this.#visibleMembers) if (!next.has(uid)) {
      this.#avatars.release('member:' + uid); this.#memberJobs.delete(uid); this.#memberAttempts.delete(uid);
      changed.set(uid, this.#avatars.state(this.#memberProfiles.get(uid)));
    }
    this.#visibleMembers = next;
    this.#patchMemberAvatars(changed); this.#pumpMemberAvatars();
  }
  #patchMemberAvatars(resources: ReadonlyMap<string, AvatarResource>): void {
    const data = this.#data;
    if (!this.active || !resources.size || data?.kind !== 'group') return;
    const list = data.members.state === 'ready' || data.members.state === 'partial' || data.members.state === 'available' ? data.members
      : data.members.state === 'failed' || data.members.state === 'loading' ? data.members.lastKnown : undefined;
    if (!list) return;
    let changed = false;
    const members = list.members.map(member => {
      const resource = resources.get(member.uid);
      if (!resource || (resource.state === member.avatar.state && resource.state !== 'ready')) return member;
      changed = true; return Object.freeze({ ...member, avatar: resource });
    });
    if (!changed) return;
    const loaded = Object.freeze({ ...list, members: Object.freeze(members) });
    const state = data.members.state === 'ready' || data.members.state === 'partial' || data.members.state === 'available' ? loaded
      : Object.freeze({ ...data.members, lastKnown: loaded });
    this.#data = copyChatInfoData({ ...data, members: state }, this.identity);
    this.#emit({ kind: 'membersUpdated', members: this.#data.kind === 'group' ? this.#data.members : state });
  }
  #pumpMemberAvatars(): void {
    if (!this.active) return;
    const header = this.#pendingHeader;
    if (header && this.#memberActive + this.#headerActive < 2) {
      this.#pendingHeader = undefined; this.#loadAvatar(header.data, header.profile, header.version);
    }
    const data = this.#data;
    if (!this.active || data?.kind !== 'group') return;
    const list = data.members.state === 'ready' || data.members.state === 'partial' || data.members.state === 'available' ? data.members
      : data.members.state === 'failed' || data.members.state === 'loading' ? data.members.lastKnown : undefined;
    if (!list) return;
    for (const member of list.members) {
      if (this.#memberActive + this.#headerActive >= 2) return;
      const uid = member.uid;
      if (!this.#visibleMembers.has(uid) || member.avatar.state !== 'pending' || this.#memberAttempts.has(uid)) continue;
      const profile = this.#memberProfiles.get(uid);
      if (!profile) continue;
      const job = {}; this.#memberJobs.set(uid, job); this.#memberAttempts.add(uid); this.#memberActive++;
      void this.#avatars.load('member:' + uid, profile).then(resource => {
        if (this.active && this.#memberJobs.get(uid) === job && this.#visibleMembers.has(uid)) {
          this.#patchMemberAvatars(new Map([[uid, resource]]));
        }
      }, () => {
        if (this.active && this.#memberJobs.get(uid) === job && this.#visibleMembers.has(uid)) {
          this.#patchMemberAvatars(new Map([[uid, { state: 'unavailable' }]]));
        }
      }).finally(() => {
        this.#memberActive--;
        if (this.#memberJobs.get(uid) === job) this.#memberJobs.delete(uid);
        this.#pumpMemberAvatars();
      }).catch(() => {});
    }
  }
  readonly #onSource = (event: TinodeChatInfoSourceEvent): void => {
    if (this.#closed) return;
    try {
      if (!sameChatInfoIdentity(this.identity, normalizeChatInfoIdentity(event.identity)) ||
        chatInfoRevision(event.revision) <= this.#sourceRevision) return;
    } catch { return; }
    this.#sourceRevision = event.revision;
    if (event.kind === 'closed') { this.dispose(); return; }
  };
  #emit(value: { readonly kind: 'detailsUpdated'; readonly details: Extract<ChatInfoEvent, { kind: 'detailsUpdated' }>['details'] }
    | { readonly kind: 'membersUpdated'; readonly members: ChatInfoMembersState }
    | { readonly kind: 'closed' }): void {
    const event: ChatInfoEvent = Object.freeze({ ...value, identity: this.identity, revision: ++this.#revision });
    for (const listener of [...this.#listeners]) {
      if (this.#closed && value.kind !== 'closed') break;
      try { listener(event); } catch { console.error('Chat info adapter subscriber notification failed.'); }
    }
  }
  dispose(): void {
    if (this.#closed) return;
    this.#closed = true; this.#pendingHeader = undefined; this.#avatarVersion++;
    this.#lifetime.abort(); this.#detachSource(); this.#detachSource = () => {};
    this.#avatars.dispose(); this.#data = undefined; this.#profile = undefined; this.#pendingGroupPatch = undefined;
    this.#memberProfiles.clear(); this.#visibleMembers.clear(); this.#memberJobs.clear(); this.#memberAttempts.clear();
    this.#source.dispose();
    this.#emit({ kind: 'closed' }); this.#listeners.clear();
  }
}
