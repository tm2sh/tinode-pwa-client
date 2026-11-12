import { replacementMessageSeq } from './message-replacement';
import { normalizeChatSequence, normalizeServerTimestamp, normalizeSnapshotSequence } from '../chats/chat-list-normalize';
import type { AccountScope, AvatarResource, ChatSequence, ChatTitle } from '../chats/chat-list-types';
import type {
  PhotoAttachment, VoiceAttachment,
  ConversationAccess, ConversationAttachment, ConversationContent, ConversationError,
  ConversationDeletionRange, ConversationDeletionState,
  ConversationHeader, ConversationIdentity, ConversationMessage, ConversationPermissions,
  ConversationPresence, ConversationSender, ConversationTextSpan, ConversationTimestamp,
  ConversationTopicKey, UnsupportedAttachment,
} from './conversation-types';

const unknown = Object.freeze({ state: 'unknown' } as const);
const missingMedia = Object.freeze({ state: 'missing' } as const);
const maxTextUnits = 1024 * 1024;
const maxEntries = 4096;
const maxWaveformSamples = 256;
const noSpans: readonly ConversationTextSpan[] = Object.freeze([]);
const noAttachments: readonly ConversationAttachment[] = Object.freeze([]);

export class ConversationFailure extends Error {
  readonly conversationError: ConversationError;
  constructor(error: ConversationError) {
    super(error.messageCode);
    this.name = 'ConversationFailure';
    this.conversationError = Object.freeze({ kind: error.kind, area: error.area,
      messageCode: error.messageCode, retryable: error.retryable,
      ...(integer(error.serverCode, 100) && error.serverCode <= 599 ? { serverCode: error.serverCode } : {}),
      ...(error.messageParams ? { messageParams: Object.freeze({
        ...(integer(error.messageParams.seconds, 0) ? { seconds: error.messageParams.seconds } : {}),
        ...(integer(error.messageParams.maxBytes, 0) ? { maxBytes: error.messageParams.maxBytes } : {}),
      }) } : {}),
    });
  }
}

function invalid(area: 'header' | 'history', tooLarge = false): ConversationFailure {
  return new ConversationFailure({ area, kind: tooLarge ? 'tooLarge' : 'invalidResponse',
    messageCode: 'conversationInvalidResponse', retryable: true });
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function integer(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}
function uid(value: unknown): value is string {
  return typeof value === 'string' && /^usr[A-Za-z0-9_-]+$/.test(value);
}
function topic(value: unknown): value is ConversationTopicKey {
  return typeof value === 'string' && /^(?:usr|grp|chn)[A-Za-z0-9_-]+$/.test(value);
}
function plain(value: string, area: 'header' | 'history' = 'history'): string {
  if (value.length > maxTextUnits) throw invalid(area, true);
  // Keep UTF-16 length unchanged without an HTML parser, innerHTML, or JSON.stringify.
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ud800-\udfff]/gu,
    (character) => character.length === 1 ? '\ufffd' : character);
}
function title(publicProfile: unknown): ChatTitle {
  if (!record(publicProfile) || typeof publicProfile.fn !== 'string') return unknown;
  const text = plain(publicProfile.fn, 'header').trim();
  return text && text !== '␡' ? Object.freeze({ state: 'known', text }) : unknown;
}

export function normalizeConversationIdentity(account: AccountScope, topicKey: unknown): ConversationIdentity {
  if (!record(account) || !uid(account.uid) || !integer(account.generation, 0) ||
    typeof account.serverId !== 'string' || !topic(topicKey)) throw invalid('header');
  try {
    const server = new URL(account.serverId);
    if (!['wss:', 'ws:'].includes(server.protocol) || server.origin !== account.serverId ||
      server.username || server.password) throw invalid('header');
  } catch { throw invalid('header'); }
  return Object.freeze({ account: Object.freeze({ serverId: account.serverId, uid: account.uid,
    generation: account.generation }), topicKey, kind: topicKey.startsWith('usr') ? 'personal' : 'group' });
}
function identity(value: ConversationIdentity): ConversationIdentity {
  if (!record(value)) throw invalid('header');
  const checked = normalizeConversationIdentity(value.account, value.topicKey);
  if (checked.kind !== value.kind) throw invalid('header');
  return checked;
}
export function normalizeConversationTimestamp(value: unknown): ConversationTimestamp {
  const at = normalizeServerTimestamp(value);
  return at === undefined ? unknown : Object.freeze({ state: 'known', at });
}

function accessFlags(value: unknown): number | undefined {
  if (integer(value, 0) && value <= 255) return value;
  if (typeof value !== 'string' || (value !== 'N' && !/^[JRWPASDO]+$/.test(value))) return;
  let result = 0;
  for (const flag of value === 'N' ? '' : value) result |= 1 << 'JRWPASDO'.indexOf(flag);
  return result;
}
export function normalizeConversationPermissions(value: unknown): ConversationPermissions {
  let mode: number | undefined;
  if (record(value)) {
    mode = accessFlags(value.mode);
    if (value.mode === undefined) {
      const given = accessFlags(value.given), want = accessFlags(value.want);
      if (given !== undefined && want !== undefined) mode = given & want;
    }
  }
  const permission = (flag: number): ConversationAccess => mode === undefined ? unknown
    : (mode & 1) !== 0 && (mode & flag) !== 0 ? Object.freeze({ state: 'allowed' })
      : Object.freeze({ state: 'denied', reason: 'notGranted' });
  return Object.freeze({ canRead: permission(2), canWrite: permission(4), canDelete: permission(64) });
}
export function normalizeConversationPresence(value: Record<string, unknown>): ConversationPresence {
  if (value.online === true) return Object.freeze({ state: 'online' });
  if (value.online !== false) return unknown;
  const when = record(value.seen) ? normalizeServerTimestamp(value.seen.when) : undefined;
  return Object.freeze({ state: 'offline', ...(when === undefined ? {} : { lastSeenAt: when }) });
}
function avatar(publicProfile: unknown, loaded?: AvatarResource): AvatarResource {
  // The owner supplies the already validated AvatarResource, never a raw server.photo value.
  if (loaded) {
    if (loaded.state === 'ready') {
      const source = loaded.imageSource;
      return typeof source === 'string' && /^(?:blob:|data:image\/(?:png|jpeg|gif|webp);base64,)/.test(source)
        ? Object.freeze({ state: 'ready', imageSource: source }) : Object.freeze({ state: 'unavailable' });
    }
    if (['missing', 'pending', 'unavailable'].includes(loaded.state)) return Object.freeze({ state: loaded.state });
    return Object.freeze({ state: 'unavailable' });
  }
  const photo = record(publicProfile) ? publicProfile.photo : undefined;
  if (photo === undefined || photo === null || photo === '␡') return Object.freeze({ state: 'missing' });
  return Object.freeze({ state: record(photo) &&
    ((typeof photo.ref === 'string' && photo.ref.trim() !== '' && photo.ref !== '␡') ||
      (typeof photo.data === 'string' && photo.data.trim() !== '' && photo.data !== '␡')) ? 'pending' : 'unavailable' });
}
export interface NormalizedConversationProfile {
  readonly uid: string;
  readonly displayName: ChatTitle;
  readonly avatar: AvatarResource;
  readonly presence: ConversationPresence;
}
export function normalizeConversationProfile(
  value: unknown, userId: unknown, loadedAvatar?: AvatarResource,
): NormalizedConversationProfile {
  if (!record(value) || !uid(userId) || (value.user !== undefined && value.user !== userId)) throw invalid('header');
  return Object.freeze({ uid: userId, displayName: title(value.public),
    avatar: avatar(value.public, loadedAvatar), presence: normalizeConversationPresence(value) });
}
export interface NormalizedConversationMetadata {
  readonly identity: ConversationIdentity;
  readonly header: ConversationHeader;
  readonly permissions: ConversationPermissions;
  readonly serverSeq: ChatSequence;
  readonly readSeq: ChatSequence;
  readonly recvSeq: ChatSequence;
  readonly deletionTransaction: ChatSequence;
  readonly updatedAt: ConversationTimestamp;
}
export function normalizeConversationMetadata(
  packet: unknown, context: ConversationIdentity, loadedAvatar?: AvatarResource, completeSnapshot = false,
): NormalizedConversationMetadata {
  const checked = identity(context);
  if (!record(packet) || packet.topic !== checked.topicKey || 'code' in packet || !record(packet.desc)) throw invalid('header');
  const desc = packet.desc;
  if (checked.kind === 'group' && desc.chan !== undefined && typeof desc.chan !== 'boolean') throw invalid('header');
  const channel = checked.kind === 'group' && (desc.chan === true || checked.topicKey.startsWith('chn'));
  const common = { title: title(desc.public), avatar: avatar(desc.public, loadedAvatar) };
  const header: ConversationHeader = checked.kind === 'personal'
    ? Object.freeze({ ...common, kind: 'personal', peerUid: checked.topicKey, presence: normalizeConversationPresence(desc) })
    : Object.freeze({ ...common, kind: 'group', ...(channel ? { isChannel: true as const } : {}), participantCount: normalizeChatSequence(desc.subcnt), onlineCount: unknown });
  // The total count comes from the server's subcnt. The adapter checks whether presence data is complete.
  const permissions = normalizeConversationPermissions(desc.acs);
  return Object.freeze({ identity: checked, header, permissions,
    serverSeq: normalizeSnapshotSequence(desc.seq, completeSnapshot && permissions.canRead.state === 'allowed'),
    // Tinode omits the channel reader's read=0 in a complete description.
    readSeq: normalizeSnapshotSequence(desc.read, completeSnapshot && checked.topicKey.startsWith('chn') && permissions.canRead.state === 'allowed'),
    recvSeq: normalizeChatSequence(desc.recv), deletionTransaction: normalizeChatSequence(desc.del),
    updatedAt: normalizeConversationTimestamp(desc.updated) });
}

function filename(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > maxTextUnits) return;
  const text = plain(value);
  const name = text.slice(Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\')) + 1).trim();
  // Avoid cutting a UTF-16 surrogate pair in half.
  return name ? Array.from(name.slice(0, 510)).slice(0, 255).join('') : undefined;
}
function mime(value: unknown, family: 'image' | 'audio'): string | undefined {
  if (typeof value !== 'string' || value.length > 255) return;
  const normalized = value.trim().toLowerCase();
  return new RegExp('^' + family + '/[a-z0-9!#$&^_.+-]+(?:;\\s*codecs=(?:[a-z0-9., _-]+|"[a-z0-9., _-]+"))?$').test(normalized)
    ? normalized : undefined;
}
function waveform(value: unknown): readonly number[] | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > Math.ceil(maxWaveformSamples / 3) * 4 ||
    value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return;
  try {
    const bytes = atob(value);
    if (bytes.length === 0 || bytes.length > maxWaveformSamples) return;
    const result: number[] = [];
    for (let index = 0; index < bytes.length; index++) {
      const amplitude = bytes.charCodeAt(index);
      // The pinned Drafty AudioDesc.preview stores values from 0 to 100, not PCM bytes.
      if (amplitude > 100) return;
      result.push(Math.round(amplitude * 255 / 100));
    }
    return Object.freeze(result);
  } catch { return; }
}
function unsupported(contentType: UnsupportedAttachment['contentType'], name?: string): UnsupportedAttachment {
  return Object.freeze({ kind: 'unsupported', contentType, ...(name === undefined ? {} : { filename: name }) });
}
type PhotoMediaFactory = (data: Readonly<Record<string, unknown>>, mime?: string) => Pick<PhotoAttachment, 'media' | 'preview'>;

type VoiceMediaFactory = (data: Readonly<Record<string, unknown>>, mime?: string) => VoiceAttachment['media'];

function attachment(entity: Record<string, unknown>, photoMedia?: PhotoMediaFactory, voiceMedia?: VoiceMediaFactory): ConversationAttachment {
  const data = record(entity.data) ? entity.data : {};
  const name = filename(data.name);
  const base = { ...(name === undefined ? {} : { filename: name }), size: normalizeChatSequence(data.size) };
  if (entity.tp === 'IM') {
    const type = mime(data.mime, 'image');
    const dimensions = integer(data.width, 1) && integer(data.height, 1)
      ? Object.freeze({ state: 'known' as const, width: data.width, height: data.height }) : unknown;
    return Object.freeze({ ...base, kind: 'photo', ...(photoMedia?.(data, type) ?? { media: missingMedia }), dimensions,
      ...(type === undefined ? {} : { mime: type }) });
  }
  if (entity.tp === 'AU') {
    const type = mime(data.mime, 'audio'), levels = waveform(data.preview);
    return Object.freeze({ ...base, kind: 'voice', media: voiceMedia?.(data, type) ?? missingMedia,
      durationMs: normalizeChatSequence(data.duration), ...(type === undefined ? {} : { mime: type }),
      ...(levels === undefined ? {} : { waveform: levels }) });
  }
  return unsupported(entity.tp === 'VD' ? 'video' : entity.tp === 'EX'
    ? data.mime === 'application/json' || data.mime === 'text/x-drafty-fr' ? 'form' : 'file'
    : ['FM', 'RW', 'BN'].includes(String(entity.tp)) ? 'form' : 'unknown', name);
}
export function safeLink(value: unknown): `https://${string}` | `http://${string}` | undefined {
  if (typeof value !== 'string' || value.length > 8192 ||
    !/^https?:\/\//i.test(value) || /[\s\u0000-\u001f\u007f\\]/u.test(value)) return;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password) return;
    return url.href as `https://${string}` | `http://${string}`;
  } catch { return; }
}

interface Format {
  readonly at: number;
  readonly end: number;
  readonly type: string;
  readonly key?: number;
  readonly entity?: Record<string, unknown>;
}
function formats(value: unknown, entities: readonly unknown[], count: number): readonly Format[] {
  const source = value === undefined || (Array.isArray(value) && value.length === 0)
    ? entities.length ? [{ at: 0, len: 0, key: 0 }] : [] : Array.isArray(value) ? value : [];
  if (source.length > maxEntries) throw invalid('history', true);
  const result: Format[] = [];
  for (const raw of source) {
    if (!record(raw)) continue;
    const at = raw.at === undefined ? 0 : raw.at, length = raw.len === undefined ? 0 : raw.len;
    if (!integer(at, -1) || !integer(length, 0) || at > count ||
      (at >= 0 && length > count - at)) continue;
    if (typeof raw.tp === 'string') {
      if (at >= 0 && length > 0) result.push({ at, end: at + length, type: raw.tp });
      continue;
    }
    if (raw.tp !== undefined) continue;
    const key = raw.key === undefined ? 0 : raw.key;
    if (!integer(key, 0) || key >= entities.length) continue;
    const entity = entities[key];
    if (!record(entity) || typeof entity.tp !== 'string') continue;
    result.push({ at, end: at < 0 ? -1 : at + length, type: entity.tp, key, entity });
  }
  return result;
}
// Drafty uses grapheme offsets. The UI uses UTF-16 start and length.
let segmenter: Intl.Segmenter | undefined;
export function graphemeOffsets(text: string): { readonly offsets: Uint32Array; readonly count: number } | undefined {
  if (typeof Intl.Segmenter !== 'function') return;
  const offsets = new Uint32Array(text.length + 1);
  let count = 0;
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  for (const part of segmenter.segment(text)) offsets[count++] = part.index;
  offsets[count] = text.length;
  return { offsets, count };
}
function editedText(text: string, offsets: Uint32Array, count: number, spans: readonly Format[]) {
  const removals: { at: number; end: number }[] = [];
  const breaks: number[] = [];
  for (const span of spans) {
    if (span.at < 0) continue;
    if (span.type === 'HD') removals.push(span);
    else if (span.end === span.at + 1) {
      const placeholder = text.slice(offsets[span.at], offsets[span.end]);
      if (span.type === 'BR' && (placeholder === ' ' || placeholder === '\n')) breaks.push(span.at);
      else if (span.entity && ['IM', 'AU', 'VD', 'EX'].includes(span.type) &&
        [' ', '\t', '\ufffc'].includes(placeholder)) removals.push(span);
    }
  }
  if (!removals.length && !breaks.length) return { text: plain(text), offsets };
  const flags = new Uint8Array(count);
  for (const index of breaks) flags[index] = 2;
  removals.sort((a, b) => a.at - b.at || b.end - a.end);
  let start = -1, end = -1;
  for (const range of removals) {
    if (range.at > end) {
      if (start >= 0) flags.fill(1, start, end);
      start = range.at; end = range.end;
    } else end = Math.max(end, range.end);
  }
  if (start >= 0) flags.fill(1, start, end);
  const mapped = new Uint32Array(count + 1), parts: string[] = [];
  let length = 0, run = 0;
  for (let index = 0; index < count; index++) {
    mapped[index] = length;
    if (!flags[index]) { length += offsets[index + 1]! - offsets[index]!; continue; }
    if (run < offsets[index]!) parts.push(text.slice(run, offsets[index]));
    if (flags[index] === 2) { parts.push('\n'); length++; }
    run = offsets[index + 1]!;
  }
  if (run < text.length) parts.push(text.slice(run));
  mapped[count] = length;
  return { text: plain(parts.join('')), offsets: mapped };
}
const textStyles: Readonly<Record<string, 'bold' | 'italic' | 'strike' | 'code' | 'quote' | 'highlight'>> = {
  ST: 'bold', EM: 'italic', DL: 'strike', CO: 'code', QQ: 'quote', HL: 'highlight',
};
function textSpans(formats: readonly Format[], offsets: Uint32Array): readonly ConversationTextSpan[] {
  const result: ConversationTextSpan[] = [], keys = new Set<string>();
  for (const span of formats) {
    if (span.at < 0 || span.at === span.end) continue;
    const start = offsets[span.at]!, length = offsets[span.end]! - start;
    if (length <= 0) continue;
    const style = Object.hasOwn(textStyles, span.type) ? textStyles[span.type] : undefined;
    const url = span.type === 'LN' && record(span.entity?.data) ? safeLink(span.entity.data.url) : undefined;
    if (!style && !url) continue;
    const key = start + ':' + length + ':' + (style ?? url);
    if (keys.has(key)) continue;
    keys.add(key);
    result.push(Object.freeze(style ? { start, length, kind: style } : { start, length, kind: 'link', url: url! }));
  }
  result.sort((a, b) => a.start - b.start || b.length - a.length || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
  const accepted: ConversationTextSpan[] = [], stack: ConversationTextSpan[] = [];
  let links = 0;
  for (const span of result) {
    while (stack.length && stack.at(-1)!.start + stack.at(-1)!.length <= span.start) {
      if (stack.pop()!.kind === 'link') links--;
    }
    const parent = stack.at(-1);
    if ((parent && span.start + span.length > parent.start + parent.length) || (span.kind === 'link' && links > 0)) continue;
    accepted.push(span); stack.push(span);
    if (span.kind === 'link') links++;
  }
  return Object.freeze(accepted);
}
export function normalizeConversationContent(value: unknown, contentMime?: unknown, photoMedia?: PhotoMediaFactory, voiceMedia?: VoiceMediaFactory): ConversationContent {
  const kind = typeof contentMime === 'string' ? contentMime.split(';')[0]!.trim().toLowerCase() : undefined;
  if (typeof value === 'string' && (kind === undefined || kind === 'text/plain' || kind === 'text/x-drafty')) {
    return Object.freeze({ text: Object.freeze({ text: plain(value), spans: noSpans }),
      attachments: value.trim() ? noAttachments : Object.freeze([unsupported('unknown')]) });
  }
  const fallback = (type: UnsupportedAttachment['contentType']): ConversationContent => Object.freeze({
    text: Object.freeze({ text: '', spans: noSpans }), attachments: Object.freeze([unsupported(type)]) });
  if (!record(value) || (kind !== undefined && kind !== 'text/x-drafty')) {
    return fallback(kind === 'text/x-drafty-fr' || kind === 'application/json' ? 'form' : 'unknown');
  }
  if (value.txt !== undefined && typeof value.txt !== 'string') return fallback('unknown');
  const text = typeof value.txt === 'string' ? value.txt : '';
  if (text.length > maxTextUnits) throw invalid('history', true);
  const entities = Array.isArray(value.ent) ? value.ent : [];
  if (entities.length > maxEntries) throw invalid('history', true);
  if (entities.length === 0 && (value.fmt === undefined || (Array.isArray(value.fmt) && value.fmt.length === 0))) {
    return Object.freeze({ text: Object.freeze({ text: plain(text), spans: noSpans }),
      attachments: text.trim() ? noAttachments : Object.freeze([unsupported('unknown')]) });
  }
  const positions = graphemeOffsets(text);
  // On older browsers, keep text and attachments and omit spans whose emoji offsets cannot be computed.
  const valid = formats(value.fmt, entities, positions?.count ?? text.length);
  const attachments: ConversationAttachment[] = [], seen = new Set<number | string>();
  for (const span of valid) {
    if (span.entity && !['LN', 'MN', 'HT'].includes(span.type)) {
      if (seen.has(span.key!)) continue;
      seen.add(span.key!);
      const part = attachment(span.entity, photoMedia, voiceMedia);
      if (part.kind === 'unsupported' && part.contentType === 'form') {
        if (seen.has('form')) continue;
        seen.add('form');
      }
      attachments.push(part);
    } else if (['FM', 'RW', 'BN'].includes(span.type) && !seen.has('form')) {
      seen.add('form'); attachments.push(unsupported('form'));
    }
  }
  const edited = positions ? editedText(text, positions.offsets, positions.count, valid) : { text: plain(text) };
  if (!edited.text.trim() && attachments.length === 0) attachments.push(unsupported('unknown'));
  return Object.freeze({ text: Object.freeze({ text: edited.text,
    spans: 'offsets' in edited ? textSpans(valid, edited.offsets) : noSpans }),
    attachments: Object.freeze(attachments) });
}
export interface ConversationMessageContext {
  readonly identity: ConversationIdentity;
  readonly profiles?: ReadonlyMap<string, NormalizedConversationProfile>;
  readonly photoMedia?: PhotoMediaFactory;
  readonly voiceMedia?: VoiceMediaFactory;
}
function sender(value: unknown, context: ConversationMessageContext, ownUid: string): ConversationSender {
  if (!uid(value)) return Object.freeze({ state: 'unknown' });
  if (value === ownUid) return Object.freeze({ state: 'self', uid: value });
  const profile = context.profiles?.get(value);
  return Object.freeze({ state: 'other', uid: value,
    displayName: profile?.uid === value && profile.displayName.state === 'known'
      ? Object.freeze({ state: 'known', text: plain(profile.displayName.text) }) : unknown,
    avatar: profile?.uid === value ? avatar(undefined, profile.avatar) : Object.freeze({ state: 'pending' }) });
}
export function normalizeConversationMessage(packet: unknown, context: ConversationMessageContext): ConversationMessage {
  if (!record(context)) throw invalid('history');
  const checked = identity(context.identity);
  if (!record(packet) || packet.topic !== checked.topicKey || !integer(packet.seq, 1)) throw invalid('history');
  const head = record(packet.head) ? packet.head : {};
  const originalSeq = replacementMessageSeq(head.replace, checked.topicKey, packet.seq);
  if (head.replace !== undefined && originalSeq === undefined) throw invalid('history');
  const operationId = packet.from === checked.account.uid && (!head.forwarded || originalSeq !== undefined) &&
    typeof head['x-tinode-pwa-id'] === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(head['x-tinode-pwa-id'])
    ? head['x-tinode-pwa-id'].toLowerCase() : undefined;
  return Object.freeze({ serverSeq: packet.seq, timestamp: normalizeConversationTimestamp(packet.ts),
    sender: sender(packet.from, context, checked.account.uid), content: normalizeConversationContent(packet.content, head.mime, context.photoMedia, context.voiceMedia),
    delivery: 'serverConfirmed', ...(originalSeq === undefined ? {} : { originalSeq, versionSeq: packet.seq }),
    ...(operationId === undefined ? {} : { operationId }) });
}
export function sortConversationMessages(messages: readonly ConversationMessage[]): readonly ConversationMessage[] {
  return Object.freeze([...messages].sort((a, b) => a.serverSeq < b.serverSeq ? -1 : a.serverSeq > b.serverSeq ? 1 : 0));
}

// Store deletion ranges without expanding them into individual sequences. clear identifies the deletion.
export function mergeConversationDeletionRanges(ranges: readonly ConversationDeletionRange[]): readonly ConversationDeletionRange[] {
  const closed = ranges.map(range => {
    if (!integer(range.low, 1) || (range.hi !== undefined && (!integer(range.hi, 1) || range.hi <= range.low))) throw invalid('history');
    return { low: range.low, high: range.hi === undefined ? range.low : range.hi - 1 };
  }).sort((a, b) => a.low - b.low);
  const merged: { low: number; high: number }[] = [];
  for (const range of closed) {
    const previous = merged.at(-1);
    if (previous && (range.low <= previous.high || (previous.high < Number.MAX_SAFE_INTEGER && range.low === previous.high + 1))) previous.high = Math.max(previous.high, range.high);
    else merged.push({ ...range });
  }
  const result: ConversationDeletionRange[] = [];
  for (const range of merged) {
    if (range.high === Number.MAX_SAFE_INTEGER) {
      if (range.low < range.high) result.push(Object.freeze({ low: range.low, hi: range.high }));
      result.push(Object.freeze({ low: range.high }));
    } else result.push(Object.freeze(range.low === range.high ? { low: range.low } : { low: range.low, hi: range.high + 1 }));
  }
  return Object.freeze(result);
}
export function normalizeConversationDeletion(value: unknown): ConversationDeletionState {
  if (!record(value) || !integer(value.clear, 0) || !Array.isArray(value.delseq) || value.delseq.length > maxEntries) throw invalid('history');
  const ranges = value.delseq.map((range: unknown) => {
    if (!record(range) || !integer(range.low, 1) || (range.hi !== undefined && (!integer(range.hi, 1) || range.hi <= range.low))) throw invalid('history');
    return { low: range.low, ...(range.hi === undefined ? {} : { hi: range.hi }) };
  });
  return Object.freeze({ transactionId: value.clear, ranges: mergeConversationDeletionRanges(ranges) });
}
export function conversationSeqDeleted(seq: number, ranges: readonly ConversationDeletionRange[]): boolean {
  // Merged ranges are sorted. A singleton at MAX_SAFE_INTEGER never requires an unsafe hi + 1.
  let lo = 0, hi = ranges.length;
  while (lo < hi) { const mid = lo + Math.floor((hi - lo) / 2); if (ranges[mid].low <= seq) lo = mid + 1; else hi = mid; }
  const range = ranges[lo - 1];
  return range !== undefined && (range.hi === undefined ? seq === range.low : seq < range.hi);
}
export function materializeConversationMessages(raw: ReadonlyMap<number, ConversationMessage>, deleted: readonly ConversationDeletionRange[]): readonly ConversationMessage[] {
  const originals = new Map<number, ConversationMessage>(), versions = new Map<number, ConversationMessage>();
  for (const message of raw.values()) {
    if (conversationSeqDeleted(message.serverSeq, deleted)) continue;
    if (message.originalSeq === undefined) originals.set(message.serverSeq, message);
  }
  for (const message of raw.values()) {
    if (message.originalSeq === undefined || conversationSeqDeleted(message.serverSeq, deleted)) continue;
    const original = originals.get(message.originalSeq);
    if (!original || !original.sender.uid || original.sender.uid !== message.sender.uid) continue;
    if ((versions.get(original.serverSeq)?.serverSeq ?? 0) < message.serverSeq) versions.set(original.serverSeq, message);
  }
  return sortConversationMessages([...originals.values()].map(original => {
    const version = versions.get(original.serverSeq);
    if (!version) return original;
    const { operationId: _originalOperation, ...base } = original;
    return Object.freeze({ ...base, originalSeq: original.serverSeq, versionSeq: version.serverSeq,
      content: version.content, ...(version.timestamp.state === 'known' ? { editedAt: version.timestamp.at } : {}),
      ...(version.operationId === undefined ? {} : { operationId: version.operationId }) });
  }));
}

// Explicit permission removals take effect immediately. Additions require a fresh desc.
export function conversationAccessRemoved(value: unknown, flag: 'J' | 'R' | 'W' | 'D'): boolean {
  if (!record(value)) return false;
  for (const field of ['mode', 'given', 'want']) {
    const token = value[field];
    if (typeof token !== 'string' || !/^(?:[+-][JRWPASDO]+)+$/.test(token)) continue;
    let last: string | undefined;
    for (const part of token.matchAll(/([+-])([JRWPASDO]+)/g)) if (part[2].includes(flag)) last = part[1];
    if (last === '-') return true;
  }
  return false;
}
