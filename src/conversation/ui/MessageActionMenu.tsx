import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AnchoredActionMenu } from '../../app/context-menu/AnchoredActionMenu';
import { AppIcon } from '../../app/AppIcon';
import { conversationLinks } from '../conversation-links';
import { canEditConversationMessage } from '../conversation-edit';
import type { ConversationDeleteOptions } from '../conversation-deletion';
import type { ConversationMessage, ConversationDeleteScope } from '../conversation-types';
import type { MessageActionTarget } from './useMessageActionTrigger';

function decorateMessageHighlight(replica: HTMLElement, anchor: HTMLElement): void {
  replica.removeAttribute('data-message-action-seq');
  replica.style.setProperty('--conversation-author-color', getComputedStyle(anchor).getPropertyValue('--conversation-author-color'));
}

export type MessageCopyKind = 'text' | 'link';

export function MessageActionMenu({ target, message, writable, deletion, verifyDeleteForAll, deleteBusy, onDelete, onClose, onCopy, onEdit }: {
  readonly target: MessageActionTarget;
  readonly message: ConversationMessage;
  readonly writable: boolean;
  readonly deletion: ConversationDeleteOptions;
  readonly verifyDeleteForAll: (seq: number, signal: AbortSignal) => Promise<boolean>;
  readonly onClose: () => void;
  readonly onEdit: () => void;
  readonly deleteBusy: boolean;
  readonly onDelete: (scope: ConversationDeleteScope) => void;
  readonly onCopy: (kind: MessageCopyKind, value: string) => void;
}) {
  const { t } = useTranslation('chat');
  const [mode, setMode] = useState<'actions' | 'delete' | 'links'>('actions');
  const { anchor } = target;
  const own = message.sender.state === 'self';
  const text = message.content.text;
  const hasText = text.text.trim().length > 0;
  const links = useMemo(() => hasText ? conversationLinks(text) : [], [hasText, text]);
  const selectingLink = mode === 'links' && links.length > 0;
  const copyLink = () => {
    if (links.length === 1) onCopy('link', links[0]!);
    else setMode('links');
  };
  const canEdit = writable && canEditConversationMessage(message);
  const [readback, setReadback] = useState<'pending' | 'allowed' | 'denied'>('pending');
  const [, refreshAge] = useState(0);
  const deadline = deletion.allExpiresAt;
  const eligibleForAll = deletion.all && (deadline === undefined || Date.now() < deadline);
  const canDeleteForAll = eligibleForAll && readback !== 'denied';

  useEffect(() => {
    if (deadline === undefined) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expire = () => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) refreshAge(value => value + 1);
      else timer = setTimeout(expire, Math.min(remaining, 2_147_483_647));
    };
    expire();
    return () => clearTimeout(timer);
  }, [deadline]);
  useEffect(() => {
    if (mode !== 'delete' || !eligibleForAll) return;
    const attempt = new AbortController();
    setReadback('pending');
    const resolve = (allowed: boolean) => { if (!attempt.signal.aborted) setReadback(allowed ? 'allowed' : 'denied'); };
    void verifyDeleteForAll(target.seq, attempt.signal).then(resolve, () => resolve(false));
    return () => attempt.abort();
  }, [mode, eligibleForAll, target.seq, verifyDeleteForAll]);
  useLayoutEffect(() => {
    if ((!hasText || mode === 'delete') && !deletion.self && !canDeleteForAll) onClose();
  }, [hasText, mode, deletion.self, canDeleteForAll, onClose]);

  const screen = anchor.closest('.conversation-screen');

  return <AnchoredActionMenu anchor={anchor} alignment={own ? 'end' : 'start'}
    label={selectingLink ? t($ => $.messageActions.chooseLink) : t($ => $.messageActions.label)}
    scrollContainer={anchor.closest<HTMLElement>('.conversation-history')}
    topBoundary={screen?.querySelector<HTMLElement>('.conversation-top')}
    bottomBoundary={screen?.querySelector<HTMLElement>('.conversation-footer')}
    focusKey={[mode, selectingLink, deletion.self, canDeleteForAll].join(':')}
    decorateHighlight={decorateMessageHighlight} onClose={onClose}>
    {selectingLink ? links.map(url => <button key={url} type="button" title={url} onClick={() => onCopy('link', url)}>
      <span className="conversation-action-link-label">{url}</span><AppIcon name="link" />
    </button>) : mode === 'delete' ? <>
      {deletion.self && <button type="button" disabled={deleteBusy} onClick={() => onDelete('self')}>{t($ => $.messageActions.deleteSelf)}<AppIcon name="trash" /></button>}
      {canDeleteForAll && <button type="button" className="anchored-action-danger"
        disabled={deleteBusy || readback !== 'allowed'} onClick={() => onDelete('all')}>
        {t($ => $.messageActions.deleteAll)}<AppIcon name="trash" /></button>}
    </> : <>
      {hasText && <button type="button" onClick={() => onCopy('text', text.text)}>{t($ => $.messageActions.copy)}<AppIcon name="copy" /></button>}
      {links.length > 0 && <button type="button" onClick={copyLink}>{t($ => $.messageActions.copyLink)}<AppIcon name="link" /></button>}
      {canEdit && <button type="button" onClick={onEdit}>{t($ => $.messageActions.edit)}<AppIcon name="edit" /></button>}
      {(deletion.self || canDeleteForAll) && <button type="button" className="anchored-action-danger" onClick={() => setMode('delete')}>
        {t($ => $.messageActions.delete)}<AppIcon name="trash" />
      </button>}
    </>}
  </AnchoredActionMenu>;
}
