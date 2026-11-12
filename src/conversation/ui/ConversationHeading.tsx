import { useMemo, useState } from 'react';
import { HeaderSearchToggle } from '../../app/HeaderSearch';
import type { ReactNode, Ref } from 'react';
import { useTranslation } from 'react-i18next';
import type { AvatarResource } from '../../chats/chat-list-types';
import type { ConversationHeader, ConversationHeaderPreview } from '../conversation-types';
import { ChatAvatar } from '../../chats/ui/ChatAvatar';
import { MutedChatIcon } from '../../chats/ui/MutedChatIcon';
import { BackButton } from '../../app/BackButton';

interface ConversationHeadingProps {
  readonly data: ConversationHeaderPreview;
  readonly initialAvatar?: AvatarResource;
  readonly titleId: string;
  readonly notificationsMuted: boolean;
  readonly details?: ConversationHeader;
  readonly searchButtonRef: Ref<HTMLButtonElement>;
  readonly searchEnabled: boolean;
  readonly searchPanelId: string;
  readonly searchField?: ReactNode;
  readonly onToggleSearch: () => void;
  readonly onBack: () => void;
  readonly infoButtonRef: Ref<HTMLButtonElement>;
  readonly infoEnabled: boolean;
  readonly onOpenInfo: () => void;
}
export function ConversationHeading({ data, initialAvatar, titleId, notificationsMuted, details, onBack,
  searchButtonRef, searchEnabled, searchPanelId, searchField, onToggleSearch, infoButtonRef, infoEnabled, onOpenInfo }: ConversationHeadingProps) {
  const { t, i18n } = useTranslation('chat');
  // Keep the last known avatar while the next one is validated or decoded.
  // An explicit missing or unavailable state switches immediately to the name initial.
  const [resolvedAvatar, setResolvedAvatar] = useState(initialAvatar ?? data.avatar);
  if (data.avatar.state !== 'pending' && resolvedAvatar !== data.avatar) setResolvedAvatar(data.avatar);
  const avatar = data.avatar.state === 'pending' ? resolvedAvatar : data.avatar;
  const title = data.title.state === 'known' ? data.title.text : t($ => $.header[data.kind]);
  const numbers = useMemo(() => new Intl.NumberFormat(i18n.language), [i18n.language]);
  let subtitle = t($ => $.header[data.kind]);
  const participantCount = details?.kind === 'group' ? details.participantCount : data.participantCount;
  const isChannel = data.kind === 'group' && (details?.kind === 'group' ? details.isChannel === true : data.isChannel === true);
  if (isChannel) subtitle = t($ => $.header.channel);
  if (isChannel && participantCount?.state === 'known') {
    subtitle = t($ => $.header.subscribers, { count: participantCount.value, value: numbers.format(participantCount.value) });
  } else if (data.kind === 'group' && participantCount?.state === 'known') {
    const count = participantCount.value;
    subtitle = details?.kind === 'group' && details.onlineCount.state === 'known'
      ? t($ => $.header.membersOnline, { count, value: numbers.format(count), online: numbers.format(details.onlineCount.value) })
      : t($ => $.header.members, { count, value: numbers.format(count) });
  } else if (details?.kind === 'personal') {
    subtitle = details.presence.state === 'online' ? t($ => $.header.online)
      : details.presence.state === 'offline' ? t($ => $.header.offline) : subtitle;
    if (details.presence.state === 'offline' && details.presence.lastSeenAt) subtitle = t($ => $.header.lastSeen,
      { dateTime: new Intl.DateTimeFormat(i18n.language, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(details.presence.lastSeenAt)) });
  }
  const searchOpen = searchField !== undefined;
  const infoLabel = t($ => $.header.openInfo, { name: title }) +
    (notificationsMuted ? '. ' + t($ => $.header.notificationsMuted) : '');
  return <header className="conversation-header">
    {searchOpen ? <>
      <h1 id={titleId} className="conversation-visually-hidden">{title}</h1>
      {searchField}
    </> : <>
      <BackButton className="conversation-control" onBack={onBack} />
      <button type="button" className="conversation-heading-glass" ref={infoButtonRef}
        disabled={!infoEnabled} onClick={onOpenInfo} aria-label={infoLabel}>
        <span className="conversation-header-avatar"><ChatAvatar avatar={avatar} name={title} /></span>
        <div className="conversation-heading-copy">
          <h1 id={titleId}><span>{title}</span>{notificationsMuted && <MutedChatIcon />}</h1>
          <span>{subtitle}</span>
        </div>
      </button>
    </>}
    <HeaderSearchToggle buttonRef={searchButtonRef} open={searchOpen} disabled={!searchEnabled}
      label={searchOpen ? t($ => $.searchPanel.close) : t($ => $.search)}
      panelId={searchPanelId} onToggle={onToggleSearch} />
  </header>;
}
