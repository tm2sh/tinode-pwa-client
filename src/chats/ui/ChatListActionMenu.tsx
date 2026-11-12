import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AnchoredActionMenu } from '../../app/context-menu/AnchoredActionMenu';
import { AppIcon } from '../../app/AppIcon';
import type { ChatListController } from '../ChatListController';
import type { ChatListItemView } from '../chat-list-presenter';
import type {
  ChatActionDetails, ChatDeletionAction, ChatDepartureAction, ChatDepartureErrorCode, ChatMuteErrorCode,
} from '../chat-list-types';

interface ChatListActionMenuProps {
  readonly controller: ChatListController;
  readonly item: ChatListItemView;
  readonly anchor: HTMLElement;
  readonly focusTarget: HTMLButtonElement;
  readonly scrollContainer: HTMLElement | null;
  readonly header: HTMLElement | null;
  readonly onClose: () => void;
  readonly onSetMuted: (muted: boolean) => void;
  readonly onDepart: (command: ChatDepartureAction) => void;
  readonly pendingCommand?: 'mute' | ChatDepartureAction;
  readonly actionBusy: boolean;
  readonly muteDenied: boolean;
  readonly error?: ChatMuteErrorCode | ChatDepartureErrorCode;
}

function needsDetails(details?: ChatActionDetails): boolean {
  return !details || details.kind === 'unknown' || details.role === 'unknown' || details.notificationsMuted === undefined;
}

export function ChatListActionMenu({ controller, item, anchor, focusTarget, scrollContainer, header, onClose,
  onSetMuted, onDepart, pendingCommand, actionBusy, muteDenied, error }: ChatListActionMenuProps) {
  const { t } = useTranslation('chats');
  const { t: errorT } = useTranslation('errors');
  const { topicKey } = item;
  const seed = controller.actionDetails(topicKey);
  const incomplete = needsDetails(seed);
  const seedKey = [seed?.kind, seed?.role, seed?.notificationsMuted].join(':');
  const [lookup, setLookup] = useState<{ readonly seedKey: string; readonly details?: ChatActionDetails }>();

  useEffect(() => {
    if (!incomplete) return;
    const request = new AbortController();
    const finish = (details?: ChatActionDetails) => {
      if (!request.signal.aborted) setLookup({ seedKey, details });
    };
    void controller.readActionDetails(topicKey, request.signal).then(finish, () => finish());
    return () => request.abort();
  }, [controller, topicKey, incomplete, seedKey]);

  const result = incomplete && lookup?.seedKey === seedKey ? lookup : undefined;
  const details = result?.details ?? seed;
  const checking = incomplete && !result;
  const [confirmation, setConfirmation] = useState<ChatDeletionAction>();
  const warningId = useId();
  const departure = details?.kind === 'personal' ? 'delete'
    : details && details.kind !== 'unknown' && details.role !== 'unknown'
      ? details.role === 'owner' ? 'delete' : details.kind === 'channel' ? 'unsubscribe' : 'leave'
      : undefined;
  const departureCommand = details?.kind === 'personal' ? 'deletePersonal'
    : departure === 'leave' ? 'leaveGroup' : departure === 'unsubscribe' ? 'unsubscribeChannel'
    : departure === 'delete' && details?.role === 'owner'
      ? details.kind === 'group' ? 'deleteGroupForAll' : 'deleteChannelForAll'
      : undefined;
  const muted = details?.notificationsMuted;
  const mutePending = pendingCommand === 'mute';
  const departurePending = departureCommand !== undefined && pendingCommand === departureCommand;
  const deleteForAll = departureCommand === 'deleteGroupForAll' || departureCommand === 'deleteChannelForAll';
  const ownershipChanged = confirmation && !checking && departureCommand !== confirmation;
  const message = error ?? (ownershipChanged ? 'chatDeleteForAllUnavailable' : undefined);
  const status = message && <p className="chat-list-action-status chat-list-action-error" role="alert">{errorT($ => $[message])}</p>;

  return <AnchoredActionMenu anchor={anchor} focusTarget={focusTarget} label={t($ => $.actions.label, { title: item.title })}
    scrollContainer={scrollContainer} topBoundary={header} onClose={onClose}
    focusKey={confirmation ?? String(muted)} highlightKey={item.notificationsMuted ? 1 : 0}>
    {confirmation ? <>
      <p id={warningId} className="chat-list-action-status">{confirmation === 'deleteGroupForAll'
        ? t($ => $.actions.confirmGroupDeletion) : t($ => $.actions.confirmChannelDeletion)}</p>
      <button type="button" className="anchored-action-danger"
        aria-describedby={warningId} disabled={actionBusy || departureCommand !== confirmation}
        aria-busy={pendingCommand === confirmation || undefined} onClick={() => onDepart(confirmation)}>
        {t($ => $.actions.deleteForAll)}
        {pendingCommand === confirmation ? <AppIcon name="spinner" className="auth-spinner" /> : <AppIcon name="trash" />}
      </button>
      {status}
    </> : <>
      {muted !== undefined && <button type="button" disabled={actionBusy || muteDenied}
        aria-busy={mutePending || undefined} onClick={() => onSetMuted(!muted)}>
        {muted ? t($ => $.actions.enableNotifications) : t($ => $.actions.disableNotifications)}
        {mutePending ? <AppIcon name="spinner" className="auth-spinner" /> : <AppIcon name={muted ? 'bell' : 'muted'} />}
      </button>}
      {departure && <button type="button" className="anchored-action-danger" disabled={actionBusy || !departureCommand}
        aria-busy={departurePending || undefined} onClick={() => {
          if (deleteForAll) setConfirmation(departureCommand);
          else if (departureCommand) onDepart(departureCommand);
        }}>
        {t($ => $.actions[departure])}
        {departurePending ? <AppIcon name="spinner" className="auth-spinner" />
          : <AppIcon name={departure === 'delete' ? 'trash' : 'logout'} />}
      </button>}
      {status}
      {needsDetails(details) && <p className="chat-list-action-status" role="status">
        {checking ? t($ => $.actions.checking) : t($ => $.actions.unavailable)}
      </p>}
    </>}
  </AnchoredActionMenu>;
}
