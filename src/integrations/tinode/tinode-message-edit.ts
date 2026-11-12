import type { TinodeTextContent } from 'tinode-sdk';
import type { ConversationMessage, ConversationTextSpan } from '../../conversation/conversation-types';
import { graphemeOffsets, safeLink } from '../../conversation/conversation-normalize';
import type { TinodeSessionObject } from './TinodeSessionScope';

type Format = { readonly at: number; readonly len: number } & ({ readonly tp: string } | { readonly key: number });
type Entity = { readonly tp: string; readonly data: Readonly<Record<string, unknown>> };
interface EditBody extends TinodeTextContent {
  readonly fmt?: readonly Format[];
  readonly ent?: readonly Entity[];
}
export interface TinodeEditPayload {
  readonly content: EditBody;
  readonly references: readonly string[];
  readonly metadata: { readonly reply?: string; readonly thread?: string; readonly forwarded?: string };
}

const styles = { bold: 'ST', italic: 'EM', strike: 'DL', code: 'CO', quote: 'QQ', highlight: 'HL' } as const;
const mediaTypes = { photo: 'IM', video: 'VD', file: 'EX' } as const;
function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function linkableReference(value: unknown, origin: string): string | undefined {
  if (typeof value !== 'string' || value.length > 8192 || /[\s\\]/u.test(value)) return;
  try {
    const url = new URL(value, origin + '/');
    if (url.origin === origin && !url.username && !url.password && /^\/v0\/file\/s\/[^/]+$/.test(url.pathname)) return url.pathname;
  } catch { /* External or malformed URLs must not be registered as uploaded files. */ }
}

function indexOfBoundary(offsets: Uint32Array, value: number): number | undefined {
  let low = 0, high = offsets.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const offset = offsets[mid]!;
    if (offset === value) return mid;
    if (offset < value) low = mid + 1; else high = mid - 1;
  }
}

function unchangedEdges(previous: string, next: string, old: Uint32Array, current: Uint32Array) {
  const limit = Math.min(old.length, current.length) - 1;
  const same = (a: number, b: number) => previous.slice(old[a], old[a + 1]) === next.slice(current[b], current[b + 1]);
  let prefix = 0, suffix = 0;
  while (prefix < limit && same(prefix, prefix)) prefix++;
  while (prefix + suffix < limit && same(old.length - suffix - 2, current.length - suffix - 2)) suffix++;
  return { prefixEnd: old[prefix]!, suffixStart: old[old.length - suffix - 1]! };
}

export function prepareTinodeEdit(message: ConversationMessage, packet: TinodeSessionObject, text: string,
  serverId: string): TinodeEditPayload | undefined {
  if (!text.trim() || text.length > 1024 * 1024) return;
  const original = message.content.text;
  const media = message.content.attachments.map(part => part.kind === 'photo' ? mediaTypes.photo
    : part.kind === 'unsupported' && (part.contentType === 'file' || part.contentType === 'video') ? mediaTypes[part.contentType] : undefined);
  const from = record(packet.content) ? packet.content : undefined;
  const stored = Array.isArray(from?.ent) ? from.ent : [];
  const placements = Array.isArray(from?.fmt) && from.fmt.length ? from.fmt : stored.length ? [{}] : [];
  const parts = new Map<number, Entity>();
  for (const span of placements) {
    if (!record(span) || span.tp !== undefined) continue;
    const key = span.key ?? 0;
    if (typeof key !== 'number' || !Number.isSafeInteger(key) || parts.has(key)) continue;
    const entity = stored[key];
    if (record(entity) && (entity.tp === 'IM' || entity.tp === 'EX' || entity.tp === 'VD')) {
      if (!record(entity.data)) return;
      parts.set(key, { tp: entity.tp, data: entity.data });
    }
  }
  if (parts.size !== media.length || [...parts.values()].some((part, index) => part.tp !== media[index])) return;

  const normalized = text.replace(/\r\n?/g, '\n');
  const previous = graphemeOffsets(original.text), next = graphemeOffsets(normalized);
  if (!previous || !next) return;
  const old = previous.offsets.subarray(0, previous.count + 1), current = next.offsets.subarray(0, next.count + 1);
  const { prefixEnd, suffixStart } = unchangedEdges(original.text, normalized, old, current);
  const fmt: Format[] = [], ent: Entity[] = [];
  const styled = (span: ConversationTextSpan) => {
    const end = span.start + span.length;
    const shift = end <= prefixEnd ? 0 : span.start >= suffixStart ? normalized.length - original.text.length : undefined;
    if (shift === undefined) return;
    const at = indexOfBoundary(current, span.start + shift), to = indexOfBoundary(current, end + shift);
    if (at === undefined || to === undefined || to <= at) return;
    if (span.kind !== 'link') fmt.push({ at, len: to - at, tp: styles[span.kind] });
    else if (safeLink(span.url)) {
      fmt.push({ at, len: to - at, key: ent.length });
      ent.push({ tp: 'LN', data: { url: span.url } });
    }
  };
  for (const span of original.spans) styled(span);
  for (const [at, offset] of current.entries()) if (normalized[offset] === '\n') fmt.push({ at, len: 1, tp: 'BR' });
  let txt = normalized.replace(/\n/g, ' ');
  let at = current.length - 1;
  const head = record(packet.head) ? packet.head : undefined;
  const references = new Set<string>();
  const origin = new URL(serverId.replace(/^ws(s?):/i, 'http$1:')).origin;
  const addReference = (value: unknown) => { const ref = linkableReference(value, origin); if (ref) references.add(ref); };
  for (const part of parts.values()) {
    const key = ent.length;
    ent.push(part);
    if (part.tp === 'EX') fmt.push({ at: -1, len: 0, key });
    else { fmt.push({ at: at++, len: 1, key }); txt += ' '; }
    addReference(part.data.ref);
    addReference(part.data.preref);
  }
  if (Array.isArray(head?.attachments)) for (const ref of head.attachments) addReference(ref);
  // The editor is plain text. Do not recreate mention notifications from text or old headers.
  const metadata: { reply?: string; thread?: string; forwarded?: string } = {};
  for (const key of ['reply', 'thread', 'forwarded'] as const) {
    const value = head?.[key];
    if (typeof value === 'string' && /^(?:(?:usr|grp|chn)[A-Za-z0-9_-]+)?:[1-9]\d{0,15}$/.test(value)) metadata[key] = value;
  }
  if (fmt.length > 4096 || ent.length > 4096) return;
  return { content: { txt, ...(fmt.length ? { fmt } : {}), ...(ent.length ? { ent } : {}) }, references: [...references], metadata };
}
