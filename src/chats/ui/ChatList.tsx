import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChatDepartureAction, ChatDepartureErrorCode, ChatMuteErrorCode } from '../chat-list-types';
import type { ChatListController } from '../ChatListController';
import type { ChatListView } from '../chat-list-presenter';
import { ChatListItem } from './ChatListItem';
import { ChatListActionMenu } from './ChatListActionMenu';
import { useContextMenuTrigger } from '../../app/context-menu/useContextMenuTrigger';
import { AppStatus } from '../../app/AppStatus';
import '../../styles/chat-list.css';

interface ChatListProps {
  readonly controller: ChatListController;
  readonly view: ChatListView;
  readonly scrollRef: RefObject<HTMLElement | null>;
  readonly headerRef: RefObject<HTMLElement | null>;
  readonly active: boolean;
  readonly onOpenChat?: (topicKey: string) => void;
}

export function ChatList({ controller, view, scrollRef, headerRef, active, onOpenChat }: ChatListProps) {
  const { t: errorT } = useTranslation('errors');
  const rows = useRef(new Map<string, HTMLLIElement>());
  const pendingAction = useRef<string | undefined>(undefined);
  const [feedback, setFeedback] = useState<{
    readonly topicKey: string;
    readonly command: 'mute' | ChatDepartureAction;
    readonly error?: ChatMuteErrorCode | ChatDepartureErrorCode;
    readonly denied?: boolean;
  }>();
  const runAction = async (topicKey: string, command: boolean | ChatDepartureAction) => {
    if (pendingAction.current) return;
    pendingAction.current = topicKey;
    const notification = typeof command === 'boolean';
    const action = { topicKey, command: notification ? 'mute' as const : command };
    setFeedback(action);
    try {
      if (notification) {
        const result = await controller.setMuted(topicKey, command);
        setFeedback(result.state === 'confirmed' ? undefined : {
          ...action, error: result.error.messageCode, denied: !result.error.retryable,
        });
      } else {
        const result = await controller.departChat(topicKey, command);
        setFeedback(result.state === 'confirmed' ? undefined : { ...action, error: result.messageCode });
      }
    } catch {
      setFeedback({ ...action, error: notification ? 'chatInfoMuteUnavailable' : 'chatDepartureUnavailable' });
    } finally { pendingAction.current = undefined; }
  };
  const [actionTarget, setActionTarget] = useState<{
    readonly topicKey: string;
    readonly anchor: HTMLElement;
    readonly focusTarget: HTMLButtonElement;
  }>();
  const closeAction = useCallback(() => setActionTarget(undefined), []);
  const actionItem = active && actionTarget ? view.items.find(item => item.topicKey === actionTarget.topicKey) : undefined;
  const trigger = useContextMenuTrigger(active && !!onOpenChat && !actionTarget, '[data-chat-action-topic]', anchor => {
    const topicKey = anchor.dataset.chatActionTopic;
    const focusTarget = anchor.querySelector<HTMLButtonElement>('.chat-list-open');
    if (!topicKey || rows.current.get(topicKey) !== anchor || !focusTarget) return false;
    setFeedback(previous => previous?.topicKey === topicKey && previous.error ? undefined : previous);
    setActionTarget({ topicKey, anchor, focusTarget });
    return true;
  }, '.chat-list-open');
  const cancelPress = trigger.onScroll;
  useLayoutEffect(() => {
    if (actionTarget && (!actionItem || !onOpenChat)) closeAction();
  }, [actionItem, actionTarget, onOpenChat, closeAction]);
  const onRef = useCallback((key: string, element: HTMLLIElement | null) => {
    if (element) rows.current.set(key, element); else rows.current.delete(key);
  }, []);
  const prioritize = useCallback(() => {
    const scroller = scrollRef.current;
    if (!active || !scroller || scroller.clientHeight === 0) return;
    const viewport = scroller.getBoundingClientRect();
    const visibleTop = headerRef.current?.getBoundingClientRect().bottom ?? viewport.top;
    const visible = [...rows.current].filter(([, element]) => {
      const bounds = element.getBoundingClientRect();
      return bounds.bottom > visibleTop && bounds.top < viewport.bottom;
    }).sort(([, a], [, b]) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
      .map(([key]) => key);
    controller.prioritizePreviews(visible);
  }, [active, controller, headerRef, scrollRef]);

  useLayoutEffect(() => { prioritize(); }, [prioritize, view.items]);
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!active || !scroller) return;
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(prioritize);
    };
    scroller.addEventListener('scroll', schedule, { passive: true });
    scroller.addEventListener('scroll', cancelPress, { passive: true });
    window.addEventListener('resize', schedule);
    const observer = new ResizeObserver(schedule);
    observer.observe(scroller);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      scroller.removeEventListener('scroll', schedule);
      scroller.removeEventListener('scroll', cancelPress);
      window.removeEventListener('resize', schedule);
    };
  }, [active, cancelPress, prioritize, scrollRef]);

  return (
    <div className="chat-list-content" {...trigger}>
      {view.statusText && (view.phase === 'idle' || view.phase === 'loading'
        ? <div className="chat-list-loading"><AppStatus loading message={view.statusText} /></div>
        : <div className={'chat-list-status' + (view.statusRole === 'alert' ? ' chat-list-status-error' : '')}
          role={view.statusRole} aria-atomic="true">
          <p>{view.statusText}</p>
          {view.errorText && <p className="chat-list-status-detail">{view.errorText}</p>}
        </div>)}
      {feedback?.error && actionItem?.topicKey !== feedback.topicKey &&
        <p className="chat-list-action-error" role="alert">{errorT($ => $[feedback.error!])}</p>}
      {view.searchEmptyText && <p className="chat-list-search-empty" role="status">{view.searchEmptyText}</p>}
      {view.phase === 'ready' && view.profile.warning && <div className="chat-list-status chat-list-profile-warning"
        role="alert" aria-atomic="true"><p>{view.profile.warning}</p></div>}
      {view.empty && view.refresh.state !== 'idle' && <div className="chat-list-status"
        role={view.refresh.state === 'failed' ? 'status' : undefined}><p>{view.emptyText}</p></div>}
      {view.phase === 'ready' && view.items.length > 0 && <ul className="chat-list" aria-label={view.ariaLabel} aria-busy={view.refresh.state === 'pending'}>
        {view.items.map((item) => <ChatListItem key={item.topicKey} item={item} onRef={onRef} onOpen={onOpenChat} />)}
      </ul>}
      {actionTarget && actionItem && <ChatListActionMenu key={actionTarget.topicKey} controller={controller}
        item={actionItem} anchor={actionTarget.anchor} focusTarget={actionTarget.focusTarget}
        scrollContainer={scrollRef.current} header={headerRef.current} onClose={closeAction}
        onSetMuted={muted => { void runAction(actionItem.topicKey, muted); }}
        onDepart={command => { void runAction(actionItem.topicKey, command); }}
        pendingCommand={feedback?.topicKey === actionItem.topicKey && !feedback.error ? feedback.command : undefined}
        actionBusy={!!feedback && !feedback.error}
        muteDenied={feedback?.topicKey === actionItem.topicKey && feedback.denied === true}
        error={feedback?.topicKey === actionItem.topicKey ? feedback.error : undefined} />}
    </div>
  );
}
