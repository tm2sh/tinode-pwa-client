import { normalizeChatSequence } from '../chats/chat-list-normalize';
import type { AvatarResource, ChatSequence, ChatTitle } from '../chats/chat-list-types';
import {
  normalizeConversationIdentity, normalizeConversationMetadata, normalizeConversationPresence,
  normalizeConversationProfile,
} from '../conversation/conversation-normalize';
import type { ConversationPresence } from '../conversation/conversation-types';
import type {
  ChatInfoData, ChatInfoError, ChatInfoIdentity, ChatInfoMuteState, ChatInfoOwnAccess,
  ChatInfoPermissions, ChatInfoSeed, ChatInfoMembersState, ChatInfoMember, ChatInfoLoadedMembers,
} from './chat-info-types';

export type PersonalChatInfoData = Extract<ChatInfoData, { kind: 'personal' }>;
export type GroupChatInfoData = Extract<ChatInfoData, { kind: 'group' }>;
// Client response budget, independent of the group or server limit.
export const chatInfoMemberBudget = 256;
const unknown = Object.freeze({ state: 'unknown' } as const);
const denied = Object.freeze({ state: 'denied', reason: 'notGranted' } as const);
const allowed = Object.freeze({ state: 'allowed' } as const);
const flags = 'JRWPASDO';

export class ChatInfoFailure extends Error {
  readonly chatInfoError: ChatInfoError;
  constructor(error: ChatInfoError) {
    super(error.messageCode);
    this.name = 'ChatInfoFailure';
    this.chatInfoError = Object.freeze({ kind: error.kind, area: error.area,
      messageCode: error.messageCode, retryable: error.retryable,
      ...(integer(error.serverCode, 100) && error.serverCode <= 599 ? { serverCode: error.serverCode } : {}),
    });
  }
}

export function chatInfoFailure(messageCode: ChatInfoError['messageCode'],
  kind: ChatInfoError['kind'], retryable: boolean, area: ChatInfoError['area'] = 'details',
  serverCode?: number): ChatInfoFailure {
  return new ChatInfoFailure({ messageCode, kind, retryable, area,
    ...(serverCode === undefined ? {} : { serverCode }) });
}
function invalid(area: ChatInfoError['area'] = 'details'): ChatInfoFailure {
  return chatInfoFailure('chatInfoInvalidResponse', 'invalidResponse', true, area);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function integer(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}
export function normalizeChatInfoIdentity(value: unknown): ChatInfoIdentity {
  if (!record(value) || !integer(value.panelGeneration)) throw invalid();
  try {
    const identity = normalizeConversationIdentity(value.account as ChatInfoIdentity['account'], value.topicKey);
    if (identity.kind !== value.kind) throw invalid();
    return Object.freeze({ ...identity, panelGeneration: value.panelGeneration });
  } catch { throw invalid(); }
}
export function sameChatInfoIdentity(one: ChatInfoIdentity, two: ChatInfoIdentity): boolean {
  return one.account.serverId === two.account.serverId && one.account.uid === two.account.uid &&
    one.account.generation === two.account.generation && one.topicKey === two.topicKey &&
    one.kind === two.kind && one.panelGeneration === two.panelGeneration;
}
export function chatInfoRevision(value: unknown): number {
  if (!integer(value)) throw invalid();
  return value;
}
function title(value: unknown, uid: string): ChatTitle {
  if (!record(value) || value.state !== 'known' || typeof value.text !== 'string') return unknown;
  try { return normalizeConversationProfile({ public: { fn: value.text } }, uid).displayName; }
  catch { throw invalid(); }
}
function avatar(value: unknown): AvatarResource {
  if (!record(value)) return Object.freeze({ state: 'unavailable' });
  if (value.state === 'ready') {
    const source = value.imageSource;
    return typeof source === 'string' && /^(?:blob:|data:image\/(?:png|jpeg|gif|webp);base64,)/.test(source)
      ? Object.freeze({ state: 'ready', imageSource: source as Extract<AvatarResource, { state: 'ready' }>['imageSource'] })
      : Object.freeze({ state: 'unavailable' });
  }
  return value.state === 'missing' || value.state === 'pending' || value.state === 'unavailable'
    ? Object.freeze({ state: value.state }) : Object.freeze({ state: 'unavailable' });
}
function presence(value: unknown): ConversationPresence {
  if (!record(value)) return unknown;
  return value.state === 'online' ? Object.freeze({ state: 'online' })
    : value.state === 'offline' ? normalizeConversationPresence({ online: false, seen: { when: value.lastSeenAt } })
      : unknown;
}
function sequence(value: unknown): ChatSequence {
  return record(value) && value.state === 'known' ? normalizeChatSequence(value.value) : unknown;
}
export function normalizeChatInfoSeed(value: unknown, context: ChatInfoIdentity): ChatInfoSeed {
  const identity = normalizeChatInfoIdentity(context);
  if (!record(value) || value.kind !== identity.kind) throw invalid();
  const common = { title: title(value.title, identity.account.uid), avatar: avatar(value.avatar) };
  return Object.freeze(identity.kind === 'personal'
    ? { ...common, kind: 'personal', presence: presence(value.presence) }
    : { ...common, kind: 'group', ...((value.isChannel === true || identity.topicKey.startsWith('chn')) ? { isChannel: true as const } : {}), ...(value.participantCount === undefined ? {} : { participantCount: sequence(value.participantCount) }) });
}
function accessBits(value: unknown): number | undefined {
  if (integer(value) && value <= 255) return value;
  if (typeof value !== 'string' || (value !== 'N' && !/^[JRWPASDO]+$/.test(value))) return;
  let bits = 0;
  for (const flag of value === 'N' ? '' : value) bits |= 1 << flags.indexOf(flag);
  return bits;
}
function encode(bits: number): string {
  return [...flags].filter((_, index) => (bits & (1 << index)) !== 0).join('') || 'N';
}
// Return the full want string with only the P bit changed.
export function chatInfoPushWant(want: string, enabled: boolean): string {
  const bits = accessBits(want);
  if (bits === undefined || typeof enabled !== 'boolean' || (bits & 3) !== 3) throw invalid('ownAccess');
  return encode(enabled ? bits | 8 : bits & ~8);
}
export function copyChatInfoMute(value: unknown, confirmed: ChatInfoMuteState): ChatInfoMuteState {
  if (!record(value) || value.state === 'unknown' || value.state === 'confirmed') return confirmed;
  if (confirmed.state !== 'confirmed' || typeof value.target !== 'boolean' ||
    typeof value.previous !== 'boolean' || value.previous !== confirmed.muted) throw invalid('ownAccess');
  if (value.state === 'saving') {
    return Object.freeze({ state: value.state, target: value.target, previous: value.previous });
  }
  if ((value.state !== 'reconciling' && value.state !== 'failed') || !record(value.error) ||
    value.error.area !== 'ownAccess') throw invalid('ownAccess');
  const error = new ChatInfoFailure(value.error as unknown as ChatInfoError).chatInfoError;
  return Object.freeze({ state: value.state, target: value.target, previous: value.previous, error });
}
export function normalizeChatInfoOwnState(value: unknown, context: ChatInfoIdentity): {
  readonly permissions: ChatInfoPermissions; readonly mute: ChatInfoMuteState;
} {
  return normalizeChatOwnState(value, normalizeChatInfoIdentity(context).kind);
}

export function normalizeChatOwnState(value: unknown, kind: ChatInfoIdentity['kind']): {
  readonly permissions: ChatInfoPermissions; readonly mute: ChatInfoMuteState;
} {
  const given = record(value) ? accessBits(value.given) : undefined;
  const want = record(value) ? accessBits(value.want) : undefined;
  const supplied = record(value) ? accessBits(value.mode) : undefined;
  let effective = supplied;
  let ownAccess: ChatInfoOwnAccess = unknown;
  if (given !== undefined && want !== undefined) {
    effective = given & want;
    if (record(value) && value.mode !== undefined && supplied !== effective) throw invalid('ownAccess');
    ownAccess = Object.freeze({ state: 'known', given: encode(given), want: encode(want), mode: encode(effective) });
  }
  if (effective !== undefined && (effective & 3) !== 3) {
    throw chatInfoFailure('chatInfoPermission', 'permission', false, 'ownAccess');
  }
  const known = ownAccess.state === 'known';
  const permissions: ChatInfoPermissions = Object.freeze({ ownAccess,
    canEditGroup: kind === 'personal' ? denied : !known ? unknown : (effective! & 128) !== 0 ? allowed : denied,
    canChangeMute: !known ? unknown : (given! & 8) !== 0 ? allowed : denied,
  });
  return Object.freeze({ permissions, mute: !known ? unknown
    : Object.freeze({ state: 'confirmed', muted: (effective! & 8) === 0 }) });
}

// Compare photos without copying JSON or base64. A missing photo means explicit removal.
export function sameChatInfoPhoto(one: unknown, two: unknown): boolean {
  const a = record(one) ? one.photo : undefined, b = record(two) ? two.photo : undefined;
  const missing = (photo: unknown) => photo === undefined || photo === null || photo === '␡';
  if (missing(a) || missing(b)) return missing(a) && missing(b);
  if (!record(a) || !record(b)) return false;
  return a.type === b.type && a.ref === b.ref && a.data === b.data;
}
export function normalizePersonalChatInfo(packet: unknown, context: ChatInfoIdentity,
  seed: ChatInfoSeed, loadedAvatar?: AvatarResource): PersonalChatInfoData {
  const identity = normalizeChatInfoIdentity(context);
  if (identity.kind !== 'personal') throw chatInfoFailure('chatInfoUnavailable', 'unavailable', false);
  if (!record(packet) || !record(packet.desc)) throw invalid();
  let header;
  try { header = normalizeConversationMetadata(packet, identity, loadedAvatar).header; }
  catch { throw invalid(); }
  if (header.kind !== 'personal') throw invalid();
  const own = normalizeChatInfoOwnState(packet.desc.acs, identity);
  const checkedSeed = normalizeChatInfoSeed(seed, identity);
  const status = checkedSeed.kind === 'personal' && own.permissions.ownAccess.state === 'known' &&
    (accessBits(own.permissions.ownAccess.mode)! & 8) !== 0 ? presence(checkedSeed.presence) : unknown;
  return Object.freeze({ kind: 'personal', peerUid: identity.topicKey,
    title: header.title, avatar: header.avatar, presence: status, ...own });
}

// The controller copies the normalized model so it does not retain a mutable port object.
export function copyPersonalChatInfo(value: unknown, context: ChatInfoIdentity): PersonalChatInfoData {
  const identity = normalizeChatInfoIdentity(context);
  if (!record(value) || identity.kind !== 'personal' || value.kind !== 'personal' || value.peerUid !== identity.topicKey) throw invalid();
  const seed = normalizeChatInfoSeed(value, identity);
  if (seed.kind !== 'personal') throw invalid();
  const raw = record(value.permissions) && record(value.permissions.ownAccess) && value.permissions.ownAccess.state === 'known'
    ? value.permissions.ownAccess : undefined;
  const own = normalizeChatInfoOwnState(raw, identity);
  return Object.freeze({ kind: 'personal', peerUid: identity.topicKey, title: seed.title, avatar: seed.avatar,
    presence: own.permissions.ownAccess.state === 'known' && (accessBits(own.permissions.ownAccess.mode)! & 8) !== 0
      ? presence(seed.presence) : unknown, ...own, mute: copyChatInfoMute(value.mute, own.mute) });
}


export function chatInfoMemberLimit(count: ChatSequence, serverLimit?: number): number {
  const desired = count.state === 'known' && integer(count.value) ? Math.min(count.value, chatInfoMemberBudget - 1) + 1 : chatInfoMemberBudget;
  return Math.max(1, Math.min(desired, integer(serverLimit, 1) ? serverLimit : chatInfoMemberBudget, chatInfoMemberBudget));
}
function groupContext(value: ChatInfoIdentity): ChatInfoIdentity {
  const identity = normalizeChatInfoIdentity(value);
  if (identity.kind !== 'group') throw invalid();
  return identity;
}
function membershipPacket(value: unknown, identity: ChatInfoIdentity): readonly unknown[] {
  if (!record(value) || value.topic !== identity.topicKey) throw chatInfoFailure('chatInfoMembersInvalidResponse', 'invalidResponse', true, 'members');
  if ('code' in value) {
    if (value.code === 204 && record(value.params) && value.params.what === 'sub' && (value.params.count === undefined || value.params.count === 0)) return [];
    throw chatInfoFailure('chatInfoMembersInvalidResponse', 'invalidResponse', true, 'members');
  }
  if (!Array.isArray(value.sub)) throw chatInfoFailure('chatInfoMembersInvalidResponse', 'invalidResponse', true, 'members');
  return value.sub;
}
function effectiveMemberMode(value: unknown): number | undefined {
  if (!record(value)) return;
  const given = accessBits(value.given), want = accessBits(value.want), mode = accessBits(value.mode);
  if ((value.given !== undefined && given === undefined) || (value.want !== undefined && want === undefined)) return;
  if (given !== undefined && want !== undefined) {
    const effective = given & want;
    return value.mode === undefined || mode === effective ? effective : undefined;
  }
  return mode;
}
// A non-truncated roster with full access can correct a stale subcnt in desc.
export function confirmedGroupRosterCount(rows: readonly unknown[], identity: Pick<ChatInfoIdentity, 'topicKey' | 'account'>,
  limit: number, serverLimit?: number): number | undefined {
  const capacity = integer(serverLimit, 1) ? Math.min(limit, serverLimit) : limit;
  if (!identity.topicKey.startsWith('grp') || rows.length === 0 || rows.length >= capacity) return;
  const members = new Set<string>();
  let canSeeAll = false;
  for (const row of rows) {
    if (!record(row) || typeof row.user !== 'string' || !/^usr[A-Za-z0-9_-]+$/.test(row.user) ||
      (row.topic !== undefined && row.topic !== identity.topicKey) ||
      (row.deleted !== undefined && row.deleted !== null && row.deleted !== false) || members.has(row.user)) return;
    members.add(row.user);
    if (row.user === identity.account.uid && record(row.acs) && row.acs.given !== undefined && row.acs.want !== undefined) {
      const mode = effectiveMemberMode(row.acs);
      canSeeAll = mode !== undefined && (mode & 3) === 3 && (mode & (16 | 32 | 128)) !== 0;
    }
  }
  return canSeeAll ? members.size : undefined;
}

function removed(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (value === true || (typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value)))) return true;
  throw chatInfoFailure('chatInfoMembersInvalidResponse', 'invalidResponse', true, 'members');
}
export function canManageChatInfoMembers(identity: ChatInfoIdentity, own: ChatInfoOwnAccess): boolean {
  return identity.kind === 'group' && identity.topicKey.startsWith('grp') &&
    own.state === 'known' && (own.mode.includes('A') || own.mode.includes('O'));
}

function memberRemovable(value: unknown): boolean {
  const mode = effectiveMemberMode(value);
  const want = record(value) ? accessBits(value.want) : undefined;
  return mode !== undefined && (mode & 128) === 0 && want !== undefined && (want & 1) !== 0;
}

export function readChatInfoMember(packet: unknown, identity: ChatInfoIdentity, uid: string): 'absent' | 'removable' | 'protected' {
  const rows = membershipPacket(packet, identity);
  if (rows.length === 0) return 'absent';
  const row = rows[0];
  if (rows.length !== 1 || !record(row) || row.user !== uid ||
    (row.topic !== undefined && row.topic !== identity.topicKey)) throw invalid('members');
  if (removed(row.deleted)) return 'absent';
  return memberRemovable(row.acs) ? 'removable' : 'protected';
}

export function normalizeChatInfoMembers(packet: unknown, context: ChatInfoIdentity, totalCount: ChatSequence,
  limit: number, serverLimit?: number, ownAccess: ChatInfoOwnAccess = unknown, isChannel = false): ChatInfoMembersState {
  const identity = groupContext(context);
  if (identity.topicKey.startsWith('chn')) return Object.freeze({ state: 'unavailable', reason: 'unsupported',
    error: chatInfoFailure('chatInfoMembersUnavailable', 'unavailable', false, 'members').chatInfoError });
  if (!integer(limit, 1) || limit > chatInfoMemberBudget) throw invalid('members');
  const rows = membershipPacket(packet, identity), members = new Map<string, ChatInfoMember>(), seen = new Set<string>();
  let incomplete = false;
  for (const value of rows.slice(0, chatInfoMemberBudget)) {
    if (!record(value) || typeof value.user !== 'string' || !/^usr[A-Za-z0-9_-]+$/.test(value.user) ||
      (value.topic !== undefined && value.topic !== identity.topicKey)) { incomplete = true; continue; }
    if (seen.has(value.user)) incomplete = true;
    seen.add(value.user);
    try { if (removed(value.deleted)) { members.delete(value.user); continue; } }
    catch { members.delete(value.user); incomplete = true; continue; }
    const profile = normalizeConversationProfile({ public: value.public }, value.user);
    const mode = effectiveMemberMode(value.acs);
    members.set(value.user, Object.freeze({ uid: value.user, displayName: profile.displayName, avatar: profile.avatar,
      removable: memberRemovable(value.acs),
      ownership: mode === undefined ? unknown : Object.freeze({ state: (mode & 128) !== 0 ? 'owner' : 'notOwner' }) }));
  }
  const values = Object.freeze([...members.values()]);
  const confirmedCount = !isChannel && !incomplete ? confirmedGroupRosterCount(rows, identity, limit, serverLimit) : undefined;
  const count = isChannel ? unknown : confirmedCount === undefined ? sequence(totalCount) : normalizeChatSequence(confirmedCount);
  if (isChannel && !incomplete && rows.length <= chatInfoMemberBudget) {
    return Object.freeze({ state: 'available', totalCount: unknown, members: values });
  }
  if (!incomplete && rows.length <= chatInfoMemberBudget && count.state === 'known' && count.value === values.length) {
    return Object.freeze({ state: 'ready', totalCount: count, members: values });
  }
  const mode = ownAccess.state === 'known' ? accessBits(ownAccess.mode) : undefined;
  const restricted = mode !== undefined && (mode & 32) === 0 && values.every(value => value.uid === identity.account.uid) &&
    count.state === 'known' && count.value > values.length;
  const reason = rows.length > chatInfoMemberBudget ? 'clientLimit'
    : incomplete ? 'incompleteResponse' : restricted ? 'restricted'
      : count.state === 'known' && integer(serverLimit, 1) && count.value > serverLimit && limit === serverLimit ? 'serverLimit'
        : count.state === 'known' && count.value > chatInfoMemberBudget && limit === chatInfoMemberBudget ? 'clientLimit' : 'incompleteResponse';
  return Object.freeze({ state: 'partial', reason, totalCount: count, members: values });
}

// The member's effective access mode does not expose credentials.
// The current user's sub row can supply want and given when desc omits them.
export function normalizeGroupChatInfo(packet: unknown, context: ChatInfoIdentity,
  members: ChatInfoMembersState, loadedAvatar?: AvatarResource, ownPacket?: unknown): GroupChatInfoData {
  const identity = groupContext(context);
  if (!record(packet) || !record(packet.desc)) throw invalid();
  let header;
  try { header = normalizeConversationMetadata(packet, identity, loadedAvatar).header; } catch { throw invalid(); }
  if (header.kind !== 'group') throw invalid();
  let own = normalizeChatInfoOwnState(packet.desc.acs, identity);
  if (ownPacket !== undefined) {
    const self = membershipPacket(ownPacket, identity).slice(0, chatInfoMemberBudget).filter(value => record(value) && value.user === identity.account.uid &&
      (value.topic === undefined || value.topic === identity.topicKey)).at(-1);
    if (record(self)) {
      if (removed(self.deleted)) throw chatInfoFailure('chatInfoPermission', 'permission', false, 'ownAccess');
      if (self.acs !== undefined) {
        const next = normalizeChatInfoOwnState(self.acs, identity), mode = effectiveMemberMode(self.acs);
        if (own.permissions.ownAccess.state === 'known' && mode !== undefined && accessBits(own.permissions.ownAccess.mode) !== mode) {
          throw chatInfoFailure('chatInfoRefreshFailed', 'unavailable', true, 'ownAccess');
        }
        if (own.permissions.ownAccess.state !== 'known') own = next;
      }
    }
  }
  const participantCount = !header.isChannel && members.state === 'ready' ? members.totalCount : header.participantCount;
  return Object.freeze({ kind: 'group', title: header.title, avatar: header.avatar, participantCount,
    ...(header.isChannel ? { isChannel: true as const } : {}), ...own, members: copyChatInfoMembers(members, header.isChannel === true) });
}

export function copyChatInfoMembers(value: ChatInfoMembersState, isChannel = false): ChatInfoMembersState {
  const loaded = (list: ChatInfoLoadedMembers): ChatInfoLoadedMembers => {
    if (!Array.isArray(list.members) || list.members.length > chatInfoMemberBudget) throw invalid('members');
    const ids = new Set<string>();
    const members = Object.freeze(list.members.map(member => {
      if (!record(member) || typeof member.uid !== 'string' || !/^usr[A-Za-z0-9_-]+$/.test(member.uid) || ids.has(member.uid)) throw invalid('members');
      ids.add(member.uid);
      const state = record(member.ownership) ? member.ownership.state : undefined;
      return Object.freeze({ uid: member.uid, displayName: title(member.displayName, member.uid), avatar: avatar(member.avatar),
        ownership: state === 'owner' || state === 'notOwner' ? Object.freeze({ state }) : unknown,
        removable: state === 'notOwner' && member.removable === true });
    }));
    const common = { members, totalCount: sequence(list.totalCount) };
    if (list.state === 'available') {
      if (!isChannel || common.totalCount.state !== 'unknown') throw invalid('members');
      return Object.freeze({ ...common, state: 'available' });
    }
    if (list.state === 'ready') {
      if (common.totalCount.state !== 'known' || common.totalCount.value !== members.length) throw invalid('members');
      return Object.freeze({ ...common, state: 'ready' });
    }
    if (!['serverLimit', 'clientLimit', 'restricted', 'incompleteResponse'].includes(list.reason)) throw invalid('members');
    return Object.freeze({ ...common, state: 'partial', reason: list.reason });
  };
  if (!record(value as unknown)) throw invalid('members');
  if (value.state === 'ready' || value.state === 'partial' || value.state === 'available') return loaded(value);
  if (value.state === 'loading') return Object.freeze({ state: 'loading', ...(value.lastKnown ? { lastKnown: loaded(value.lastKnown) } : {}) });
  if (value.state !== 'failed' && value.state !== 'unavailable') throw invalid('members');
  const error = new ChatInfoFailure(value.error).chatInfoError;
  if (value.state === 'unavailable') return Object.freeze({ state: 'unavailable', reason: value.reason, error });
  return Object.freeze({ state: 'failed', error, ...(value.lastKnown ? { lastKnown: loaded(value.lastKnown) } : {}) });
}
export function copyChatInfoData(value: ChatInfoData, context: ChatInfoIdentity): ChatInfoData {
  const identity = normalizeChatInfoIdentity(context);
  if (identity.kind === 'personal') return copyPersonalChatInfo(value, identity);
  if (!record(value) || value.kind !== 'group') throw invalid();
  const seed = normalizeChatInfoSeed(value, identity);
  const access = record(value.permissions) && record(value.permissions.ownAccess) && value.permissions.ownAccess.state === 'known'
    ? value.permissions.ownAccess : undefined;
  const isChannel = seed.kind === 'group' && seed.isChannel === true;
  const own = normalizeChatInfoOwnState(access, identity);
  return Object.freeze({ kind: 'group', title: seed.title, avatar: seed.avatar, ...(isChannel ? { isChannel: true as const } : {}),
    participantCount: sequence(value.participantCount), ...own,
    mute: copyChatInfoMute(value.mute, own.mute), members: copyChatInfoMembers(value.members, isChannel) });
}
