import type { GroupPublicPatch } from '../chat-info/group-public-patch';
import type { GroupCreationKind } from './group-creation-types';

export const groupCreationMarker = 'x-tinode-pwa-group-create';
export const groupCreationIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export const groupTopicPattern = /^grp[A-Za-z0-9_-]+$/;
export const participantIdPattern = /^usr[A-Za-z0-9_-]+$/;
const maxRequestId = String(Number.MAX_SAFE_INTEGER);

export function groupCreationParams(fn: string, operationId: string, photo?: GroupPublicPatch['photo']) {
  return { desc: { public: { fn, ...(photo ? { photo } : {}) }, private: { [groupCreationMarker]: operationId } } };
}

export function groupCreationTopicPrefix(kind: GroupCreationKind): 'new' | 'nch' {
  return kind === 'channel' ? 'nch' : 'new';
}

export function groupCreationPacketBytes(params: ReturnType<typeof groupCreationParams>, kind: GroupCreationKind): number {
  const sub = { id: maxRequestId, topic: groupCreationTopicPrefix(kind) + maxRequestId, set: params };
  return new TextEncoder().encode(JSON.stringify({ sub })).byteLength;
}
