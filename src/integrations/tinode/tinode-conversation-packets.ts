import type { TinodeSessionObject, TinodeSessionValue } from './TinodeSessionScope';

export interface TinodeConversationPacket {
  readonly kind: 'meta' | 'pres' | 'data' | 'ctrl' | 'info';
  readonly payload: TinodeSessionObject;
}

// This limits the additional projection. It does not configure the server, WebSocket, or JSON.parse.
export const conversationProjectionByteLimit = 1024 * 1024;
const arrayEntryLimit = 4096;
type Shape = true | { readonly [key: string]: Shape } | readonly [Shape];
const profile = { fn: true, photo: { type: true, data: true, ref: true } } as const;
const access = { mode: true, given: true, want: true } as const;
const description = {
  created: true, updated: true, touched: true, deleted: true,
  seq: true, read: true, recv: true, del: true, acs: access, public: profile,
  online: true, seen: { when: true }, subcnt: true, chan: true,
} as const;
const deletionRange = { low: true, hi: true } as const;
const entitySummary = { mime: true, name: true, duration: true, size: true } as const;
const entity = { tp: true, data: entitySummary } as const;
const editableEntityData: Readonly<Record<string, Shape>> = {
  EX: { ...entitySummary, ref: true, val: true },
  VD: { ...entitySummary, ref: true, val: true, preref: true, preview: true, width: true, height: true },
};
const entityData: Readonly<Record<string, Shape>> = {
  IM: { ...entitySummary, ref: true, val: true, width: true, height: true },
  AU: { ...entitySummary, ref: true, val: true, preview: true },
  MN: { ...entitySummary, val: true },
  LN: { url: true },
};
const shapes = {
  meta: {
    id: true, topic: true, ts: true, desc: description,
    sub: [{ ...description, topic: true, user: true }],
    del: { clear: true, delseq: [deletionRange] },
  },
  pres: {
    topic: true, src: true, what: true, seq: true, act: true, tgt: true,
    ts: true, clear: true, delseq: [deletionRange], ua: true, dacs: access, acs: access,
  },
  data: {
    topic: true, from: true, seq: true, ts: true,
    head: { mime: true, replace: true, mentions: [true], forwarded: true, reply: true, thread: true, attachments: [true], 'x-tinode-pwa-id': true },
    content: { txt: true, fmt: [{ at: true, len: true, key: true, tp: true }], ent: [entity] },
  },
  ctrl: { id: true, topic: true, code: true, ts: true,
    params: { what: true, count: true, unsub: true, seq: true } },
  info: { topic: true, from: true, what: true, seq: true },
} as const satisfies Record<TinodeConversationPacket['kind'], Shape>;
const presenceKinds = new Set(['on', 'off', 'ua', 'msg', 'read', 'recv', 'upd', 'acs', 'gone', 'del', 'term']);

export class TinodeConversationProjectionFailure extends Error {
  constructor() { super('Tinode conversation projection exceeds its budget.'); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

class Budget {
  #remaining: number;
  constructor(bytes: number, readonly own: boolean) { this.#remaining = bytes; }
  take(bytes: number): void {
    this.#remaining -= bytes;
    if (this.#remaining < 0) throw new TinodeConversationProjectionFailure();
  }
  string(value: string): void {
    this.take(2);
    // Check the length without creating another large Uint8Array or JSON string.
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);
      if (code < 0x20) this.take(6);
      else if (code === 0x22 || code === 0x5c) this.take(2);
      else if (code < 0x80) this.take(1);
      else if (code < 0x800) this.take(2);
      else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length &&
        value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
        this.take(4); index++;
      } else this.take(code >= 0xd800 && code <= 0xdfff ? 6 : 3);
    }
  }
}

function copy(value: unknown, shape: Shape, budget: Budget): TinodeSessionValue | undefined {
  if (value === null) { budget.take(4); return null; }
  if (typeof value === 'string') { budget.string(value); return value; }
  if (typeof value === 'boolean') { budget.take(value ? 4 : 5); return value; }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined;
    budget.take(String(value).length); return value;
  }
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? copy(value.toISOString(), true, budget) : undefined;
  if (Array.isArray(shape)) {
    if (!Array.isArray(value)) return undefined;
    if (value.length > arrayEntryLimit) throw new TinodeConversationProjectionFailure();
    budget.take(2 + value.length);
    return Object.freeze(value.map((entry: unknown) => {
      const copied = copy(entry, shape[0], budget);
      if (copied === undefined) budget.take(4);
      return copied ?? null;
    }));
  }
  if (shape === true || !isRecord(value)) return undefined;
  budget.take(2);
  const result: Record<string, TinodeSessionValue> = {};
  for (const [key, nested] of Object.entries(shape)) {
    if (value[key] === undefined) continue;
    budget.string(key); budget.take(2);
    const selected = shape === entity && key === 'data' && typeof value.tp === 'string'
      ? ((budget.own && Object.hasOwn(editableEntityData, value.tp) ? editableEntityData[value.tp] : undefined)
        ?? (Object.hasOwn(entityData, value.tp) ? entityData[value.tp] : undefined) ?? nested) : nested;
    const copied = copy(value[key], selected, budget);
    if (copied !== undefined) result[key] = copied;
  }
  return Object.freeze(result);
}

export function projectConversationPacket(
  kind: TinodeConversationPacket['kind'], payload: Record<string, unknown>, messageByteLimit: number, ownUid?: string,
): TinodeConversationPacket | undefined {
  if (kind === 'meta' && payload.desc === undefined && payload.sub === undefined && payload.del === undefined) return;
  if (kind === 'pres' && (typeof payload.what !== 'string' || !presenceKinds.has(payload.what))) return;
  if (kind === 'info' && payload.what !== 'read' && payload.what !== 'recv') return;
  const budget = new Budget(kind === 'data'
    ? Math.min(messageByteLimit, conversationProjectionByteLimit) : conversationProjectionByteLimit,
    ownUid !== undefined && payload.from === ownUid);
  const copied = copy(payload, shapes[kind], budget);
  if (!isRecord(copied)) return;
  return Object.freeze({ kind, payload: copied as TinodeSessionObject });
}
