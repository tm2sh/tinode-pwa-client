import type { Tinode, TinodeDraftyMediaContent, TinodeGetQuery, TinodeGroupCreationParams, TinodeTextContent } from 'tinode-sdk';
import { groupPublicSetBytes, groupPublicSetParams, isGroupTitle, maxGroupAvatarBytes } from '../../chat-info/group-public-patch';
import type { GroupPublicPatch } from '../../chat-info/group-public-patch';
import { isProfileName, maxOwnAvatarBytes, ownProfileSetBytes, ownProfileSetParams } from '../../profile/own-profile-patch';
import type { OwnProfilePublicPatch } from '../../profile/own-profile-patch';
import { TinodeTopicInterests } from './TinodeTopicInterests';
import { groupCreationIdPattern, groupCreationMarker, groupCreationTopicPrefix, groupTopicPattern, participantIdPattern } from '../../groups/group-creation-packet';
import type { GroupCreationKind } from '../../groups/group-creation-types';
import { draftPrivatePatch, maxDraftCleanup, projectOwnDraft } from './tinode-chat-draft';
import { normalizeConversationDraft } from '../../conversation/ConversationDraft';
import type { ConversationDraft } from '../../conversation/ConversationDraft';
import type { TinodeTopicRole, TinodeTopicInterest } from './TinodeTopicInterests';
import type { AccountScope } from '../../chats/chat-list-types';
import { sandboxHost } from '../../config/client-config';
import { inlineMediaByteLimit } from '../../media/MediaResources';
import type { ServerLimit, ServerLimits } from '../../media/MediaResources';
import { projectConversationPacket, TinodeConversationProjectionFailure } from './tinode-conversation-packets';
import type { TinodeEditPayload } from './tinode-message-edit';
import type { TinodeConversationPacket } from './tinode-conversation-packets';
export type { TinodeConversationPacket } from './tinode-conversation-packets';

export type TinodeSessionValue =
  | string | number | boolean | null
  | readonly TinodeSessionValue[] | TinodeSessionObject;

export interface TinodeSessionObject {
  readonly [field: string]: TinodeSessionValue;
}

export interface TinodeContactDiscovery {
  find(tag: string, signal: AbortSignal): Promise<readonly TinodeSessionValue[]>;
  dispose(): void;
}

export const discoveryTagValue = /^[-_+.!?#@\p{L}\p{N}]{1,96}$/u;
const discoveryResultLimit = 32;

export interface TinodeSessionPacket {
  readonly kind: 'meta' | 'pres' | 'data' | 'ctrl';
  readonly payload: TinodeSessionObject;
}

export class TinodeSessionFailure extends Error {
  readonly reason: 'closed' | 'invalidResponse' | 'rejected' | 'aborted' | 'tooLarge' | 'limitsUnavailable';
  readonly code?: number;
  readonly origin?: 'server';

  constructor(reason: TinodeSessionFailure['reason'], code?: number, origin?: 'server') {
    super('Tinode session: ' + reason);
    this.name = 'TinodeSessionFailure';
    this.reason = reason;
    this.code = code;
    this.origin = origin;
  }
}

type SessionSdk = Pick<Tinode, 'onMessage' | 'isConnected' | 'isAuthenticated' |
  'getCurrentUserID' | 'getNextUniqueId' | 'newGroupTopicName' | 'getServerInfo' | 'getServerParam' | 'subscribe' | 'getMeta' | 'setMeta' | 'delMessages' | 'delTopic' | 'delSubscription' | 'leave' | 'note' | 'authorizeURL' | 'createMessage' | 'publishMessage' | 'getLargeFileHelper'>;

export const tinodeAvatarByteLimit = 5 * 1024 * 1024;
type PacketListener = (packet: TinodeSessionPacket) => void;
// The alpha3 SDK promise times out after five seconds even if the socket can still receive the reply.
const metadataResponseTimeoutMs = 30_000;
export type TinodeGroupCreateReply =
  | { readonly state: 'created'; readonly topicKey: string }
  | { readonly state: 'rejected'; readonly code: number }
  | { readonly state: 'unknown' };

interface PendingMetadata {
  readonly topic: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
}

export type TinodeConversationGetQuery =
  | { readonly what: 'desc'; readonly desc?: TinodeGetQuery['desc'] }
  | { readonly what: 'sub'; readonly sub?: TinodeGetQuery['sub'] }
  | { readonly what: 'data'; readonly data: NonNullable<TinodeGetQuery['data']> & { readonly limit: number } }
  | { readonly what: 'del'; readonly del?: TinodeGetQuery['del'] };

// The child panel can request only the selected topic's full desc or sub.
// A targeted member lookup is available only through a grp address.
export type TinodeConversationMetadataQuery =
  | { readonly what: 'desc' }
  | { readonly what: 'sub'; readonly sub: { readonly limit: number; readonly user?: string } };

// The SDK acknowledgement still requires a metadata readback.
export type TinodeMetadataWriteResult =
  | { readonly state: 'acknowledged'; readonly controlId: string }
  | { readonly state: 'rejected'; readonly serverCode: number }
  | { readonly state: 'unknown' };
export interface TinodeConversationMetadataReader {
  readonly topic: string;
  requestMeta(query: TinodeConversationMetadataQuery, signal: AbortSignal): TinodeConversationRequest;
  setOwnPush(want: string, enabled: boolean, signal: AbortSignal): Promise<TinodeMetadataWriteResult>;
  setGroupPublic(patch: GroupPublicPatch, signal: AbortSignal): Promise<TinodeMetadataWriteResult>;
  removeMember(uid: string, signal: AbortSignal): Promise<TinodeMetadataWriteResult>;
  addMember(uid: string, signal: AbortSignal): Promise<TinodeMetadataWriteResult>;
  // Disable new requests without leaving the topic or cancelling its owner.
  dispose(): void;
}

export interface TinodeConversationRequest {
  readonly id: string;
  readonly response: Promise<TinodeSessionObject>;
}

// The id is registered before publish. No raw SDK draft leaves this scope.
export interface TinodePublication {
  readonly id: string;
  publish(): Promise<void>;
  dispose(): void;
}

// A local subscription performs no attach or detach and does not establish a safe handoff.
export type TinodeDeleteResult =
  | { readonly state: 'acknowledged'; readonly deletionId: number }
  | { readonly state: 'rejected' | 'unknown' };

export interface TinodeConversationSubscription {
  readonly topic: string;
  getMeta(query: TinodeConversationGetQuery, signal: AbortSignal): Promise<TinodeSessionObject>;
  // The ID is available before the send microtask so the collector can register the request in time.
  requestMeta(query: TinodeConversationGetQuery, signal: AbortSignal): TinodeConversationRequest;
  metadataReader(): TinodeConversationMetadataReader;
  readPeerReceipt(signal: AbortSignal): Promise<TinodeSessionObject>;
  readDeletionMetadata(query: Extract<TinodeConversationGetQuery, { what: 'desc' | 'del' }>, signal: AbortSignal): Promise<TinodeSessionObject>;
  deleteMessages(seqs: readonly number[], hard: boolean): Promise<TinodeDeleteResult>;
  prepareText(operationId: string, text: string): TinodePublication;
  prepareEdit(operationId: string, targetSeq: number, input: TinodeEditPayload): TinodePublication;
  prepareMedia(operationId: string, content: TinodeDraftyMediaContent, reference?: string): TinodePublication;
  note(what: 'read' | 'recv', seq: number): void;
  dispose(): void;
}
// Shared state for the chat list counter. Pending reads are never confirmed locally.
export interface TinodeReadState {
  readonly topic: string;
  readonly seq: number;
  readonly state: 'pending' | 'confirmed';
}
interface ConversationConsumer {
  readonly topic: string;
  readonly messageByteLimit: number;
  readonly listener: (packet: TinodeConversationPacket) => void;
  readonly onError: (error: TinodeSessionFailure) => void;
  readonly lifetime: AbortController;
}
interface PendingConversationRead extends PendingMetadata {
  readonly consumer: ConversationConsumer;
  readonly what: TinodeConversationGetQuery['what'];
  readonly isolatedMetadata: boolean;
}

type Projection = true | { readonly [key: string]: Projection } | readonly [Projection];

const profile = { fn: true, photo: { type: true, data: true, ref: true } } as const;
const access = { mode: true, given: true, want: true } as const;
const description = {
  created: true, updated: true, touched: true, deleted: true,
  seq: true, read: true, recv: true, del: true, acs: access, public: profile,
  online: true, seen: { when: true }, subcnt: true, chan: true,
} as const;
const previewEntityData = { mime: true, name: true, duration: true, size: true } as const;
const mentionEntityData = { ...previewEntityData, val: true } as const;
const previewEntity = { tp: true, data: previewEntityData } as const;
const shapes = {
  meta: {
    id: true, topic: true, ts: true, desc: description,
    sub: [{ ...description, topic: true, user: true }],
  },
  pres: {
    topic: true, src: true, what: true, seq: true, act: true, tgt: true,
    ts: true, clear: true, dacs: access, acs: access,
  },
  data: {
    topic: true, from: true, seq: true, ts: true,
    head: { mime: true, replace: true, mentions: [true], forwarded: true },
    content: {
      txt: true, fmt: [{ at: true, len: true, key: true, tp: true }],
      // Omit binary val and preview fields and attachment URLs from chat previews.
      ent: [previewEntity],
    },
  },
  ctrl: { id: true, topic: true, code: true, ts: true,
    params: { what: true, count: true, unsub: true } },
} as const satisfies Record<TinodeSessionPacket['kind'], Projection>;
const presenceKinds = new Set(['msg', 'read', 'recv', 'upd', 'acs', 'gone', 'del', 'term']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isTopic(value: unknown): value is string {
  return typeof value === 'string' &&
    // chn identifies an existing group topic. new and nch create topics and are not allowed here.
    (value === 'me' || /^(?:usr|grp|chn)[A-Za-z0-9_-]+$/.test(value));
}

function hasGroupOwnership(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const owns = (mode: unknown) => typeof mode === 'string'
    ? /^[JRWPASDO]+$/.test(mode) && mode.includes('O')
    : isInteger(mode, 0) && mode <= 255 && (mode & 128) !== 0;
  return owns(value.given) && owns(value.want) && (value.mode === undefined || owns(value.mode));
}

function hasGroupAdminAccess(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const bits = (mode: unknown) => typeof mode === 'string' && /^[JRWPASDO]+$/.test(mode)
    ? [...mode].reduce((mask, flag) => mask | (1 << 'JRWPASDO'.indexOf(flag)), 0)
    : isInteger(mode, 0) && mode <= 255 ? mode : 0;
  const effective = bits(value.want) & bits(value.given);
  return (effective & 3) === 3 && (effective & 144) !== 0 &&
    (value.mode === undefined || bits(value.mode) === effective);
}

function groupInviteSubscription(user: string, kind: GroupCreationKind) {
  return kind === 'channel' ? { user, mode: 'JRP' } : { user };
}

function hasInvitedAccess(access: unknown, kind: GroupCreationKind): boolean {
  if (!isRecord(access)) return false;
  const { mode } = access;
  if (typeof mode === 'string' && /^[JRWPASDO]+$/.test(mode)) {
    return mode.includes('J') && (kind === 'group' || (mode.includes('R') && !mode.includes('W')));
  }
  if (!isInteger(mode, 0) || mode > 255) return false;
  // J = 1, R = 2, W = 4. Presence can be disabled by the invitee.
  return kind === 'channel' ? (mode & 7) === 3 : (mode & 1) !== 0;
}

function codeOf(value: unknown): number | undefined {
  return isRecord(value) && typeof value.code === 'number' &&
    Number.isInteger(value.code) && value.code >= 100 && value.code <= 599
    ? value.code : undefined;
}

// Project only allowlisted fields. Convert Date objects to immutable strings.
function project(value: unknown, shape: Projection): TinodeSessionValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : undefined;
  if (Array.isArray(shape)) {
    return Array.isArray(value)
      ? Object.freeze(value.map((entry: unknown) => project(entry, shape[0]) ?? null))
      : undefined;
  }
  if (shape === true || !isRecord(value)) return undefined;
  const result: Record<string, TinodeSessionValue> = {};
  for (const [key, nested] of Object.entries(shape)) {
    const copied = project(value[key], shape === previewEntity && key === 'data' && value.tp === 'MN'
      ? mentionEntityData : nested);
    if (copied !== undefined) result[key] = copied;
  }
  return Object.freeze(result);
}

function projectedObject(value: unknown, shape: Projection): TinodeSessionObject {
  const copied = project(value, shape);
  if (!isRecord(copied)) throw new TinodeSessionFailure('invalidResponse');
  return copied as TinodeSessionObject;
}

function projectOwnSubscriptionMetadata(value: Record<string, unknown>): TinodeSessionObject {
  const metadata = projectedObject(value, shapes.meta);
  if (value.topic !== 'me' || !Array.isArray(value.sub) || !Array.isArray(metadata.sub)) return metadata;
  const rawSubscriptions: unknown[] = value.sub;
  const sub = metadata.sub.map((row, index) => {
    const raw = rawSubscriptions[index];
    return isRecord(row) && isRecord(raw) && isConversationTopic(row.topic)
      ? Object.freeze({ ...row, ...(raw.private === undefined ? {} : { draftKnown: true, ...projectOwnDraft(raw.private) }) }) : row;
  });
  return Object.freeze({ ...metadata, sub: Object.freeze(sub) });
}

function isQuery(query: TinodeGetQuery, combined = false): boolean {
  return ['desc', 'sub', 'data'].includes(query.what) || (combined && query.what === 'sub data');
}

function isConversationTopic(value: unknown): value is string {
  return typeof value === 'string' && /^(?:usr|grp|chn)[A-Za-z0-9_-]+$/.test(value);
}

function isInteger(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

// Build requests from known fields only. Do not forward an external id, private, or cred.
function conversationQuery(query: unknown): TinodeGetQuery & { readonly what: TinodeConversationGetQuery['what'] } {
  const invalid = () => new TinodeSessionFailure('invalidResponse');
  if (!isRecord(query)) throw invalid();
  if (query.what === 'data' || query.what === 'del') {
    const options = query[query.what];
    if (options !== undefined && !isRecord(options)) throw invalid();
    if (query.what === 'data' && (!options || !isInteger(options.limit, 1))) throw invalid();
    const copied: { since?: number; before?: number; limit?: number } = {};
    for (const key of query.what === 'data' ? ['since', 'before', 'limit'] as const : ['since', 'limit'] as const) {
      const value = options?.[key];
      if (value === undefined) continue;
      if (!isInteger(value, query.what === 'del' && key === 'since' ? 0 : 1)) throw invalid();
      copied[key] = value;
    }
    if (copied.since !== undefined && copied.before !== undefined && copied.since >= copied.before) throw invalid();
    return { what: query.what, [query.what]: copied };
  }
  if (query.what !== 'desc' && query.what !== 'sub') throw invalid();
  const options = query[query.what];
  if (options !== undefined && !isRecord(options)) throw invalid();
  const copied: { ims?: Date | '1970-01-01T00:00:00.000Z'; limit?: number; topic?: string; user?: string } = {};
  const ims = options?.ims;
  if (ims !== undefined) {
    if (ims instanceof Date && Number.isFinite(ims.getTime())) copied.ims = new Date(ims.getTime());
    else if (query.what === 'sub' && ims === '1970-01-01T00:00:00.000Z') copied.ims = ims;
    else throw invalid();
  }
  if (query.what === 'desc') return { what: 'desc', desc: copied as NonNullable<TinodeGetQuery['desc']> };
  if (options?.limit !== undefined) {
    if (!isInteger(options.limit, 1)) throw invalid();
    copied.limit = options.limit;
  }
  for (const key of ['topic', 'user'] as const) {
    const value = options?.[key];
    if (value === undefined) continue;
    if (!isConversationTopic(value) || (key === 'user' && !value.startsWith('usr'))) throw invalid();
    copied[key] = value;
  }
  return { what: 'sub', sub: copied };
}

// Internal integration only. This class does not create the SDK, sign in, or store the token.
export class TinodeSessionScope {
  readonly account: AccountScope;
  #sdk: SessionSdk | undefined;
  #ownerIsCurrent: () => boolean;
  readonly #mediaProxyOrigin?: string;
  #closed = false;
  readonly #topicInterests = new TinodeTopicInterests(() => this.active, kind => new TinodeSessionFailure(kind));
  #lifetime = new AbortController();
  #topics = new Set<string>(['me']);
  #listeners = new Set<PacketListener>();
  #readListeners = new Set<(state: TinodeReadState) => void>();
  #confirmedReads = new Map<string, number>();
  #ownPushListeners = new Set<(topic: string, mode?: string) => void>();
  #groupProfileListeners = new Set<(topic: string) => void>();
  #cleanups = new Set<() => void>();
  #metadataRequests = new Map<string, PendingMetadata>();
  #groupCreateReply?: (reply: unknown) => void;
  #groupCountsBeforeAttach = new Map<string, number | undefined>();
  #discoveryTail: Promise<void> = Promise.resolve();
  #discovery?: { readonly owner: symbol; attached: boolean };

  #conversation: ConversationConsumer | undefined;
  #metadataWriteBusy = false;
  #conversationReads = new Map<string, PendingConversationRead>();
  #conversationPublications = new Map<string, ConversationConsumer>();
  #retiredPublications = new Set<string>();
  // After an SDK timeout we don't know the id of a possible late ctrl.
  #uncorrelatedDeletions = new Set<string>();
  hasUncorrelatedDeletion(topic: string): boolean { return this.#uncorrelatedDeletions.has(topic); }
  #retiredMetadataReads = new Set<string>();

  constructor(sdk: SessionSdk, account: AccountScope, ownerIsCurrent: () => boolean, mediaProxyOrigin?: string) {
    this.#sdk = sdk;
    this.#ownerIsCurrent = ownerIsCurrent;
    if (mediaProxyOrigin !== undefined) {
      const proxy = new URL(mediaProxyOrigin);
      if (!['http:', 'https:'].includes(proxy.protocol) || proxy.origin !== mediaProxyOrigin) throw new TinodeSessionFailure('invalidResponse');
      this.#mediaProxyOrigin = proxy.origin;
    }
    this.account = Object.freeze({ serverId: account.serverId, uid: account.uid,
      generation: account.generation });
    if (!this.active) throw new TinodeSessionFailure('closed');
    if (sdk.onMessage !== undefined) throw new Error('Tinode message handler is already owned.');
    sdk.onMessage = this.#route;
  }

  get active(): boolean {
    const sdk = this.#sdk;
    return !this.#closed && sdk !== undefined && this.#ownerIsCurrent() &&
      sdk.isConnected() && sdk.isAuthenticated() && sdk.getCurrentUserID() === this.account.uid;
  }

  subscribePackets(listener: PacketListener): () => void {
    if (!this.active) { this.dispose(); return () => {}; }
    const subscription: PacketListener = (packet) => listener(packet);
    this.#listeners.add(subscription);
    return () => { this.#listeners.delete(subscription); };
  }

  subscribeReadState(listener: (state: TinodeReadState) => void): () => void {
    if (!this.active) return () => {};
    this.#readListeners.add(listener);
    return () => { this.#readListeners.delete(listener); };
  }
  subscribeOwnPush(listener: (topic: string, mode?: string) => void): () => void {
    if (!this.active) return () => {};
    this.#ownPushListeners.add(listener);
    return () => { this.#ownPushListeners.delete(listener); };
  }

  reportOwnPush(topic: string, mode?: string): void {
    if (!this.active || !isConversationTopic(topic)) return;
    for (const listener of [...this.#ownPushListeners]) {
      if (!this.active) break;
      try { listener(topic, mode); }
      catch { console.error('Tinode notification setting subscriber failed.'); }
    }
  }

  subscribeGroupProfile(listener: (topic: string) => void): () => void {
    if (!this.active) return () => {};
    this.#groupProfileListeners.add(listener);
    return () => { this.#groupProfileListeners.delete(listener); };
  }

  reportGroupProfile(topic: string): void {
    if (!this.active || !/^grp[A-Za-z0-9_-]+$/.test(topic)) return;
    for (const listener of [...this.#groupProfileListeners]) {
      if (!this.active) break;
      try { listener(topic); }
      catch { console.error('Tinode group profile subscriber failed.'); }
    }
  }

  forgetRead(topic: string): void { this.#confirmedReads.delete(topic); }
  confirmedRead(topic: string): number | undefined { return this.active ? this.#confirmedReads.get(topic) : undefined; }
  #publishRead(topic: unknown, seq: unknown, state: TinodeReadState['state']): void {
    if (!this.active || !isConversationTopic(topic) || !isInteger(seq, 0)) return;
    if (state === 'confirmed') {
      const previous = this.#confirmedReads.get(topic);
      if (previous !== undefined && seq <= previous) return;
      this.#confirmedReads.set(topic, seq);
    }
    const value = Object.freeze({ topic, seq, state });
    for (const listener of [...this.#readListeners]) {
      try { listener(value); } catch { console.error('Tinode read state notification failed.'); }
    }
  }
  #routeReadState(packet: Record<string, unknown>): void {
    const pres = packet.pres, info = packet.info, meta = packet.meta;
    if (isRecord(pres) && pres.topic === 'me' && pres.what === 'read') this.#publishRead(pres.src, pres.seq, 'confirmed');
    if (isRecord(info) && info.what === 'read' && info.from === this.account.uid) {
      this.#publishRead(info.topic === 'me' ? info.src : info.topic, info.seq, 'confirmed');
    }
    if (!isRecord(meta)) return;
    if (isRecord(meta.desc)) this.#publishRead(meta.topic, meta.desc.read, 'confirmed');
    if (Array.isArray(meta.sub)) for (const row of meta.sub) {
      if (!isRecord(row) || row.deleted) continue;
      if (meta.topic === 'me') {
        // In a complete membership response, the server omits a numeric read value of zero.
        // The chat list normalizer applies the same protocol default.
        const mode = isRecord(row.acs) ? row.acs.mode : undefined;
        const readable = typeof mode === 'number' && isInteger(mode, 0) && mode <= 255 ? (mode & 3) === 3
          : typeof mode === 'string' && /^[JRWPASDO]+$/.test(mode) && mode.includes('J') && mode.includes('R');
        const read = row.read === undefined && readable && isInteger(row.seq, 0) ? 0 : row.read;
        this.#publishRead(row.topic, read, 'confirmed');
      }
      else if (row.user === this.account.uid) this.#publishRead(meta.topic, row.read, 'confirmed');
    }
  }

  subscribeConversation(
    topic: string,
    listener: (packet: TinodeConversationPacket) => void,
    onError: (error: TinodeSessionFailure) => void,
  ): TinodeConversationSubscription {
    if (!isConversationTopic(topic)) throw new TinodeSessionFailure('invalidResponse');
    if (!this.active || !this.#sdk) { this.dispose(); throw new TinodeSessionFailure('closed'); }
    if (this.#conversation) throw new TinodeSessionFailure('invalidResponse');
    const messageByteLimit = this.#sdk.getServerParam('maxMessageSize');
    if (!isInteger(messageByteLimit, 1)) throw new TinodeSessionFailure('limitsUnavailable');
    const consumer: ConversationConsumer = { topic, messageByteLimit, listener, onError, lifetime: new AbortController() };
    this.#conversation = consumer;
    return Object.freeze({
      topic,
      getMeta: (query: TinodeConversationGetQuery, signal: AbortSignal) => {
        try { return this.#readConversation(consumer, query, signal, false).response; }
        catch (reason: unknown) { return Promise.reject(reason); }
      },
      requestMeta: (query: TinodeConversationGetQuery, signal: AbortSignal) => this.#readConversation(consumer, query, signal, true),
      metadataReader: () => this.#metadataReader(consumer),
      readPeerReceipt: async (signal: AbortSignal) => {
        if (!topic.startsWith('usr')) throw new TinodeSessionFailure('invalidResponse');
        return this.#readConversation(consumer, { what: 'sub', sub: { user: topic, limit: 1 } }, signal, false, true).response;
      },
      readDeletionMetadata: (query: Extract<TinodeConversationGetQuery, { what: 'desc' | 'del' }>, signal: AbortSignal) =>
        this.#readConversation(consumer, query, signal, false, true).response,
      deleteMessages: (seqs: readonly number[], hard: boolean) => this.#deleteMessages(consumer, seqs, hard),
      prepareText: (operationId: string, text: string) => {
        if (typeof text !== 'string' || !text.trim()) throw new TinodeSessionFailure('invalidResponse');
        return this.#preparePublication(consumer, operationId, { txt: text });
      },
      prepareEdit: (operationId: string, targetSeq: number, input: TinodeEditPayload) => {
        if (!isInteger(targetSeq, 1)) throw new TinodeSessionFailure('invalidResponse');
        return this.#preparePublication(consumer, operationId, input.content, input.references,
          { ...input.metadata, replace: ':' + targetSeq });
      },
      prepareMedia: (operationId: string, content: TinodeDraftyMediaContent, reference?: string) =>
        this.#preparePublication(consumer, operationId, content, reference === undefined ? undefined : [reference]),
      note: (what: 'read' | 'recv', seq: number) => {
        if (!this.active || !this.#sdk || this.#conversation !== consumer || consumer.lifetime.signal.aborted) throw new TinodeSessionFailure('closed');
        if ((what !== 'read' && what !== 'recv') || !isInteger(seq, 1)) throw new TinodeSessionFailure('invalidResponse');
        try { this.#sdk.note(topic, what, seq); }
        catch { throw new TinodeSessionFailure('rejected'); }
        if (what === 'read') this.#publishRead(topic, seq, 'pending');
      },
      dispose: () => {
        if (this.#conversation === consumer) this.#conversation = undefined;
        consumer.lifetime.abort();
        for (const [id, owner] of this.#conversationPublications) if (owner === consumer) { this.#conversationPublications.delete(id); this.#retiredPublications.add(id); }
      },
    });
  }

  async #deleteMessages(consumer: ConversationConsumer, seqs: readonly number[], hard: boolean): Promise<TinodeDeleteResult> {
    const sdk = this.#sdk;
    if (!this.active || !sdk || this.#conversation !== consumer || consumer.lifetime.signal.aborted) throw new TinodeSessionFailure('closed');
    if (!seqs.length || seqs.length > 1024 || seqs.some((seq, index) => !isInteger(seq, 1) || (index > 0 && seq <= seqs[index - 1]!)) ||
      (hard && consumer.topic.startsWith('chn'))) throw new TinodeSessionFailure('invalidResponse');
    const alreadyUncorrelated = this.#uncorrelatedDeletions.has(consumer.topic);
    this.#uncorrelatedDeletions.add(consumer.topic);
    try {
      const reply = await sdk.delMessages(consumer.topic, seqs.map(low => ({ low })), hard);
      if (isRecord(reply) && reply.topic === consumer.topic && reply.code === 200 &&
        typeof reply.id === 'string' && reply.id && isRecord(reply.params) && isInteger(reply.params.del, 1)) {
        if (!alreadyUncorrelated) this.#uncorrelatedDeletions.delete(consumer.topic);
        return { state: 'acknowledged', deletionId: reply.params.del };
      }
      return { state: 'unknown' };
    } catch (reason: unknown) {
      const code = codeOf(reason);
      if (code !== undefined && code >= 400 && code < 500 && code !== 408 && code !== 429) {
        if (!alreadyUncorrelated) this.#uncorrelatedDeletions.delete(consumer.topic);
        return { state: 'rejected' };
      }
      return { state: 'unknown' };
    }
  }

  #metadataReader(consumer: ConversationConsumer): TinodeConversationMetadataReader {
    if (!this.active || !this.#sdk || this.#conversation !== consumer || consumer.lifetime.signal.aborted) {
      throw new TinodeSessionFailure('closed');
    }
    let released = false;
    let descriptionRead = 0;
    let ownerVerified = false;
    let adminVerified = false;
    let topicKind: GroupCreationKind = 'group';
    return Object.freeze({
      topic: consumer.topic,
      requestMeta: (query: TinodeConversationMetadataQuery, signal: AbortSignal) => {
        if (released || !this.active || !this.#sdk || this.#conversation !== consumer || consumer.lifetime.signal.aborted) {
          throw new TinodeSessionFailure('closed');
        }
        if (!isRecord(query)) throw new TinodeSessionFailure('invalidResponse');
        let checked: TinodeConversationGetQuery;
        if (query.what === 'desc') checked = { what: 'desc', desc: {} };
        else if (query.what === 'sub' && isRecord(query.sub) && isInteger(query.sub.limit, 1) &&
          (query.sub.user === undefined || query.sub.user === this.account.uid ||
            (groupTopicPattern.test(consumer.topic) && participantIdPattern.test(query.sub.user)))) {
          checked = { what: 'sub', sub: { limit: query.sub.limit,
            ...(query.sub.user === undefined ? {} : { user: query.sub.user }) } };
        } else throw new TinodeSessionFailure('invalidResponse');
        // Do not forward data, del, tags, or caller-supplied topic, id, ims, or private fields.
        const request = this.#readConversation(consumer, checked, signal, true, true);
        if (checked.what !== 'desc' || !consumer.topic.startsWith('grp')) return request;
        const read = ++descriptionRead;
        ownerVerified = false;
        adminVerified = false;
        return Object.freeze({ ...request, response: request.response.then(reply => {
          if (read === descriptionRead && isRecord(reply.desc) && !reply.desc.deleted) {
            ownerVerified = hasGroupOwnership(reply.desc.acs);
            adminVerified = hasGroupAdminAccess(reply.desc.acs);
            topicKind = reply.desc.chan === true ? 'channel' : 'group';
          }
          return reply;
        }) });
      },
      setOwnPush: (want: string, enabled: boolean, signal: AbortSignal) => {
        if (released) return Promise.reject(new TinodeSessionFailure('closed'));
        if (this.#conversation !== consumer || consumer.lifetime.signal.aborted) {
          return Promise.reject(new TinodeSessionFailure('closed'));
        }
        return this.#writeOwnPush(consumer.topic, want, enabled, signal, consumer.lifetime.signal);
      },
      setGroupPublic: (patch: GroupPublicPatch, signal: AbortSignal) => {
        if (released) return Promise.reject(new TinodeSessionFailure('closed'));
        if (!ownerVerified || !consumer.topic.startsWith('grp')) return Promise.reject(new TinodeSessionFailure('rejected', 403));
        ownerVerified = false;
        return this.#writeGroupPublic(consumer, patch, signal);
      },
      removeMember: (uid: string, signal: AbortSignal) => {
        if (released || this.#conversation !== consumer || consumer.lifetime.signal.aborted || signal.aborted) {
          return Promise.reject(new TinodeSessionFailure('closed'));
        }
        if (!adminVerified || !groupTopicPattern.test(consumer.topic) ||
          !participantIdPattern.test(uid) || uid === this.account.uid) {
          return Promise.reject(new TinodeSessionFailure('rejected', 403));
        }
        adminVerified = false;
        return this.#deleteGroupMember(consumer.topic, uid);
      },
      addMember: (uid: string, signal: AbortSignal) => {
        const sdk = this.#sdk;
        if (released || !this.active || !sdk || this.#conversation !== consumer || consumer.lifetime.signal.aborted || signal.aborted) {
          return Promise.reject(new TinodeSessionFailure('closed'));
        }
        if (!adminVerified || !groupTopicPattern.test(consumer.topic) ||
          !participantIdPattern.test(uid) || uid === this.account.uid) {
          return Promise.reject(new TinodeSessionFailure('rejected', 403));
        }
        if (this.#metadataWriteBusy) return Promise.reject(new TinodeSessionFailure('invalidResponse'));
        const sub = groupInviteSubscription(uid, topicKind);
        return this.#writeMetadata(sdk, consumer.topic, { sub }, signal, consumer.lifetime.signal, uid);
      },
      dispose: () => { released = true; },
    });
  }

  writeChatListOwnPush(topic: string, want: string, enabled: boolean, signal: AbortSignal): Promise<TinodeMetadataWriteResult> {
    if (!isConversationTopic(topic)) return Promise.reject(new TinodeSessionFailure('invalidResponse'));
    return this.#writeOwnPush(topic, want, enabled, signal);
  }

  #writeOwnPush(topic: string, want: string, enabled: boolean, signal: AbortSignal,
    consumerSignal?: AbortSignal): Promise<TinodeMetadataWriteResult> {
    const sdk = this.#sdk;
    if (!this.active || !sdk || consumerSignal?.aborted) throw new TinodeSessionFailure('closed');
    if (signal.aborted) throw new TinodeSessionFailure('aborted');
    const flags = 'JRWPASDO';
    if (typeof enabled !== 'boolean' || typeof want !== 'string' ||
      !/^[JRWPASDO]+$/.test(want) || !want.includes('J') || !want.includes('R') ||
      [...flags].filter(f => want.includes(f)).join('') !== want || this.#metadataWriteBusy) throw new TinodeSessionFailure('invalidResponse');
    const mode = [...flags].filter(f => f === 'P' ? enabled : want.includes(f)).join('');
    if (topic.startsWith('chn')) {
      const finish = consumerSignal ? this.#topicInterests.reconnect(topic) : undefined;
      this.#metadataWriteBusy = true;
      const request = finish ? this.#writeChannelPush(topic, mode, finish) : this.#writeListTopicPush(topic, mode, signal);
      return request.finally(() => { this.#metadataWriteBusy = false; });
    }
    return consumerSignal ? this.#writeMetadata(sdk, topic, { sub: { mode } }, signal, consumerSignal)
      : this.#writeListTopicPush(topic, mode, signal);
  }

  #writeGroupPublic(consumer: ConversationConsumer, patch: GroupPublicPatch, signal: AbortSignal): Promise<TinodeMetadataWriteResult> {
    const sdk = this.#sdk;
    if (!this.active || !sdk || this.#conversation !== consumer || consumer.lifetime.signal.aborted) throw new TinodeSessionFailure('closed');
    if (signal.aborted) throw new TinodeSessionFailure('aborted');
    if (this.#metadataWriteBusy || !isRecord(patch) || (patch.fn === undefined && patch.photo === undefined) ||
      Object.keys(patch).some(key => key !== 'fn' && key !== 'photo')) throw new TinodeSessionFailure('invalidResponse');
    const { fn, photo } = patch;
    if (fn !== undefined && !isGroupTitle(fn)) throw new TinodeSessionFailure('invalidResponse');
    let checkedPhoto: GroupPublicPatch['photo'];
    if (photo !== undefined) {
      if (!isRecord(photo) || (photo.type !== 'jpeg' && photo.type !== 'png') ||
        typeof photo.data !== 'string' || photo.data.length === 0 ||
        Object.keys(photo).some(key => key !== 'type' && key !== 'data')) throw new TinodeSessionFailure('invalidResponse');
      const data = photo.data;
      if (data.length > Math.ceil(maxGroupAvatarBytes / 3) * 4) throw new TinodeSessionFailure('tooLarge');
      if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new TinodeSessionFailure('invalidResponse');
      const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
      if (data.length / 4 * 3 - padding > maxGroupAvatarBytes) throw new TinodeSessionFailure('tooLarge');
      checkedPhoto = { type: photo.type, data };
    }
    const limit = sdk.getServerParam('maxMessageSize');
    if (!isInteger(limit, 1)) throw new TinodeSessionFailure('limitsUnavailable');
    const params = groupPublicSetParams({ fn, photo: checkedPhoto });
    if ((fn?.length ?? 0) > limit || groupPublicSetBytes(consumer.topic, params) > limit) throw new TinodeSessionFailure('tooLarge');
    return this.#writeMetadata(sdk, consumer.topic, params, signal, consumer.lifetime.signal);
  }

  #writeMetadata(sdk: SessionSdk, topic: string, params: Parameters<SessionSdk['setMeta']>[1],
    signal: AbortSignal, consumerSignal?: AbortSignal, affectedUser = this.account.uid): Promise<TinodeMetadataWriteResult> {
    this.#metadataWriteBusy = true;
    return new Promise<TinodeMetadataWriteResult>((resolve) => {
      let finished = false;
      const finish = (value: TinodeMetadataWriteResult) => {
        if (finished) return;
        finished = true; clearTimeout(timer); this.#metadataWriteBusy = false;
        signal.removeEventListener('abort', stop); consumerSignal?.removeEventListener('abort', stop);
        this.#lifetime.signal.removeEventListener('abort', stop);
        resolve(Object.freeze(value));
      };
      const stop = () => finish({ state: 'unknown' });
      const timer = setTimeout(stop, metadataResponseTimeoutMs);
      signal.addEventListener('abort', stop, { once: true });
      consumerSignal?.addEventListener('abort', stop, { once: true });
      this.#lifetime.signal.addEventListener('abort', stop, { once: true });
      const refused = (reason: unknown) => {
        const code = codeOf(reason);
        finish(code !== undefined && code >= 400 && code < 500 && code !== 408 && code !== 429
          ? { state: 'rejected', serverCode: code } : { state: 'unknown' });
      };
      try {
        // The SDK generates the setMeta ID through its public API.
        void sdk.setMeta(topic, params).then(value => {
          if (isRecord(value) && value.topic === topic && typeof value.id === 'string' && value.id &&
            (value.code === 200 || value.code === 304) &&
            (!isRecord(value.params) || value.params.user === undefined || value.params.user === affectedUser)) {
            finish({ state: 'acknowledged', controlId: value.id });
          } else finish({ state: 'unknown' });
        }, refused);
      } catch (reason: unknown) { refused(reason); }
    });
  }

  async #deleteGroupMember(topic: string, uid: string): Promise<TinodeMetadataWriteResult> {
    if (this.#metadataWriteBusy) throw new TinodeSessionFailure('invalidResponse');
    this.#metadataWriteBusy = true;
    try {
      const controlId = await this.#topicCommand(this.#request(topic, sdk => sdk.delSubscription(topic, uid)));
      return { state: 'acknowledged', controlId };
    } catch (reason) {
      const code = codeOf(reason);
      return code !== undefined && code >= 400 && code < 500 && code !== 408 && code !== 429
        ? { state: 'rejected', serverCode: code } : { state: 'unknown' };
    } finally {
      this.#metadataWriteBusy = false;
    }
  }

  async #topicCommand(request: Promise<TinodeSessionObject>): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const reply = await Promise.race([request, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TinodeSessionFailure('rejected', 504)), metadataResponseTimeoutMs);
      })]);
      if ((reply.code !== 200 && reply.code !== 304) || typeof reply.id !== 'string' || !reply.id) {
        throw new TinodeSessionFailure('invalidResponse');
      }
      return reply.id;
    } finally { clearTimeout(timer); }
  }

  async #writeListTopicPush(topic: string, mode: string, signal: AbortSignal): Promise<TinodeMetadataWriteResult> {
    const channel = topic.startsWith('chn');
    const interest = this.#topicInterests.create(topic, 'notification');
    try {
      const physical = await interest.acquire(AbortSignal.any([signal, AbortSignal.timeout(metadataResponseTimeoutMs)]));
      if (signal.aborted || !this.active) {
        if (physical) interest.refused();
        throw new TinodeSessionFailure('aborted');
      }
      if (channel && !physical) {
        return await this.#writeChannelPush(topic, mode, this.#topicInterests.reconnect(topic, 'notification'));
      }
      if (physical) {
        // A detached channel reader can persist P during its initial subscribe.
        const request = channel ? this.#request(topic, sdk => sdk.subscribe(topic, null, { sub: { mode } }))
          : this.subscribe(topic, null);
        try {
          const controlId = await this.#topicCommand(request);
          interest.attached();
          if (channel) return { state: 'acknowledged', controlId };
        } catch (reason) {
          const code = codeOf(reason);
          if (code !== undefined && code >= 400 && code < 500 && code !== 408 && code !== 429) {
            interest.refused();
            return { state: 'rejected', serverCode: code };
          }
          return { state: 'unknown' };
        }
      }
      // Writing from a joined session updates both the live topic and the saved subscription.
      if (!this.active || !this.#sdk || signal.aborted) throw new TinodeSessionFailure('closed');
      if (this.#metadataWriteBusy) throw new TinodeSessionFailure('invalidResponse');
      return await this.#writeMetadata(this.#sdk, topic, { sub: { mode } }, signal);
    } finally {
      if (interest.release()) {
        let detached = false;
        try {
          if (this.active) { await this.#topicCommand(this.leave(topic)); detached = true; }
        } catch { /* Keep an uncertain attachment isolated until the session closes. */ }
        finally { interest.detached(detached); }
      }
    }
  }

  async #writeChannelPush(topic: string, mode: string, finish: (connected: boolean) => void): Promise<TinodeMetadataWriteResult> {
    // An attached reader's set.sub can update only the server cache. Reattach
    // with sub.set to persist the reader's own P bit. Never unsubscribe.
    let connected = false, detached = false;
    try {
      await this.#topicCommand(this.leave(topic));
      detached = true;
      const controlId = await this.#topicCommand(this.#request(topic, sdk => sdk.subscribe(topic, null, { sub: { mode } })));
      connected = true;
      return { state: 'acknowledged', controlId };
    } catch (reason: unknown) {
      if (this.active) {
        // Restore the stream after a refusal or uncertain ACK, without repeating the write.
        try { await this.#topicCommand(this.subscribe(topic, null)); connected = true; }
        catch { /* The registry blocks a topic whose attachment could not be verified. */ }
      }
      const code = codeOf(reason);
      if (detached && connected && code !== undefined && code >= 400 && code < 500 && code !== 408 && code !== 429) {
        return { state: 'rejected', serverCode: code };
      }
      return { state: 'unknown' };
    } finally { finish(connected); }
  }

  #preparePublication(consumer: ConversationConsumer, operationId: string,
    content: TinodeTextContent, references?: readonly string[],
    editHead?: TinodeEditPayload['metadata'] & { readonly replace: string }): TinodePublication {
    const sdk = this.#sdk;
    if (!this.active || !sdk || this.#conversation !== consumer || consumer.lifetime.signal.aborted) throw new TinodeSessionFailure('closed');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId)) throw new TinodeSessionFailure('invalidResponse');
    const limit = sdk.getServerParam('maxMessageSize');
    if (!isInteger(limit, 1)) throw new TinodeSessionFailure('limitsUnavailable');
    // A cheap lower bound avoids serializing an already oversized input.
    if (content.txt.length > limit) throw new TinodeSessionFailure('tooLarge');
    const draft = sdk.createMessage(consumer.topic, content, false);
    const attachments = references?.length ? [...references] : undefined;
    const id = draft.id;
    if (typeof id !== 'string' || !id || draft.topic !== consumer.topic || draft.content?.txt !== content.txt ||
      this.#conversationReads.has(id) || this.#metadataRequests.has(id) || this.#conversationPublications.has(id) || this.#retiredPublications.has(id) || this.#retiredMetadataReads.has(id)) throw new TinodeSessionFailure('invalidResponse');
    // Passing a Drafty object bypasses parse(): @login remains literal text.
    draft.head = { mime: 'text/x-drafty', 'x-tinode-pwa-id': operationId, ...editHead };
    if (new TextEncoder().encode(JSON.stringify({ pub: draft, ...(attachments ? { extra: { attachments } } : {}) })).byteLength > limit) throw new TinodeSessionFailure('tooLarge');
    this.#conversationPublications.set(id, consumer);
    let sent = false;
    return Object.freeze({
      id,
      publish: () => {
        if (!this.active || this.#sdk !== sdk || this.#conversation !== consumer || consumer.lifetime.signal.aborted ||
          this.#conversationPublications.get(id) !== consumer) throw new TinodeSessionFailure('closed');
        if (sent) throw new TinodeSessionFailure('invalidResponse');
        sent = true;
        // Neither SDK Promise success nor a local rejection proves a server outcome.
        try { return sdk.publishMessage(draft, attachments).then(() => {}, (reason: unknown) => { throw new TinodeSessionFailure('rejected', codeOf(reason)); }); }
        catch (reason: unknown) { throw new TinodeSessionFailure('rejected', codeOf(reason)); }
      },
      dispose: () => { if (this.#conversationPublications.get(id) === consumer) { this.#conversationPublications.delete(id); if (sent) this.#retiredPublications.add(id); } },
    });
  }

  #readConversation(
    consumer: ConversationConsumer, query: TinodeConversationGetQuery, signal: AbortSignal, deferredSend: boolean, isolatedMetadata = false,
  ): TinodeConversationRequest {
    if (!this.active || !this.#sdk) { this.dispose(); throw new TinodeSessionFailure('closed'); }
    if (this.#conversation !== consumer || consumer.lifetime.signal.aborted) throw new TinodeSessionFailure('closed');
    if (signal.aborted) throw new TinodeSessionFailure('aborted');
    const checked = conversationQuery(query);
    const id = this.#sdk.getNextUniqueId();
    if (typeof id !== 'string' || id === '' || this.#conversationReads.has(id) || this.#metadataRequests.has(id) || this.#retiredMetadataReads.has(id)) {
      throw new TinodeSessionFailure('invalidResponse');
    }
    const response = new Promise<TinodeSessionObject>((resolve, reject) => {
      let finished = false;
      const finish = (success: boolean, value: unknown) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        consumer.lifetime.signal.removeEventListener('abort', close);
        this.#lifetime.signal.removeEventListener('abort', close);
        if (this.#conversationReads.get(id) === pending) this.#conversationReads.delete(id);
        // Do not route a reply to this panel's request to a later owner of the topic.
        if (isolatedMetadata) this.#retiredMetadataReads.add(id);
        if (success) resolve(value as TinodeSessionObject); else reject(value);
      };
      const cancel = () => finish(false, new TinodeSessionFailure('aborted'));
      const close = () => finish(false, new TinodeSessionFailure('closed'));
      const pending: PendingConversationRead = { topic: consumer.topic, consumer, what: checked.what, isolatedMetadata,
        resolve: (value) => finish(true, value), reject: (reason) => finish(false, reason) };
      const timer = setTimeout(() => pending.reject(new TinodeSessionFailure('rejected', 504)), metadataResponseTimeoutMs);
      this.#conversationReads.set(id, pending);
      signal.addEventListener('abort', cancel, { once: true });
      consumer.lifetime.signal.addEventListener('abort', close, { once: true });
      this.#lifetime.signal.addEventListener('abort', close, { once: true });
      const send = () => {
        if (finished) return;
        if (!this.active || !this.#sdk || this.#conversation !== consumer) { close(); return; }
        try {
          // Promise resolution does not end the data stream. Wait for a validated packet with our request ID.
          void this.#sdk.getMeta(consumer.topic, { ...checked, id }).catch((reason: unknown) => {
            // The router handles server ctrl 504. The local five-second SDK timeout does not end the read.
            if (codeOf(reason) !== 504) pending.reject(new TinodeSessionFailure('rejected', codeOf(reason)));
          });
        } catch (reason: unknown) { pending.reject(new TinodeSessionFailure('rejected', codeOf(reason))); }
      };
      if (deferredSend) queueMicrotask(send); else send();
    });
    return Object.freeze({ id, response });
  }

  #completeConversationRead(kind: TinodeConversationPacket['kind'], payload: Record<string, unknown>): void {
    if ((kind !== 'meta' && kind !== 'ctrl') || typeof payload.id !== 'string') return;
    const pending = this.#conversationReads.get(payload.id);
    if (!pending || pending.consumer !== this.#conversation ||
      (payload.topic !== undefined && payload.topic !== pending.topic)) return;
    const code = kind === 'ctrl' ? codeOf(payload) : undefined;
    if (code !== undefined && code >= 400) {
      pending.reject(new TinodeSessionFailure('rejected', code, 'server')); return;
    }
    if (payload.topic !== pending.topic) return;
    const params = isRecord(payload.params) ? payload.params : undefined;
    const complete = kind === 'meta' ? pending.what !== 'data' && payload[pending.what] !== undefined
      : code !== undefined && code >= 200 && code < 300 && params?.what === pending.what &&
        (pending.what !== 'data' || code === 204 || code === 208);
    if (!complete) return;
    try {
      const copied = projectConversationPacket(kind, payload, pending.consumer.messageByteLimit);
      if (!copied) throw new TinodeSessionFailure('invalidResponse');
      pending.resolve(copied.payload);
    } catch (reason: unknown) {
      pending.reject(new TinodeSessionFailure(reason instanceof TinodeConversationProjectionFailure ? 'tooLarge' : 'invalidResponse'));
    }
  }

  #routeConversation(packet: Record<string, unknown>): void {
    let kind: TinodeConversationPacket['kind'];
    if (isRecord(packet.meta)) kind = 'meta';
    else if (isRecord(packet.pres)) kind = 'pres';
    else if (isRecord(packet.data)) kind = 'data';
    else if (isRecord(packet.ctrl)) kind = 'ctrl';
    else if (isRecord(packet.info)) kind = 'info';
    else return;
    const payload = packet[kind] as Record<string, unknown>;
    const metadataOnly = typeof payload.id === 'string' && this.#conversationReads.get(payload.id)?.isolatedMetadata === true;
    this.#completeConversationRead(kind, payload);
    if (metadataOnly) return;
    const consumer = this.#conversation;
    if (!consumer) return;
    let selected = payload;
    if (payload.topic !== consumer.topic) {
      if (kind === 'ctrl' && payload.topic === undefined && typeof payload.id === 'string' && this.#conversationPublications.get(payload.id) === consumer) {
        // Topicless server errors are routed only by a previously registered pub id.
      } else if (kind === 'pres' && payload.topic === 'me' &&
        (payload.src === consumer.topic || (payload.what === 'term' && (payload.src === undefined || payload.src === 'me' || payload.src === this.account.uid)))) {
        // Route only the selected topic's events to this consumer, excluding unrelated topics and profiles.
      } else if (kind === 'meta' && payload.topic === 'me' && Array.isArray(payload.sub)) {
        const sub = payload.sub.filter((row: unknown) => isRecord(row) && row.topic === consumer.topic);
        if (sub.length === 0) return;
        selected = { topic: 'me', sub, ...(typeof payload.id === 'string' ? { id: payload.id } : {}) };
      } else return;
    }
    let copied: TinodeConversationPacket | undefined;
    try { copied = projectConversationPacket(kind, selected, consumer.messageByteLimit, this.account.uid); }
    catch (reason: unknown) {
      const failure = new TinodeSessionFailure(reason instanceof TinodeConversationProjectionFailure ? 'tooLarge' : 'invalidResponse');
      try { consumer.onError(failure); } catch { console.error('Tinode conversation error notification failed.'); }
      return;
    }
    if (copied && this.active && this.#conversation === consumer) {
      try { consumer.listener(copied); } catch { console.error('Tinode conversation subscriber notification failed.'); }
    }
  }

  onClose(cleanup: () => void): () => void {
    if (!this.active) {
      this.dispose();
      this.#runCleanup(cleanup);
      return () => {};
    }
    const subscription = () => cleanup();
    this.#cleanups.add(subscription);
    return () => { this.#cleanups.delete(subscription); };
  }

  topicInterest(topic: string, role: TinodeTopicRole): TinodeTopicInterest {
    return this.#topicInterests.create(topic, role);
  }
  topicInterestSnapshot() { return this.#topicInterests.snapshot(); }
  isTopicAttachmentBlocked(topic: string): boolean { return this.#topicInterests.isBlocked(topic); }
  retirePreviewRequest(id: string): void {
    if (typeof id === 'string' && id !== '' && !this.#metadataRequests.has(id) && !this.#conversationReads.has(id)) {
      this.#retiredMetadataReads.add(id);
    }
  }
  // Initial preview reads one frame. A replacement can require a bounded older page.
  getPreview(topic: string, members: boolean, before?: number): Promise<TinodeSessionObject> {
    if (!isConversationTopic(topic) || (before !== undefined && (!isInteger(before, 2) || members))) {
      return Promise.reject(new TinodeSessionFailure('invalidResponse'));
    }
    const data = before === undefined ? { limit: 1 } : { before, limit: 32 };
    return this.#request(topic, sdk => this.#requestMetadata(sdk, topic, members
      ? { what: 'sub data', sub: { limit: 32 }, data } : { what: 'data', data }));
  }

  subscribe(topic: string, query?: TinodeGetQuery | null): Promise<TinodeSessionObject> {
    if (query && !isQuery(query, true)) return Promise.reject(new TinodeSessionFailure('invalidResponse'));
    return this.#request(topic, (sdk) => sdk.subscribe(topic, query));
  }

  getMeta(topic: string, query: TinodeGetQuery): Promise<TinodeSessionObject> {
    if (!isQuery(query)) return Promise.reject(new TinodeSessionFailure('invalidResponse'));
    return this.#request(topic, (sdk) => query.what === 'data'
      ? sdk.getMeta(topic, query) : this.#requestMetadata(sdk, topic, query));
  }

  readChatActionMetadata(topic: string, what: 'description' | 'subscription', signal: AbortSignal): Promise<TinodeSessionObject> {
    if (!/^(?:usr|grp|chn)[A-Za-z0-9_-]+$/.test(topic) ||
      (what === 'description' && !groupTopicPattern.test(topic))) {
      return Promise.reject(new TinodeSessionFailure('invalidResponse'));
    }
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(5_000)]);
    return what === 'description'
      ? this.#request(topic, sdk => this.#requestMetadata(sdk, topic, { what: 'desc' }, deadline))
      : this.#request('me', sdk => this.#requestMetadata(sdk, 'me', { what: 'sub', sub: { topic } }, deadline));
  }

  rememberGroupCountBeforeAttach(topic: string, count?: unknown): void {
    if (!this.active || !groupTopicPattern.test(topic)) return;
    const confirmedCount = isInteger(count, 0) ? count : undefined;
    if (confirmedCount !== undefined || !this.#groupCountsBeforeAttach.has(topic)) {
      this.#groupCountsBeforeAttach.set(topic, confirmedCount);
    }
  }

  async readGroupCountBeforeAttach(topic: string, signal: AbortSignal): Promise<number | undefined> {
    if (!this.#groupCountsBeforeAttach.has(topic) || signal.aborted || !this.active) return undefined;
    const count = this.#groupCountsBeforeAttach.get(topic);
    this.#groupCountsBeforeAttach.set(topic, undefined);
    if (count !== undefined) return count;

    // Check the total while detached, before the description can diverge from the roster.
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(3_000)]);
    const reply = await this.#request(topic, sdk =>
      this.#requestMetadata(sdk, topic, { what: 'desc' }, deadline));
    return isRecord(reply.desc) && isInteger(reply.desc.subcnt, 0)
      ? reply.desc.subcnt : undefined;
  }

  createGroup(kind: GroupCreationKind, params: TinodeGroupCreationParams): Promise<TinodeGroupCreateReply> {
    const sdk = this.#sdk;
    if (!sdk || !this.active || this.#groupCreateReply) throw new TinodeSessionFailure('closed');
    const temporary = sdk.newGroupTopicName(kind === 'channel');
    const prefix = groupCreationTopicPrefix(kind);
    if (!temporary.startsWith(prefix) || !/^[A-Za-z0-9_-]+$/.test(temporary.slice(prefix.length))) {
      throw new TinodeSessionFailure('invalidResponse');
    }

    return new Promise(resolve => {
      const finish = (result: TinodeGroupCreateReply) => {
        if (this.#groupCreateReply !== receive) return;
        this.#groupCreateReply = undefined;
        clearTimeout(timer);
        this.#lifetime.signal.removeEventListener('abort', unknown);
        resolve(result);
      };
      const unknown = () => finish({ state: 'unknown' });
      const receive = (reply: unknown) => {
        if (!isRecord(reply) || typeof reply.id !== 'string' || !reply.id) return;
        const code = codeOf(reply);
        if ((code === 200 || code === 201) && typeof reply.topic === 'string' && groupTopicPattern.test(reply.topic) &&
          isRecord(reply.params) && reply.params.tmpname === temporary) {
          finish({ state: 'created', topicKey: reply.topic });
        } else if (reply.topic === temporary && code !== undefined && code >= 400) {
          // A server failure may happen after creating the topic, before its subscription is saved.
          if ([400, 401, 403, 404, 413, 422].includes(code)) finish({ state: 'rejected', code });
          else unknown();
        }
      };
      const timer = setTimeout(unknown, metadataResponseTimeoutMs);
      this.#groupCreateReply = receive;
      this.#lifetime.signal.addEventListener('abort', unknown, { once: true });
      try {
        // The raw ctrl remains observable after the SDK's shorter Promise timeout.
        void sdk.subscribe(temporary, null, params).then(receive, () => {});
      } catch { unknown(); }
    });
  }

  async findCreatedGroup(kind: GroupCreationKind, operationId: string, knownGroups: readonly string[]): Promise<string | undefined> {
    const sdk = this.#sdk;
    if (!this.active || !sdk || !groupCreationIdPattern.test(operationId)) throw new TinodeSessionFailure('invalidResponse');
    const deadline = AbortSignal.timeout(8_000);
    const response = await this.#requestMetadata(sdk, 'me', {
      what: 'sub', sub: { ims: '1970-01-01T00:00:00.000Z' },
    }, deadline);
    if (!this.active || !isRecord(response) || response.topic !== 'me' || !Array.isArray(response.sub)) return undefined;
    const hasMarker = (value: unknown) => isRecord(value) && value[groupCreationMarker] === operationId;
    const known = new Set(knownGroups);
    const candidates: { topic: string; listedMarker: boolean }[] = [];
    for (const row of response.sub) {
      if (!isRecord(row) || typeof row.topic !== 'string' || !groupTopicPattern.test(row.topic) || row.deleted) continue;
      const listedMarker = hasMarker(row.private);
      if (listedMarker && typeof row.chan === 'boolean' && row.chan === (kind === 'channel')) return row.topic;
      if (listedMarker || (!known.has(row.topic) && hasGroupOwnership(row.acs))) {
        const candidate = { topic: row.topic, listedMarker };
        if (listedMarker) candidates.unshift(candidate);
        else candidates.push(candidate);
      }
    }
    // Tinode 0.25 can omit both the private marker and the channel flag in me.sub.
    for (const { topic, listedMarker } of candidates.slice(0, 16)) {
      if (!this.active || deadline.aborted) break;
      const details = await this.#requestMetadata(sdk, topic, { what: 'desc' }, deadline).catch(() => undefined);
      if (!isRecord(details) || details.topic !== topic || !isRecord(details.desc)) continue;
      if (details.desc.chan !== undefined && typeof details.desc.chan !== 'boolean') continue;
      if ((details.desc.chan === true) === (kind === 'channel') &&
        (listedMarker || hasMarker(details.desc.private))) return topic;
    }
    return undefined;
  }

  async inviteGroupUser(topic: string, user: string, kind: GroupCreationKind): Promise<void> {
    if (!groupTopicPattern.test(topic) || !participantIdPattern.test(user) || user === this.account.uid) {
      throw new TinodeSessionFailure('invalidResponse');
    }
    const sub = groupInviteSubscription(user, kind);
    const response = await this.#request(topic, sdk => sdk.setMeta(topic, { sub }));
    if (response.code === 200 && (kind === 'group' ||
      (isRecord(response.params) && hasInvitedAccess(response.params.acs, kind)))) return;
    if ((response.code === 200 || response.code === 304) && await this.hasGroupMember(topic, user, kind)) return;
    throw new TinodeSessionFailure('invalidResponse');
  }

  async hasGroupMember(topic: string, user: string, kind: GroupCreationKind): Promise<boolean> {
    if (!groupTopicPattern.test(topic) || !participantIdPattern.test(user)) throw new TinodeSessionFailure('invalidResponse');
    const response = await this.getMeta(topic, { what: 'sub', sub: { user } });
    if (response.code === 204 && isRecord(response.params) && response.params.what === 'sub') return false;
    if (!Array.isArray(response.sub)) throw new TinodeSessionFailure('invalidResponse');
    return response.sub.some(row => isRecord(row) && row.user === user && !row.deleted && hasInvitedAccess(row.acs, kind));
  }

  openContactDiscovery(): TinodeContactDiscovery {
    if (!this.active) throw new TinodeSessionFailure('closed');
    const owner = Symbol();
    const lifetime = new AbortController();
    return {
      find: (tag, signal) => this.#queueDiscovery(() => this.#findContacts(owner, tag, AbortSignal.any([signal, lifetime.signal]))),
      dispose: () => {
        if (lifetime.signal.aborted) return;
        lifetime.abort();
        void this.#queueDiscovery(async () => {
          if (this.#discovery?.owner === owner) await this.#detachDiscovery();
        }).catch(() => {});
      },
    };
  }

  #queueDiscovery<T>(run: () => Promise<T>): Promise<T> {
    const request = this.#discoveryTail.then(run);
    this.#discoveryTail = request.then(() => {}, () => {});
    return request;
  }

  async #detachDiscovery(): Promise<void> {
    const discovery = this.#discovery;
    if (!discovery) return;
    discovery.attached = false;
    if (this.active) {
      const reply = await this.#request('fnd', sdk => sdk.leave('fnd', false), true);
      if (reply.code !== 200 && reply.code !== 304) throw new TinodeSessionFailure('invalidResponse');
    }
    this.#discovery = undefined;
  }

  async #findContacts(owner: symbol, tag: string, signal: AbortSignal): Promise<readonly TinodeSessionValue[]> {
    const prefix = tag.startsWith('alias:') ? 'alias:' : tag.startsWith('basic:') ? 'basic:' : undefined;
    if (!prefix || !discoveryTagValue.test(tag.slice(prefix.length))) throw new TinodeSessionFailure('invalidResponse');
    if (signal.aborted) throw new TinodeSessionFailure('aborted');
    if (!this.active) throw new TinodeSessionFailure('closed');
    if (this.#discovery && (this.#discovery.owner !== owner || !this.#discovery.attached)) await this.#detachDiscovery();
    try {
      if (!this.#discovery) {
        const discovery = { owner, attached: false };
        this.#discovery = discovery;
        const reply = await this.#request('fnd', sdk => sdk.subscribe('fnd'), true);
        if (reply.code !== 200 && reply.code !== 304) throw new TinodeSessionFailure('invalidResponse');
        discovery.attached = true;
      }
      if (signal.aborted) throw new TinodeSessionFailure('aborted');
      const set = await this.#request('fnd', sdk => sdk.setMeta('fnd', { desc: { public: tag } }), true);
      if (set.code !== 200 && set.code !== 304) throw new TinodeSessionFailure('invalidResponse');
      const reply = await this.#request('fnd', sdk => this.#requestMetadata(sdk, 'fnd',
        { what: 'sub', sub: { limit: discoveryResultLimit } }, signal), true);
      if (signal.aborted) throw new TinodeSessionFailure('aborted');
      if (Array.isArray(reply.sub) && reply.sub.length <= discoveryResultLimit) return reply.sub;
      if (reply.code === 204 && isRecord(reply.params) && reply.params.what === 'sub') return [];
      throw new TinodeSessionFailure('invalidResponse');
    } catch (reason: unknown) {
      await this.#detachDiscovery().catch(() => {});
      throw reason;
    }
  }

  readOwnProfile(signal: AbortSignal): Promise<TinodeSessionObject> {
    if (signal.aborted) return Promise.reject(new TinodeSessionFailure('aborted'));
    return this.#request('me', sdk => this.#requestMetadata(sdk, 'me', { what: 'desc', desc: {} }, signal));
  }

  writeOwnProfile(patch: OwnProfilePublicPatch, signal: AbortSignal): Promise<TinodeMetadataWriteResult> {
    const sdk = this.#sdk;
    if (!this.active || !sdk) throw new TinodeSessionFailure('closed');
    if (signal.aborted) throw new TinodeSessionFailure('aborted');
    if (this.#metadataWriteBusy || !isRecord(patch) || (patch.fn === undefined && patch.photo === undefined) ||
      Object.keys(patch).some(key => key !== 'fn' && key !== 'photo')) throw new TinodeSessionFailure('invalidResponse');
    const { fn, photo } = patch;
    if (fn !== undefined && !isProfileName(fn)) throw new TinodeSessionFailure('invalidResponse');
    let checkedPhoto: OwnProfilePublicPatch['photo'];
    if (photo === 'remove') checkedPhoto = photo;
    else if (photo !== undefined) {
      if (!isRecord(photo) || (photo.type !== 'jpeg' && photo.type !== 'png') ||
        typeof photo.data !== 'string' || photo.data === '' ||
        Object.keys(photo).some(key => key !== 'type' && key !== 'data')) throw new TinodeSessionFailure('invalidResponse');
      const data = photo.data;
      if (data.length > Math.ceil(maxOwnAvatarBytes / 3) * 4) throw new TinodeSessionFailure('tooLarge');
      if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new TinodeSessionFailure('invalidResponse');
      const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
      if (data.length / 4 * 3 - padding > maxOwnAvatarBytes) throw new TinodeSessionFailure('tooLarge');
      checkedPhoto = { type: photo.type, data };
    }
    const limit = sdk.getServerParam('maxMessageSize');
    if (!isInteger(limit, 1)) throw new TinodeSessionFailure('limitsUnavailable');
    const params = ownProfileSetParams({ fn, photo: checkedPhoto });
    if ((fn?.length ?? 0) > limit || ownProfileSetBytes(params) > limit) throw new TinodeSessionFailure('tooLarge');
    return this.#writeMetadata(sdk, 'me', params, signal);
  }

  async writeOwnDraft(topic: string, draft: ConversationDraft | undefined, updateHead: boolean,
    removeIds: readonly string[]): Promise<void> {
    if (!isConversationTopic(topic) || (draft && !normalizeConversationDraft(draft)) ||
      (!updateHead && draft !== undefined) || removeIds.length > maxDraftCleanup + 2) {
      throw new TinodeSessionFailure('invalidResponse');
    }
    const patch = draftPrivatePatch(draft, updateHead, removeIds);
    if (Object.keys(patch).length === 0) return;
    const result = await this.#request(topic, sdk => {
      const limit = sdk.getServerParam('maxMessageSize');
      const params = { desc: { private: patch } };
      const bytes = new TextEncoder().encode(JSON.stringify({ set: { id: '0'.repeat(24), topic, ...params } })).length;
      if (isInteger(limit, 1) && bytes > limit) throw new TinodeSessionFailure('tooLarge');
      return sdk.setMeta(topic, params);
    });
    if (result.code !== 200 && result.code !== 304) throw new TinodeSessionFailure('rejected', codeOf(result));
  }

  confirmChatUnsubscribed(topic: string): void {
    if (this.active && isConversationTopic(topic)) this.#topicInterests.unsubscribed(topic);
  }

  async isChatDeleted(topic: string, signal: AbortSignal): Promise<boolean> {
    try {
      await this.readChatActionMetadata(topic, 'description', signal);
      return false;
    } catch (reason) {
      // Detached grp descriptions are readable without membership. Only the server's 404 proves absence.
      return reason instanceof TinodeSessionFailure && reason.code === 404 && reason.origin === 'server';
    }
  }

  async deleteChatForAll(topic: string, signal: AbortSignal): Promise<'confirmed' | 'rejected' | 'unknown'> {
    if (!groupTopicPattern.test(topic) || !this.active || signal.aborted) throw new TinodeSessionFailure('invalidResponse');
    try {
      await this.#request(topic, sdk => sdk.delTopic(topic, true));
    } catch (reason) {
      const code = codeOf(reason);
      if (code !== undefined && code >= 400 && code < 500 && ![404, 408, 423, 429].includes(code)) return 'rejected';
    }
    // Tinode may return OK after removing only our subscription if ownership changed.
    if (this.active && !signal.aborted && await this.isChatDeleted(topic, signal)) {
      this.confirmChatUnsubscribed(topic);
      return 'confirmed';
    }
    return 'unknown';
  }

  async unsubscribeChat(topic: string, signal: AbortSignal, canSend: () => boolean,
    verifyAbsent: () => Promise<boolean>): Promise<'confirmed' | 'rejected' | 'unknown'> {
    if (!isConversationTopic(topic) || !this.active || signal.aborted) throw new TinodeSessionFailure('closed');
    const interest = this.#topicInterests.create(topic, 'departure');
    const confirmed = () => {
      this.confirmChatUnsubscribed(topic);
      return 'confirmed' as const;
    };
    const reconcile = async () => {
      try { if (this.active && !signal.aborted && await verifyAbsent()) return confirmed(); }
      catch { /* Preserve the card if the subscription could not be read. */ }
      return 'unknown' as const;
    };
    try {
      const physical = await interest.acquire(AbortSignal.any([signal, AbortSignal.timeout(metadataResponseTimeoutMs)]));
      if (!canSend()) {
        if (physical) interest.refused();
        return await reconcile();
      }
      if (physical) {
        try {
          await this.#topicCommand(this.subscribe(topic, null));
          interest.attached();
        } catch (reason) {
          const code = codeOf(reason);
          if (code !== undefined && code >= 400 && code < 500 && code !== 408 && code !== 429) interest.refused();
          // The membership may have been removed elsewhere while this session was attaching.
          if (await reconcile() === 'confirmed') return 'confirmed';
          return 'rejected';
        }
      }
      if (!canSend()) return await reconcile();
      try {
        const reply = await this.#request(topic, sdk => sdk.leave(topic, true));
        if (reply.code === 200 && typeof reply.id === 'string' && reply.id) return confirmed();
      } catch (reason) {
        const code = codeOf(reason);
        if (code !== undefined && code >= 400 && code < 500 && code !== 408 && code !== 429) return 'rejected';
      }
      return await reconcile();
    } finally {
      if (interest.release()) {
        let detached = false;
        try {
          if (this.active) { await this.#topicCommand(this.leave(topic)); detached = true; }
        } catch { /* An uncertain attachment stays blocked until a new session. */ }
        finally { interest.detached(detached); }
      }
    }
  }

  leave(topic: string): Promise<TinodeSessionObject> {
    return this.#request(topic, (sdk) => sdk.leave(topic, false));
  }

  #requestMetadata(sdk: SessionSdk, topic: string, query: TinodeGetQuery, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(new TinodeSessionFailure('aborted'));
    const id = sdk.getNextUniqueId();
    if (typeof id !== 'string' || id === '') return Promise.reject(new TinodeSessionFailure('invalidResponse'));
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (success: boolean, value: unknown) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.#lifetime.signal.removeEventListener('abort', cancel);
        signal?.removeEventListener('abort', abort);
        if (this.#metadataRequests.get(id) === pending) this.#metadataRequests.delete(id);
        if (success) resolve(value); else reject(value);
      };
      const cancel = () => finish(false, new TinodeSessionFailure('closed'));
      const abort = () => finish(false, new TinodeSessionFailure('aborted'));
      const pending: PendingMetadata = { topic,
        resolve: (value) => finish(true, value), reject: (reason) => finish(false, reason) };
      const timer = setTimeout(() => pending.reject(new TinodeSessionFailure('rejected', 504)), metadataResponseTimeoutMs);
      this.#metadataRequests.set(id, pending);
      this.#lifetime.signal.addEventListener('abort', cancel, { once: true });
      signal?.addEventListener('abort', abort, { once: true });
      if (!this.active) { cancel(); return; }
      try {
        // Public getMeta merges the query into the get packet. The SDK reserves the request ID.
        void sdk.getMeta(topic, { ...query, id }).then(pending.resolve, (reason: unknown) => {
          // onMessage has already handled a server ctrl 504. Only the local SDK timeout can reach this path.
          if (codeOf(reason) !== 504) pending.reject(reason);
        });
      } catch (reason: unknown) { pending.reject(reason); }
    });
  }

  #completeMetadata(packet: Record<string, unknown>): void {
    const control = isRecord(packet.ctrl);
    const payload = control ? packet.ctrl : packet.meta;
    if (!isRecord(payload) || typeof payload.id !== 'string') return;
    const pending = this.#metadataRequests.get(payload.id);
    if (!pending || (payload.topic !== undefined && payload.topic !== pending.topic)) return;
    const code = control ? codeOf(payload) : undefined;
    if (code !== undefined && code >= 400) {
      pending.reject(new TinodeSessionFailure('rejected', code, 'server'));
    } else if (payload.topic === pending.topic) pending.resolve(payload);
  }

  mediaUploadOrigin(): string {
    if (!this.active) throw new TinodeSessionFailure('closed');
    if (this.#mediaProxyOrigin) return this.#mediaProxyOrigin;
    const server = new URL(this.account.serverId);
    if (server.protocol !== 'wss:') throw new TinodeSessionFailure('invalidResponse');
    server.protocol = 'https:';
    return server.origin;
  }

  createMediaUpload() {
    const sdk = this.#sdk;
    if (!this.active || !sdk) throw new TinodeSessionFailure('closed');
    return sdk.getLargeFileHelper();
  }

  messageDeleteAgeSeconds(): number | undefined {
    const sdk = this.#sdk;
    if (!this.active || !sdk) throw new TinodeSessionFailure('closed');
    // getServerParam uses a truthy fallback and loses the explicit unlimited value 0.
    const value = sdk.getServerInfo()?.msgDelAge;
    return isInteger(value, 0) && value <= Math.floor(Number.MAX_SAFE_INTEGER / 1000) ? value : undefined;
  }

  subscriberLimit(): number | undefined {
    const sdk = this.#sdk;
    if (!this.active || !sdk) throw new TinodeSessionFailure('closed');
    const value = sdk.getServerParam('maxSubscriberCount');
    return isInteger(value, 1) ? value : undefined;
  }

  mediaLimits(): ServerLimits {
    const sdk = this.#sdk;
    if (!this.active || !sdk) throw new TinodeSessionFailure('closed');
    const limit = (name: string): ServerLimit => {
      const value = sdk.getServerParam(name);
      return Object.freeze(typeof value === 'number' && Number.isSafeInteger(value) && value > 0
        ? { state: 'known', value } : { state: 'unknown' });
    };
    const maxMessageSize = limit('maxMessageSize');
    const maxFileUploadSize = limit('maxFileUploadSize');
    if (this.#mediaProxyOrigin || this.account.serverId !== 'wss://' + sandboxHost) {
      return Object.freeze({ maxMessageSize, maxFileUploadSize });
    }
    // The sandbox file API blocks cross-origin uploads. Reserve room in the
    // WebSocket packet for Drafty metadata, the filename, and the envelope.
    const available = maxMessageSize.state === 'known' ? maxMessageSize.value - 2048 : 0;
    const maxInlineMediaSize: ServerLimit = available >= 4
      ? { state: 'known', value: Math.min(inlineMediaByteLimit, Math.floor(available / 4) * 3) }
      : { state: 'unknown' };
    return Object.freeze({ maxMessageSize, maxFileUploadSize, maxInlineMediaSize: Object.freeze(maxInlineMediaSize) });
  }

  // Internal media stream. Add credentials only for the session's HTTPS origin.
  async fetchMediaResponse(reference: string, signal: AbortSignal): Promise<Response> {
    const sdk = this.#sdk;
    if (!this.active || !sdk) throw new TinodeSessionFailure('closed');
    if (signal.aborted) throw new TinodeSessionFailure('aborted');
    let request: URL;
    const headers = new Headers();
    try {
      const server = new URL(this.account.serverId);
      if (server.protocol !== 'wss:') throw new TinodeSessionFailure('invalidResponse');
      server.protocol = 'https:';
      if (!reference.trim() || reference.length > 8192) throw new TinodeSessionFailure('invalidResponse');
      const target = new URL(reference, server.origin + '/');
      if (target.origin !== server.origin || target.username || target.password || target.hash ||
        [...target.searchParams.keys()].some(key => /^(?:auth|secret|apikey|token|access_token)$/i.test(key))) {
        throw new TinodeSessionFailure('invalidResponse');
      }
      // Pass a path with a single leading slash. A URL beginning with // could switch origins.
      if (target.pathname.startsWith('//')) throw new TinodeSessionFailure('invalidResponse');
      request = new URL(sdk.authorizeURL(target.pathname + target.search), server.origin);
      if (request.origin !== server.origin || request.username || request.password || request.hash) {
        throw new TinodeSessionFailure('invalidResponse');
      }
      if (this.#mediaProxyOrigin) {
        if (!/^\/v0\/file\/s(?:\/|$)/.test(request.pathname)) throw new TinodeSessionFailure('invalidResponse');
        const key = request.searchParams.get('apikey'), token = request.searchParams.get('secret');
        if (key) headers.set('X-Tinode-APIKey', key);
        if (token && request.searchParams.get('auth') === 'token') headers.set('X-Tinode-Auth', 'Token ' + token);
        for (const parameter of ['apikey', 'auth', 'secret']) request.searchParams.delete(parameter);
        request = new URL(request.pathname + request.search, this.#mediaProxyOrigin);
      }
    } catch {
      throw new TinodeSessionFailure('invalidResponse');
    }
    try {
      return await fetch(request.href, { signal, headers, mode: 'cors', credentials: 'omit',
        cache: 'no-store', referrerPolicy: 'no-referrer', redirect: 'error' });
    } catch {
      // Keep the fetch exception private because it can contain an authenticated URL.
      if (!this.active) throw new TinodeSessionFailure('closed');
      throw new TinodeSessionFailure(signal.aborted ? 'aborted' : 'rejected');
    }
  }

  // Expose only avatar bytes. The authenticated URL stays inside the scope and out of the model.
  async fetchAvatar(reference: string, signal: AbortSignal): Promise<Blob> {
    if (!this.active || !this.#sdk) throw new TinodeSessionFailure('closed');
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    this.#lifetime.signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted || this.#lifetime.signal.aborted) abort();
    try {
      const server = new URL(this.account.serverId);
      server.protocol = server.protocol === 'wss:' ? 'https:' : 'http:';
      const target = new URL(reference, server.origin + '/');
      if (target.protocol !== 'https:' || target.username || target.password ||
        [...target.searchParams.keys()].some((key) => /^(?:auth|secret|apikey|token|access_token)$/i.test(key))) {
        throw new TinodeSessionFailure('invalidResponse');
      }
      target.hash = '';
      let requestUrl = target.href;
      if (target.origin === server.origin) {
        requestUrl = new URL(this.#sdk.authorizeURL(target.pathname + target.search), server.origin).href;
        if (new URL(requestUrl).origin !== server.origin) throw new TinodeSessionFailure('invalidResponse');
      }
      const response = await fetch(requestUrl, { signal: controller.signal, credentials: 'omit',
        cache: 'no-store', referrerPolicy: 'no-referrer', redirect: 'error' });
      if (!response.ok || response.type === 'opaque' ||
        Number(response.headers.get('content-length')) > tinodeAvatarByteLimit) {
        await response.body?.cancel();
        throw new TinodeSessionFailure('rejected');
      }
      if (!response.body) throw new TinodeSessionFailure('invalidResponse');
      const reader = response.body.getReader();
      const chunks: BlobPart[] = [];
      let size = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > tinodeAvatarByteLimit) throw new TinodeSessionFailure('invalidResponse');
          chunks.push(part.value.slice());
        }
      } catch {
        await reader.cancel().catch(() => {});
        throw new TinodeSessionFailure('rejected');
      } finally { reader.releaseLock(); }
      if (!this.active) throw new TinodeSessionFailure('closed');
      if (controller.signal.aborted) throw new TinodeSessionFailure('rejected');
      return new Blob(chunks, { type: response.headers.get('content-type') ?? '' });
    } catch (reason: unknown) {
      if (!this.active) throw new TinodeSessionFailure('closed');
      if (reason instanceof TinodeSessionFailure) throw reason;
      // Fetch exceptions can contain URLs, so discard the original error and cause.
      throw new TinodeSessionFailure('rejected');
    } finally {
      signal.removeEventListener('abort', abort);
      this.#lifetime.signal.removeEventListener('abort', abort);
    }
  }

  async #request(topic: string, run: (sdk: SessionSdk) => Promise<unknown>, discovery = false): Promise<TinodeSessionObject> {
    if (discovery ? topic !== 'fnd' : !isTopic(topic)) throw new TinodeSessionFailure('invalidResponse');
    if (!this.active || !this.#sdk) { this.dispose(); throw new TinodeSessionFailure('closed'); }
    const sdk = this.#sdk;
    if (!discovery) this.#topics.add(topic);
    let cancel!: () => void;
    const closed = new Promise<never>((_, reject) => {
      cancel = () => reject(new TinodeSessionFailure('closed'));
    });
    this.#lifetime.signal.addEventListener('abort', cancel, { once: true });
    try {
      const request = Promise.resolve().then(() => {
        if (!this.active) throw new TinodeSessionFailure('closed');
        return run(sdk);
      });
      const response = await Promise.race([closed, request]);
      if (!this.active) throw new TinodeSessionFailure('closed');
      if (!isRecord(response) || response.topic !== topic) throw new TinodeSessionFailure('invalidResponse');
      const control = codeOf(response);
      if ('code' in response && control === undefined) throw new TinodeSessionFailure('invalidResponse');
      return control === undefined ? projectOwnSubscriptionMetadata(response) : projectedObject(response, shapes.ctrl);
    } catch (reason: unknown) {
      if (!this.active) { this.dispose(); throw new TinodeSessionFailure('closed'); }
      if (reason instanceof TinodeSessionFailure) throw reason;
      // Keep the raw SDK exception, its message, and its cause inside the integration layer.
      throw new TinodeSessionFailure('rejected', codeOf(reason));
    } finally {
      this.#lifetime.signal.removeEventListener('abort', cancel);
    }
  }

  readonly #route = (packet: unknown): void => {
    if (!this.active) { this.dispose(); return; }
    if (!isRecord(packet)) return;
    // Delete ACK is consumed by the SDK promise, not by a topic's attach/leave listener.
    if (isRecord(packet.ctrl) && isRecord(packet.ctrl.params) && isInteger(packet.ctrl.params.del, 1)) return;
    const metadataReply = isRecord(packet.meta) ? packet.meta : isRecord(packet.ctrl) ? packet.ctrl : undefined;
    if (typeof metadataReply?.id === 'string' && this.#retiredMetadataReads.has(metadataReply.id)) return;
    const metadataOnly = typeof metadataReply?.id === 'string' && this.#conversationReads.get(metadataReply.id)?.isolatedMetadata === true;
    // Old publication replies must not bind to a later attach/leave or preview.
    if (isRecord(packet.ctrl) && typeof packet.ctrl.id === 'string' && this.#retiredPublications.has(packet.ctrl.id)) return;
    try {
      this.#groupCreateReply?.(packet.ctrl);
      this.#routeReadState(packet);
      this.#completeMetadata(packet);
      this.#routeConversation(packet);
      if (metadataOnly || (typeof metadataReply?.id === 'string' && this.#retiredMetadataReads.has(metadataReply.id))) return;
      let kind: TinodeSessionPacket['kind'];
      let payload: Record<string, unknown>;
      if (isRecord(packet.meta)) kind = 'meta';
      else if (isRecord(packet.pres)) kind = 'pres';
      else if (isRecord(packet.data)) kind = 'data';
      else if (isRecord(packet.ctrl)) kind = 'ctrl';
      else return;
      payload = packet[kind] as Record<string, unknown>;
      if (typeof payload.topic !== 'string' || !this.#topics.has(payload.topic)) return;
      if (kind === 'meta' && payload.desc === undefined && payload.sub === undefined) return;
      if (kind === 'pres' && (typeof payload.what !== 'string' || !presenceKinds.has(payload.what))) return;
      if (kind === 'ctrl') {
        const params = isRecord(payload.params) ? payload.params : undefined;
        const code = codeOf(payload);
        // A nested sub.get error can omit params.what. Its ID still identifies the request.
        const topicError = payload.topic !== 'me' && code !== undefined && code >= 400 &&
          typeof payload.id === 'string' && payload.id !== '';
        // The SDK's sub.get promise can settle on metadata or end-of-data before this ACK arrives.
        const topicAck = code !== undefined && code >= 200 && code < 400 &&
          typeof payload.id === 'string' && payload.id !== '' && params?.what === undefined;
        if (code === undefined ||
          (!['desc', 'sub', 'data'].includes(String(params?.what)) && code !== 205 && !topicError && !topicAck)) return;
      }
      const copied = Object.freeze({ kind, payload: kind === 'meta'
        ? projectOwnSubscriptionMetadata(payload) : projectedObject(payload, shapes[kind]) });
      for (const listener of [...this.#listeners]) {
        if (!this.active) break;
        try { listener(copied); }
        catch { console.error('Tinode session subscriber notification failed.'); }
      }
    } catch {
      // A child layer error cannot interrupt dispatch or the SDK authentication promise.
      console.error('Tinode session packet projection failed.');
    }
  };

  dispose(): void {
    if (this.#closed) return;
    this.#closed = true;
    const sdk = this.#sdk;
    this.#sdk = undefined;
    this.#ownerIsCurrent = () => false;
    if (sdk?.onMessage === this.#route) sdk.onMessage = undefined;
    this.#listeners.clear(); this.#readListeners.clear(); this.#confirmedReads.clear(); this.#ownPushListeners.clear(); this.#groupProfileListeners.clear();
    this.#topicInterests.dispose();
    this.#groupCountsBeforeAttach.clear();
    this.#topics.clear(); this.#uncorrelatedDeletions.clear(); this.#conversationPublications.clear(); this.#retiredPublications.clear();
    const consumer = this.#conversation;
    this.#conversation = undefined;
    consumer?.lifetime.abort();
    this.#lifetime.abort();
    this.#retiredMetadataReads.clear();
    const cleanups = [...this.#cleanups];
    this.#cleanups.clear();
    for (const cleanup of cleanups) this.#runCleanup(cleanup);
  }

  #runCleanup(cleanup: () => void): void {
    try { cleanup(); }
    catch { console.error('Tinode session cleanup failed.'); }
  }
}
