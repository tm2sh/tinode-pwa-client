import { replacementMessageSeq } from '../conversation/message-replacement';
import type {
  AvatarResource, ChatActionTopic, ChatKind, ChatListError, ChatListEvent, ChatRecord, ChatRecordUpdateField, ChatSequence,
  ChatTitle, ChatUnreadCount, CurrentUserProfile, LastMessage, MessagePreviewContent, ServerTimestamp,
} from './chat-list-types';

import { normalizeConversationDraft } from '../conversation/ConversationDraft';

export class ChatListFailure extends Error {
  readonly chatListError: ChatListError;

  constructor(error: ChatListError) {
    super(error.messageCode);
    this.name = 'ChatListFailure';
    this.chatListError = Object.freeze({
      kind: error.kind, area: error.area, messageCode: error.messageCode, retryable: error.retryable,
      ...(error.serverCode === undefined ? {} : { serverCode: error.serverCode }),
      ...(error.messageParams === undefined ? {} : {
        messageParams: Object.freeze({ seconds: error.messageParams.seconds }),
      }),
    });
  }
}

const unknown = Object.freeze({ state: 'unknown' } as const);
const pendingPreview = Object.freeze({ state: 'pending' } as const);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalid(area: 'list' | 'profile' | 'preview'): ChatListFailure {
  return new ChatListFailure({ kind: 'invalidResponse', area, retryable: true,
    messageCode: area === 'list' ? 'chatListInvalidResponse'
      : area === 'preview' ? 'chatPreviewInvalidResponse' : 'chatProfileUnavailable' });
}

export function normalizeChatSequence(value: unknown): ChatSequence {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? Object.freeze({ state: 'known', value }) : unknown;
}

// In a complete server snapshot with confirmed read access, Tinode's Go model
// omits zero seq values. An omission in a patch or a hidden counter stays unknown.
export function normalizeSnapshotSequence(value: unknown, readableFullSnapshot: boolean): ChatSequence {
  return value === undefined && readableFullSnapshot
    ? Object.freeze({ state: 'known', value: 0 }) : normalizeChatSequence(value);
}

export function normalizeServerTimestamp(value: unknown): ServerTimestamp | undefined {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : undefined;
  }
  if (typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return undefined;
  const iso = date.toISOString();
  // Reject calendar overflow, such as February 30 rolling over to another date.
  return iso.slice(0, 19) === value.slice(0, 19) ? iso : undefined;
}

export function normalizeChatTitle(profile: unknown): ChatTitle {
  return isRecord(profile) && typeof profile.fn === 'string' && profile.fn.trim() !== ''
    ? Object.freeze({ state: 'known', text: profile.fn }) : unknown;
}

function avatarMetadata(profile: unknown): AvatarResource {
  const photo = isRecord(profile) ? profile.photo : undefined;
  if (photo === undefined || photo === null || photo === '␡') {
    return Object.freeze({ state: 'missing' });
  }
  if (isRecord(photo) &&
    ((typeof photo.ref === 'string' && photo.ref.trim() !== '' && photo.ref !== '␡') ||
      (typeof photo.data === 'string' && photo.data.trim() !== '' && photo.data !== '␡'))) {
    return Object.freeze({ state: 'pending' });
  }
  return Object.freeze({ state: 'unavailable' });
}

function kindOf(topic: string): ChatKind | undefined {
  if (/^usr[A-Za-z0-9_-]+$/.test(topic)) return 'personal';
  if (/^(?:grp|chn)[A-Za-z0-9_-]+$/.test(topic)) return 'group';
  return undefined;
}

function isUnsupportedTopic(topic: string): boolean {
  return topic === 'me' || topic === 'fnd' || /^(?:sys|slf)[A-Za-z0-9_-]*$/.test(topic);
}

function isDeleted(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (value === true || normalizeServerTimestamp(value) !== undefined) return true;
  throw invalid('list');
}

export function unreadCount(seq: ChatSequence, read: ChatSequence): ChatUnreadCount {
  if (seq.state !== 'known') return unknown;
  if (read.state === 'known' && read.value > seq.value) return unknown;
  if (seq.value === 0) return Object.freeze({ state: 'known', value: 0 });
  return read.state === 'known'
    ? Object.freeze({ state: 'known', value: seq.value - read.value }) : unknown;
}

function accessMask(mode: unknown): number | undefined {
  if (typeof mode === 'number' && Number.isSafeInteger(mode) && mode >= 0 && mode <= 255) return mode;
  if (mode === 'N') return 0;
  if (typeof mode !== 'string' || !/^[JRWPASDO]+$/.test(mode)) return undefined;
  let mask = 0;
  for (const flag of mode) mask |= 1 << 'JRWPASDO'.indexOf(flag);
  return mask;
}

// Get effective permissions from the confirmed subscription without applying pres deltas.
export function normalizeChatPermissions(value: unknown): { readonly joined: boolean; readonly readable: boolean; readonly notificationsMuted: boolean } | undefined {
  if (!isRecord(value) || value.mode === undefined || value.mode === null) return undefined;
  const mask = accessMask(value.mode);
  if (mask === undefined) throw invalid('list');
  return Object.freeze({ joined: (mask & 1) !== 0, readable: (mask & 2) !== 0, notificationsMuted: (mask & 8) === 0 });
}

export function normalizeChatActionTopic(topicKey: string, chan: unknown, acs: unknown,
  source: 'subscription' | 'description'): ChatActionTopic {
  if (topicKey.startsWith('usr')) return Object.freeze({ kind: 'personal', role: 'member' });
  if (topicKey.startsWith('chn')) return Object.freeze({ kind: 'channel', role: 'member' });
  // Tinode omits false in a topic description. A subscription row may omit chan for either type.
  const kind = chan === true ? 'channel'
    : chan === false || (source === 'description' && chan === undefined) ? 'group' : 'unknown';
  let role: ChatActionTopic['role'] = 'unknown';
  if (isRecord(acs)) {
    const want = accessMask(acs.want), given = accessMask(acs.given);
    if (want !== undefined && given !== undefined) {
      const effective = want & given;
      if ((effective & 1) !== 0 && (acs.mode === undefined || accessMask(acs.mode) === effective)) {
        role = (effective & 128) !== 0 ? 'owner' : 'member';
      }
    }
  }
  return Object.freeze({ kind, role });
}

export function normalizeChatSubscription(value: unknown, revision: number, completeSnapshot = false): ChatRecord | undefined {
  if (!isRecord(value) || typeof value.topic !== 'string' ||
    !Number.isSafeInteger(revision) || revision < 0) throw invalid('list');
  const topicKey = value.topic;
  if (isUnsupportedTopic(topicKey)) return undefined;
  const kind = kindOf(topicKey);
  if (!kind) throw invalid('list');
  const access = normalizeChatPermissions(value.acs);
  if (isDeleted(value.deleted) || access?.joined === false) return undefined;
  const serverSeq = normalizeSnapshotSequence(value.seq, completeSnapshot && access?.readable === true);
  // Tinode omits read=0 in me.sub. An explicit null or invalid number stays unknown.
  const readSeq: ChatSequence = value.read === undefined
    ? Object.freeze({ state: 'known', value: 0 }) : normalizeChatSequence(value.read);
  const inconsistent = serverSeq.state === 'known' && readSeq.state === 'known' &&
    readSeq.value > serverSeq.value;
  const empty = serverSeq.state === 'known' && serverSeq.value === 0 && !inconsistent;
  const touched = serverSeq.state === 'known' && serverSeq.value > 0
    ? normalizeServerTimestamp(value.touched) : undefined;
  return Object.freeze({
    topicKey, kind, actionTopic: normalizeChatActionTopic(topicKey, value.chan, value.acs, 'subscription'),
    title: normalizeChatTitle(value.public), avatar: avatarMetadata(value.public),
    draft: normalizeConversationDraft(value.draft),
    ...(access === undefined ? {} : { notificationsMuted: access.notificationsMuted }),
    ...(kind === 'group' ? { participantCount: normalizeChatSequence(value.subcnt) } : {}),
    serverSeq, readSeq, unread: unreadCount(serverSeq, readSeq), revision,
    preview: empty ? Object.freeze({ state: 'empty', reason: 'noMessages' }) : pendingPreview,
    lastActivityAt: touched === undefined ? unknown
      : Object.freeze({ state: 'known', at: touched, source: 'subscription' }),
  });
}

export function normalizeChatSubscriptions(response: unknown, revision: number): readonly ChatRecord[] {
  if (!isRecord(response) || response.topic !== 'me' ||
    !Number.isSafeInteger(revision) || revision < 0) throw invalid('list');
  if ('code' in response) {
    if (response.code === 204 && isRecord(response.params) && response.params.what === 'sub' &&
      (response.params.count === undefined || response.params.count === 0)) return Object.freeze([]);
    throw invalid('list');
  }
  if (!Array.isArray(response.sub)) throw invalid('list');
  const records = new Map<string, { record?: ChatRecord; version?: number }>();
  for (const row of response.sub) {
    const record = normalizeChatSubscription(row, revision, true);
    if (!isRecord(row) || typeof row.topic !== 'string') throw invalid('list');
    if (isUnsupportedTopic(row.topic)) continue;
    const updated = normalizeServerTimestamp(row.updated);
    const deleted = normalizeServerTimestamp(row.deleted);
    const dates = [updated, deleted].filter((date): date is string => date !== undefined);
    const version = dates.length ? Math.max(...dates.map((date) => Date.parse(date))) : undefined;
    const previous = records.get(row.topic);
    if (previous?.version !== undefined && version !== undefined && previous.version > version) continue;
    // With equal or unknown versions, use the last server row, including a tombstone.
    records.set(row.topic, { record, version });
  }
  return Object.freeze([...records.values()].flatMap(({ record }) => record === undefined ? [] : [record]));
}

export function normalizeOwnProfile(response: unknown): CurrentUserProfile {
  if (!isRecord(response) || response.topic !== 'me' || 'code' in response || !isRecord(response.desc)) {
    throw invalid('profile');
  }
  return Object.freeze({ state: 'available',
    displayName: normalizeChatTitle(response.desc.public), avatar: avatarMetadata(response.desc.public) });
}


function previewContent(content: unknown, head: unknown): MessagePreviewContent {
  const unsupported = (): MessagePreviewContent => Object.freeze({ kind: 'unsupported' });
  const mime = isRecord(head) ? head.mime : undefined;
  if (mime !== undefined && mime !== null && mime !== '' &&
    mime !== 'text/plain' && mime !== 'text/x-drafty') return unsupported();
  if (typeof content === 'string') {
    return content.trim() === '' ? unsupported() : Object.freeze({ kind: 'text', text: content });
  }
  if (!isRecord(content)) return unsupported();
  if (content.txt !== undefined && content.txt !== null && typeof content.txt !== 'string') return unsupported();
  if (content.fmt !== undefined && content.fmt !== null && !Array.isArray(content.fmt)) return unsupported();
  if (content.ent !== undefined && content.ent !== null && !Array.isArray(content.ent)) return unsupported();
  const text = typeof content.txt === 'string' ? content.txt.replace(/\uFFFC/g, '').trim() : '';
  const entities: unknown[] = Array.isArray(content.ent) ? content.ent : [];
  const formats: unknown[] = Array.isArray(content.fmt) ? content.fmt : [];
  const media = new Set<'photo' | 'voice' | 'video' | 'file'>();
  for (const format of formats) {
    if (!isRecord(format)) return unsupported();
    if (format.at !== undefined && (typeof format.at !== 'number' ||
      !Number.isSafeInteger(format.at) || format.at < -1)) return unsupported();
    if (format.len !== undefined && (typeof format.len !== 'number' ||
      !Number.isSafeInteger(format.len) || format.len < 0)) return unsupported();
    // Formatting spans have tp. Entity references have key, which defaults to 0 in Drafty.
    if (format.tp !== undefined && format.key === undefined) {
      if (typeof format.tp !== 'string') return unsupported();
      continue;
    }
    const key = format.key ?? 0;
    if (typeof key !== 'number' || !Number.isSafeInteger(key) || key < 0 || key >= entities.length) return unsupported();
    const entity = entities[key];
    if (!isRecord(entity) || typeof entity.tp !== 'string') return unsupported();
    if (entity.tp === 'IM') media.add('photo');
    else if (entity.tp === 'AU') media.add('voice');
    else if (entity.tp === 'VD') media.add('video');
    else if (entity.tp === 'EX') media.add('file');
  }
  if (media.size > 0) {
    const kind = media.size === 1 ? [...media][0]! : 'file';
    return Object.freeze({ kind, ...(text === '' ? {} : { caption: text }) });
  }
  return text === '' ? unsupported() : Object.freeze({ kind: 'text', text });
}

// An MN entity inside a quote or forward header is not a direct mention.
function mentionedByUid(packet: Record<string, unknown>, ownUid: string): boolean {
  if (packet.from === ownUid) return false;
  const head = isRecord(packet.head) ? packet.head : undefined;
  if (Array.isArray(head?.mentions) && head.mentions.includes(ownUid)) return true;
  const content = packet.content;
  if (!isRecord(content) || typeof content.txt !== 'string' ||
    !Array.isArray(content.fmt) || !Array.isArray(content.ent)) return false;
  const range = (value: unknown): readonly [number, number] | undefined => {
    if (!isRecord(value) || typeof value.at !== 'number' || typeof value.len !== 'number' ||
      !Number.isSafeInteger(value.at) || !Number.isSafeInteger(value.len) || value.at < 0 || value.len <= 0 ||
      value.at + value.len > (content.txt as string).length) return undefined;
    return [value.at, value.at + value.len];
  };
  const quotes = content.fmt.filter(f => isRecord(f) && f.tp === 'QQ').map(range).filter(r => r !== undefined);
  return content.fmt.some(f => {
    const span = range(f);
    if (!span || !isRecord(f) || typeof f.key !== 'number' || !Number.isSafeInteger(f.key) ||
      f.key < 0 || f.key >= (content.ent as unknown[]).length) return false;
    const entity = (content.ent as unknown[])[f.key];
    return isRecord(entity) && entity.tp === 'MN' && isRecord(entity.data) && entity.data.val === ownUid &&
      !(head?.forwarded && span[0] === 0) && !quotes.some(q => q[0] <= span[0] && q[1] >= span[1]);
  });
}

export interface PreviewFrame {
  readonly message: LastMessage;
  readonly author?: string;
  readonly replaces?: number;
}

export function normalizePreviewMessage(packet: unknown, topicKey: string, ownUid: string): PreviewFrame {
  if (!isRecord(packet) || packet.topic !== topicKey || typeof packet.seq !== 'number' ||
    !Number.isSafeInteger(packet.seq) || packet.seq <= 0) throw invalid('preview');
  const timestamp = normalizeServerTimestamp(packet.ts);
  if (timestamp === undefined) throw invalid('preview');
  const sender = packet.from === ownUid ? Object.freeze({ state: 'self' } as const)
    : typeof packet.from === 'string' && /^usr[A-Za-z0-9_-]+$/.test(packet.from)
      ? Object.freeze({ state: 'unknown', profileKey: packet.from } as const)
      : Object.freeze({ state: 'unknown' } as const);
  const author = typeof packet.from === 'string' && /^usr[A-Za-z0-9_-]+$/.test(packet.from) ? packet.from : undefined;
  const replace = isRecord(packet.head) ? packet.head.replace : undefined;
  const replaces = replacementMessageSeq(replace, topicKey, packet.seq);
  if (replace !== undefined && replaces === undefined) throw invalid('preview');
  return { author, replaces, message: Object.freeze({ mentionedMe: mentionedByUid(packet, ownUid),
    seq: packet.seq, timestamp, sender, content: previewContent(packet.content, packet.head) }) };
}


function latestSequence(previous: ChatSequence, next: ChatSequence): ChatSequence {
  return previous.state === 'known' && next.state === 'known'
    ? Object.freeze({ state: 'known', value: Math.max(previous.value, next.value) }) : next;
}

// Apply patches immutably so a counter or avatar update cannot reinstate an older name or message.
export function applyChatRecordUpdate(previous: ChatRecord | undefined, incoming: ChatRecord,
  fields?: readonly ChatRecordUpdateField[]): ChatRecord {
  if (!previous || fields === undefined) return incoming;
  const included = new Set(fields);
  const serverSeq = included.has('serverSeq') ? latestSequence(previous.serverSeq, incoming.serverSeq) : previous.serverSeq;
  const readSeq = included.has('readSeq') ? latestSequence(previous.readSeq, incoming.readSeq) : previous.readSeq;
  return Object.freeze({ ...previous,
    ...(included.has('metadata') ? { kind: incoming.kind, actionTopic: incoming.actionTopic,
      title: incoming.title, participantCount: incoming.participantCount } : {}),
    ...(included.has('avatar') ? { avatar: incoming.avatar } : {}),
    ...(included.has('notificationsMuted') && incoming.notificationsMuted !== undefined
      ? { notificationsMuted: incoming.notificationsMuted } : {}),
    ...(included.has('draft') ? { draft: incoming.draft } : {}),
    ...(included.has('preview') ? { preview: incoming.preview } : {}),
    ...(included.has('activity') ? { lastActivityAt: incoming.lastActivityAt } : {}),
    serverSeq, readSeq, unread: unreadCount(serverSeq, readSeq), revision: incoming.revision });
}

// Start with one confirmed snapshot and apply later events in revision order.
export function mergeChatListSnapshot(records: readonly ChatRecord[], events: readonly ChatListEvent[],
  baseRevision: number): readonly ChatRecord[] {
  const merged = new Map(records.map(record => [record.topicKey, record]));
  const removed = new Map<string, number>();
  for (const event of [...events].filter(event => event.revision > baseRevision)
    .sort((one, two) => one.revision - two.revision)) {
    if (event.kind === 'chatUpsert') {
      const key = event.record.topicKey;
      const previous = merged.get(key);
      if (event.revision <= (previous?.revision ?? removed.get(key) ?? -1)) continue;
      merged.set(key, applyChatRecordUpdate(previous,
        Object.freeze({ ...event.record, revision: event.revision }), event.updatedFields));
    } else if (event.kind === 'chatRemoved') {
      const previous = merged.get(event.topicKey);
      if (event.revision <= (previous?.revision ?? removed.get(event.topicKey) ?? -1)) continue;
      merged.delete(event.topicKey); removed.set(event.topicKey, event.revision);
    } else if (event.kind === 'readUpdated' || event.kind === 'previewUpdated') {
      const previous = merged.get(event.topicKey);
      if (!previous || event.revision <= previous.revision) continue;
      if (event.kind === 'readUpdated') {
        const readSeq = latestSequence(previous.readSeq, event.readSeq);
        merged.set(event.topicKey, Object.freeze({ ...previous, readSeq,
          unread: unreadCount(previous.serverSeq, readSeq), revision: event.revision }));
      } else merged.set(event.topicKey, Object.freeze({ ...previous, preview: event.preview,
        lastActivityAt: event.lastActivityAt, revision: event.revision }));
    }
  }
  return Object.freeze([...merged.values()]);
}
