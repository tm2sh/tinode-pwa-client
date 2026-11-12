import type { ConversationHeader, ConversationIdentity, ConversationMessage, ConversationReceipt } from './conversation-types';

export type ConversationOutgoingReadStatus = 'sent' | 'read';
export type ConversationReadStatus = (message: ConversationMessage) => ConversationOutgoingReadStatus | undefined;

export function createConversationReadStatus(
  identity: ConversationIdentity,
  header: ConversationHeader,
  receipts: readonly ConversationReceipt[],
): ConversationReadStatus {
  const ownUid = identity.account.uid;
  const peerUid = identity.kind === 'personal' ? identity.topicKey : undefined;
  const channel = identity.topicKey.startsWith('chn') || (header.kind === 'group' && header.isChannel === true);
  let readThrough = 0;
  if (!channel) {
    for (const { uid, readSeq } of receipts) {
      if (uid === ownUid || (peerUid !== undefined && uid !== peerUid) || readSeq.state !== 'known') continue;
      if (Number.isSafeInteger(readSeq.value)) readThrough = Math.max(readThrough, readSeq.value);
    }
  }

  return message => {
    if (message.delivery !== 'serverConfirmed' || message.sender.state !== 'self' || message.sender.uid !== ownUid) return;
    const originalSeq = message.originalSeq ?? message.serverSeq;
    if (!Number.isSafeInteger(originalSeq) || originalSeq <= 0) return;
    return originalSeq <= readThrough ? 'read' : 'sent';
  };
}
