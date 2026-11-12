import type { ConversationIdentity, ConversationMessage, ConversationPermissions } from './conversation-types';

export interface ConversationDeleteOptions {
  readonly self: boolean;
  readonly all: boolean;
  readonly allExpiresAt?: number;
}
const unavailable: ConversationDeleteOptions = Object.freeze({ self: false, all: false });
const ownHistory: ConversationDeleteOptions = Object.freeze({ self: true, all: false });
const both: ConversationDeleteOptions = Object.freeze({ self: true, all: true });

export function conversationDeleteOptions(message: ConversationMessage, identity: ConversationIdentity,
  permissions: ConversationPermissions, maxAgeSeconds: number | undefined, now = Date.now()): ConversationDeleteOptions {
  if (message.delivery !== 'serverConfirmed' || !Number.isSafeInteger(message.serverSeq) || message.serverSeq < 1 ||
    (message.originalSeq !== undefined && message.originalSeq !== message.serverSeq) ||
    identity.topicKey.startsWith('chn') || permissions.canRead.state !== 'allowed') return unavailable;
  if (permissions.canDelete.state !== 'allowed' || message.sender.state !== 'self' ||
    message.sender.uid !== identity.account.uid || maxAgeSeconds === undefined ||
    !Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 0) return ownHistory;
  if (maxAgeSeconds === 0) return both;
  const sentAt = message.timestamp.state === 'known' ? Date.parse(message.timestamp.at) : NaN;
  const allExpiresAt = sentAt + maxAgeSeconds * 1000;
  return Number.isFinite(sentAt) && sentAt <= now && now < allExpiresAt ? { self: true, all: true, allExpiresAt } : ownHistory;
}
