import type { ConversationMessage } from './conversation-types';

export function canEditConversationMessage(message: ConversationMessage): boolean {
  return message.delivery === 'serverConfirmed' && message.sender.state === 'self' &&
    message.content.text.text.trim().length > 0 &&
    message.content.attachments.every(part => part.kind === 'photo' ||
      (part.kind === 'unsupported' && (part.contentType === 'file' || part.contentType === 'video')));
}
