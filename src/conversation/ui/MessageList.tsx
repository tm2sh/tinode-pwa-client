import { useLayoutEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConversationController } from '../ConversationController';
import type { ConversationMessageView, ConversationView } from '../conversation-presenter';
import type { ConversationHistoryGap, ConversationReadySnapshot } from '../conversation-types';
import { MessageBubble, OutgoingBubble } from './MessageBubble';
import type { OpenPhoto } from './PhotoPreview';
import { useConversationWindow } from './useConversationWindow';
import { useConversationVisibility } from './useConversationVisibility';
import { useMessageActionTrigger } from './useMessageActionTrigger';
import type { MessageActionTarget } from './useMessageActionTrigger';

interface MessageListProps {
  readonly controller: ConversationController;
  readonly snapshot: ConversationReadySnapshot;
  readonly view: ConversationView;
  readonly items: readonly ConversationMessageView[];
  readonly title: string;
  readonly onOpenPhoto: OpenPhoto;
  readonly obscured: boolean;
  readonly onMessageAction: (target: MessageActionTarget) => boolean;
  readonly onReconnect?: () => Promise<void>;
}
export function MessageList({ controller, snapshot, view, items, title, onOpenPhoto, obscured, onMessageAction, onReconnect }: MessageListProps) {
  const { t } = useTranslation('chat'), { t: errorT } = useTranslation('errors');
  const scroller = useRef<HTMLDivElement>(null), list = useRef<HTMLOListElement>(null), leading = useRef<HTMLDivElement>(null);
  const messageActionTrigger = useMessageActionTrigger(!obscured && snapshot.permissions.canRead.state === 'allowed', onMessageAction);
  const operations = new Map(snapshot.outgoing.filter(row => row.operation.kind !== 'edit').map(row => [row.operation.operationId, row.operation]));
  const echoed = (row: ConversationReadySnapshot['outgoing'][number]) => snapshot.messages.some(message =>
    message.sender.state === 'self' && message.sender.uid === snapshot.identity.account.uid && message.originalSeq === undefined &&
    message.timestamp.state === 'known' && message.operationId === row.operation.operationId && message.serverSeq > (row.operation.afterSeq ?? 0));
  const local = snapshot.outgoing.filter(row => (row.text !== undefined || row.photo !== undefined || row.voice !== undefined) && row.operation.phase !== 'confirmed' && row.operation.phase !== 'cancelled' && !echoed(row));
  const search = view.search.state === 'matches' ? view.search : undefined;
  const matches = search?.matches;
  const hits = useMemo(() => new Map(matches?.map(match => [match.serverSeq, match.ranges] as const)), [matches]);
  const window = useConversationWindow(items, snapshot.target, scroller, list, leading, snapshot.position.atLatest && !obscured,
    snapshot.position.scrollRequest, controller.reportEndPosition, snapshot.outgoing, controller.reportScrollAnchor,
    search?.activeSeq, search?.query);
  useLayoutEffect(() => {
    const node = scroller.current;
    // Keep errors from manually loading more messages visible below the header.
    if (view.older.error && node && node.scrollTop < (leading.current?.offsetHeight ?? 0) + 40) {
      node.scrollTop = 0; window.captureAnchor();
    }
  }, [view.older.error, window.captureAnchor]);
  const overlayVisible = view.search.state === 'closed' ? !snapshot.position.atLatest && !view.empty : view.search.count > 1;
  useConversationVisibility(controller, scroller, list, items, overlayVisible, snapshot.newer.state, obscured);
  const loadOlder = () => { window.captureAnchor(); void controller.loadOlder(); };
  const busy = snapshot.composer.verification?.state === 'checking' || snapshot.older.state === 'pending' || snapshot.newer.state === 'pending';
  const gapControl = (gap: ConversationHistoryGap) => {
    const state = snapshot.newer, target = gap.query.since!;
    const own = state.state !== 'idle' && state.target === target;
    const problem = state.state === 'failed' && own ? state.error : undefined;
    return <div className="conversation-gap" key={target}>
      {problem && <p className="conversation-history-error" role="alert">{errorT($ => $[problem.messageCode], problem.messageParams)}</p>}
      <button type="button" className="conversation-history-button" disabled={busy || (problem !== undefined && !problem.retryable)}
        onClick={() => { window.captureAnchor(); void controller.loadGap(gap.query); }}>
        {state.state === 'pending' && own ? t($ => $.history.loading) : problem ? t($ => $.history.retry) : t($ => $.history.gap)}
      </button>
    </div>;
  };
  return <div className="conversation-history" ref={scroller} tabIndex={0} aria-label={t($ => $.a11y.messages)} {...messageActionTrigger}>
    <div ref={leading} className="conversation-history-leading">
      {view.older.error && <p className="conversation-history-error" role="alert">{t($ => $.history.failed)}<br />
        {errorT($ => $[view.older.error!.messageCode], view.older.error.messageParams)}</p>}
      {(view.older.enabled || view.older.pending) && <button type="button" className="conversation-history-button" disabled={busy} onClick={loadOlder}>
        {view.older.pending ? t($ => $.history.loading) : view.older.error ? t($ => $.history.retry) : t($ => $.history.older)}
      </button>}
    </div>
    {view.empty && local.length === 0 && <p className="conversation-empty" role="status">{t($ => $.state.empty)}</p>}
    <ol ref={list} className="conversation-messages" aria-label={t($ => $.a11y.messages)} aria-busy={view.older.pending}>
      <li className="conversation-spacer" role="presentation" aria-hidden="true" style={{ height: window.top }} />
      {items.slice(window.start, window.end).map((item, index) => <MessageBubble key={item.key} item={item} onOpenPhoto={onOpenPhoto} loadPreview={controller.acquirePhotoPreview} loadVoice={controller.acquireVoice} voiceSignal={controller.voiceSignal} personal={snapshot.identity.kind === 'personal'}
        peerName={title} outgoing={item.message.operationId ? operations.get(item.message.operationId) : undefined} position={window.start + index + 1} total={items.length} onRef={window.onRowRef}
        readStatus={view.outgoingReadStatus(item.message)} searchHits={hits.get(item.key)} activeSearchMatch={search?.activeSeq === item.key}
        leading={snapshot.gaps.filter(gap => gap.beforeMessageSeq === item.key).map(gapControl)}
        trailing={window.start + index === items.length - 1 ? snapshot.gaps.filter(gap => gap.beforeMessageSeq === undefined).map(gapControl) : undefined} />)}
      <li className="conversation-spacer" role="presentation" aria-hidden="true" style={{ height: window.bottom }} />
      {local.map(row => {
        const verification = snapshot.composer.verification?.operationId === row.operation.operationId ? snapshot.composer.verification : undefined;
        const reconnect = verification?.state === 'failed' && !verification.error.retryable && !!onReconnect;
        const disabled = row.operation.phase === 'unknown' ? !reconnect && !snapshot.composer.canVerify
          : snapshot.composer.pending || snapshot.composer.uncertain || snapshot.permissions.canWrite.state !== 'allowed' || snapshot.permissions.canRead.state !== 'allowed';
        return <OutgoingBubble key={row.operation.operationId} row={row} releasePreview={controller.releaseLocalPhotoPreview}
          loadVoice={controller.acquireVoice} voiceSignal={controller.voiceSignal} verification={verification} reconnect={reconnect} retryDisabled={disabled}
          onRetry={id => {
            if (row.operation.phase === 'unknown') { if (reconnect) void onReconnect?.(); else void controller.reconcileText(); }
            else if (row.operation.kind === 'voice') void controller.retryVoice(id); else void controller.retryText(id);
          }} />;
      })}
    </ol>
  </div>;
}
