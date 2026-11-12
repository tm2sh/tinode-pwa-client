import { ChatAvatar } from './ChatAvatar';
import { MutedChatIcon } from './MutedChatIcon';
import type { ChatListItemView } from '../chat-list-presenter';

interface ChatListItemProps {
  readonly item: ChatListItemView;
  readonly onOpen?: (topicKey: string) => void;
  readonly onRef: (key: string, element: HTMLLIElement | null) => void;
}

export function ChatListItem({ item, onRef, onOpen }: ChatListItemProps) {
  return (
    <li data-chat-action-topic={onOpen ? item.topicKey : undefined} className={'chat-list-item chat-list-' + item.kind} ref={(element) => onRef(item.topicKey, element)} aria-label={onOpen ? undefined : item.ariaLabel}>
      {onOpen && <button type="button" className="chat-list-open" aria-keyshortcuts="ContextMenu Shift+F10" onClick={() => onOpen(item.topicKey)} aria-label={item.ariaLabel} />}
      <ChatAvatar avatar={item.avatar} name={item.title} className="chat-list-avatar" />
      <div className="chat-list-copy" aria-hidden="true">
        <div className="chat-list-title">
          <span className="chat-list-name" title={item.title}>{item.title}</span>
          {item.notificationsMuted && <MutedChatIcon />}
        </div>
        {item.sender && <div className="chat-list-sender" title={item.sender.name}>
          <ChatAvatar avatar={item.sender.avatar} name={item.sender.name} className="chat-list-sender-avatar" imageOnly />
          <span>{item.sender.name}</span>
        </div>}
        <span className={'chat-list-preview chat-list-preview-' + item.preview.state}
          title={item.preview.ariaLabel}>
          {item.draftLabel && <><strong className="chat-list-draft-label">{item.draftLabel}</strong>{' '}</>}
          {item.preview.text}
        </span>
        {item.preview.lastKnown && item.preview.warning &&
          <p className="chat-list-preview-warning">{item.preview.warning}</p>}
      </div>
      {item.time.state === 'known' && <time className="chat-list-time" dateTime={item.time.dateTime}
        title={item.time.ariaLabel} aria-hidden="true">{item.time.text}</time>}
      <div className="chat-list-badges" aria-hidden="true">
        {item.unread.state !== 'hidden' && <span className={'chat-list-unread chat-list-unread-' + item.unread.state}
          data-muted={item.notificationsMuted || undefined} title={item.unread.ariaLabel}><span className="chat-list-unread-text">{item.unread.text}</span></span>}
        {item.mentioned && <span className="chat-list-unread chat-list-mention" title={item.mentionLabel}>@</span>}
      </div>
    </li>
  );
}
