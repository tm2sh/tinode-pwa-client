import type { ChatInfoNavigation } from '../../chat-info/chat-info-types';
import type { ChatListView } from '../../chats/chat-list-presenter';
import { AppIcon } from '../../app/AppIcon';
import { ScreenBoundary } from '../../app/ScreenBoundary';
import { ProtectedScreenFailure, ProtectedScreenLoading } from '../../app/ProtectedScreenLoading';
import { lazy, Suspense, useCallback, useState, useEffect, useId, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConversationController } from '../ConversationController';
import { createConversationPresenter } from '../conversation-presenter';
import { conversationDeleteOptions } from '../conversation-deletion';
import type { ConversationDeleteScope, ConversationDeleteResult, ConversationHeader, ConversationHeaderPreview, PhotoAttachment } from '../conversation-types';
import { AppStatus } from '../../app/AppStatus';
import { ConversationHeading } from './ConversationHeading';
import { MessageList } from './MessageList';
import { Composer } from './Composer';
import { PhotoDialog } from './PhotoDialog';
import { MessageActionMenu } from './MessageActionMenu';
import type { MessageCopyKind } from './MessageActionMenu';
import { ChatSearch } from './ChatSearch';
import { useConversationViewport } from './useConversationViewport';
import { useConversationDay } from './useConversationDay';
import type { MessageActionTarget } from './useMessageActionTrigger';
import '../../styles/conversation.css';

type CopyNotice = 'textCopied' | 'linkCopied' | 'copyFailed';
const deleteNoticeCodes = {
  pending: 'deleting', selfConfirmed: 'deletedSelf', allUnconfirmed: 'deleted', rejected: 'deleteFailed', unknown: 'deleteUnknown',
} as const;

function JumpArrow({ up = false }: { readonly up?: boolean }) {
  return <AppIcon name={up ? 'up' : 'down'} />;
}

export interface ChatScreenProps { readonly controller: ConversationController; readonly onBack: () => void; readonly onReconnect?: () => Promise<void>; readonly initialHeader?: ConversationHeaderPreview; readonly notificationsMuted?: boolean; readonly chatList?: Pick<ChatListView, 'items' | 'phase'> }
export function ChatScreen({ controller, onBack, onReconnect, initialHeader, notificationsMuted = false, chatList }: ChatScreenProps) {
  const { t, i18n } = useTranslation('chat'), { t: commonT } = useTranslation('common'), { t: errorT } = useTranslation('errors');
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [selectedAction, setSelectedAction] = useState<(MessageActionTarget & { readonly owner: ConversationController })>();
  const closeMessageAction = useCallback(() => setSelectedAction(undefined), []);
  const [copyNotice, setCopyNotice] = useState<{ readonly owner: ConversationController;
    readonly id: number; readonly code: CopyNotice }>();
  const copySequence = useRef(0);
  const deleteWork = useRef<{ readonly owner: ConversationController } | undefined>(undefined);
  const [deleteNotice, setDeleteNotice] = useState<{ readonly owner: ConversationController;
    readonly seq: number; readonly state: 'pending' | ConversationDeleteResult }>();
  useEffect(() => {
    if (!deleteNotice || deleteNotice.state === 'pending' || deleteNotice.state === 'unknown') return;
    const timer = setTimeout(() => setDeleteNotice(undefined), deleteNotice.state === 'allUnconfirmed' ? 5700 : 3500);
    return () => clearTimeout(timer);
  }, [deleteNotice]);
  const runDelete = useCallback((seq: number, scope?: ConversationDeleteScope) => {
    if (deleteWork.current?.owner === controller) return;
    const work = { owner: controller };
    deleteWork.current = work;
    closeMessageAction();
    setCopyNotice(undefined);
    setDeleteNotice({ owner: controller, seq, state: 'pending' });
    const result = scope === undefined ? controller.checkMessageDeletion(seq) : controller.deleteMessage(seq, scope);
    void result.then(state => {
      if (deleteWork.current !== work) return;
      deleteWork.current = undefined;
      setDeleteNotice(state === undefined ? undefined : { owner: controller, seq, state });
    });
  }, [controller, closeMessageAction]);
  useLayoutEffect(() => () => {
    copySequence.current++;
    if (deleteWork.current?.owner === controller) deleteWork.current = undefined;
  }, [controller]);
  useEffect(() => {
    if (!copyNotice) return;
    const timer = setTimeout(() => setCopyNotice(undefined), 2700);
    return () => clearTimeout(timer);
  }, [copyNotice]);
  const copyMessage = useCallback((kind: MessageCopyKind, value: string) => {
    const id = ++copySequence.current;
    const finish = (code: CopyNotice) => {
      if (id === copySequence.current && controller.getSnapshot().phase === 'ready') {
        setCopyNotice({ owner: controller, id, code });
      }
    };
    try {
      // Invoke before moving focus or awaiting anything, while the click can authorize a write.
      void navigator.clipboard.writeText(value).then(() => finish(kind === 'text' ? 'textCopied' : 'linkCopied'),
        () => finish('copyFailed'));
    } catch {
      finish('copyFailed');
    }
    closeMessageAction();
  }, [controller, closeMessageAction]);
  const requestMessageAction = useCallback((target: MessageActionTarget): boolean => {
    const current = controller.getSnapshot();
    if (current.phase !== 'ready' || current.permissions.canRead.state !== 'allowed') return false;
    const message = current.messages.find(row => row.serverSeq === target.seq && row.delivery === 'serverConfirmed');
    if (!message || (!message.content.text.text.trim() &&
      !conversationDeleteOptions(message, current.identity, current.permissions, current.maxDeleteAgeSeconds).self)) return false;
    controller.setViewportActive(false);
    setCopyNotice(undefined);
    setSelectedAction(previous => previous?.owner === controller && previous.seq === target.seq && previous.anchor === target.anchor
      ? previous : { ...target, owner: controller });
    return true;
  }, [controller]);
  const [info, setInfo] = useState<{ readonly owner: ConversationController; readonly navigation: ChatInfoNavigation }>();
  const [infoAttempt, setInfoAttempt] = useState(0);
  const InfoRoute = useMemo(() => lazy(() => import('../../chat-info/ui/ChatInfoRoute')
    .then(module => ({ default: module.ChatInfoRoute }))), [infoAttempt]);
  const infoOpen = info?.owner === controller && snapshot.phase === 'ready' && snapshot.permissions.canRead.state === 'allowed';
  const infoButton = useRef<HTMLButtonElement>(null), wasInfoOpen = useRef(false);
  const closeInfo = useCallback(() => setInfo(undefined), []);
  useLayoutEffect(() => {
    if (!infoOpen && wasInfoOpen.current) infoButton.current?.focus({ preventScroll: true });
    wasInfoOpen.current = infoOpen;
  }, [infoOpen]);
  useEffect(() => { if (info && !infoOpen) setInfo(undefined); }, [info, infoOpen]);
  const openInfo = () => {
    if (infoOpen) return;
    const navigation = controller.createInfoNavigation();
    if (!navigation) return;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    setSelectedPhoto(undefined); setInfoAttempt(0); setInfo({ owner: controller, navigation });
  };
  const [selectedPhoto, setSelectedPhoto] = useState<{ readonly photo: PhotoAttachment;
    readonly trigger: HTMLButtonElement; readonly owner: ConversationController }>();
  const closePhoto = useCallback(() => setSelectedPhoto(undefined), []);
  const openPhoto = (photo: PhotoAttachment, trigger: HTMLButtonElement) => {
    controller.setViewportActive(false);
    setSelectedPhoto({ photo, trigger, owner: controller });
  };
  const selectedResourceId = selectedPhoto?.photo.media.state === 'available' ? selectedPhoto.photo.media.resourceId : undefined;
  const photoVisible = selectedPhoto?.owner === controller && snapshot.phase === 'ready' &&
    selectedResourceId !== undefined && snapshot.messages.some(message => message.content.attachments.some(part =>
      part.kind === 'photo' && part.media.state === 'available' && part.media.resourceId === selectedResourceId));
  useEffect(() => { if (selectedPhoto && !photoVisible) closePhoto(); }, [selectedPhoto, photoVisible, closePhoto]);
  const actionMessage = selectedAction?.owner === controller && !infoOpen && !photoVisible && snapshot.phase === 'ready' &&
    snapshot.permissions.canRead.state === 'allowed'
    ? snapshot.messages.find(message => message.serverSeq === selectedAction.seq) : undefined;
  const actionTarget = actionMessage ? selectedAction : undefined;
  const editPhase = snapshot.phase === 'ready' ? snapshot.composer.editOperation?.phase : undefined;
  const editLocked = editPhase === 'preparing' || editPhase === 'publishing' || editPhase === 'unknown';
  useEffect(() => {
    if (selectedAction && (!actionTarget || !selectedAction.anchor.isConnected)) setSelectedAction(undefined);
  }, [selectedAction, actionTarget, snapshot]);
  const language = i18n.language === 'ru' ? 'ru' : 'en';
  const presenter = useMemo(() => createConversationPresenter({ language }), [language]);
  const dayReference = useConversationDay();
  const view = useMemo(() => presenter.snapshot(snapshot, dayReference), [presenter, snapshot, dayReference]);
  const titleId = useId(), searchPanelId = useId();
  const reconnect = !!onReconnect && (snapshot.phase === 'error' || snapshot.phase === 'suspended') &&
    (snapshot.error.messageCode === 'conversationAttachUnconfirmed' || snapshot.error.kind === 'sessionClosed');
  const root = useRef<HTMLElement>(null), top = useRef<HTMLDivElement>(null), footer = useRef<HTMLElement>(null);
  const searchButton = useRef<HTMLButtonElement>(null), searchInput = useRef<HTMLInputElement>(null);
  const search = view.search;
  const searchOpen = search.state !== 'closed';
  const closeSearch = () => {
    controller.closeSearch();
    searchButton.current?.focus({ preventScroll: true });
  };
  const header: ConversationHeader | undefined = snapshot.phase === 'ready' ? snapshot.header : undefined;
  const heading: ConversationHeaderPreview = header ?? ((snapshot.phase === 'idle' || snapshot.phase === 'opening') && initialHeader?.kind === snapshot.identity.kind ? initialHeader : {
    kind: snapshot.identity.kind, title: { state: 'unknown' }, avatar: { state: 'missing' },
  });
  const latestError = snapshot.phase === 'ready' && snapshot.newer.state === 'failed' && snapshot.newer.target === 'read' ? snapshot.newer.error : undefined;
  const title = heading.title.state === 'known' ? heading.title.text
    : snapshot.identity.kind === 'group' ? t($ => $.fallback.group) : t($ => $.fallback.personal);
  const numbers = useMemo(() => new Intl.NumberFormat(language), [language]);
  useEffect(() => { const release = controller.attach(); void controller.start(); return release; }, [controller]);
  useConversationViewport(root, top, footer, !infoOpen);
  return <><section ref={root} className="conversation-screen" aria-labelledby={titleId}
    data-info-open={infoOpen ? 'true' : undefined}
    inert={infoOpen} aria-hidden={infoOpen || undefined} onKeyDown={event => {
    if (!actionTarget && !photoVisible && searchOpen && event.key === 'Escape' && !event.defaultPrevented &&
      !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
      event.preventDefault();
      closeSearch();
    }
  }}>
    <div ref={top} className="conversation-top">
      <ConversationHeading data={heading} initialAvatar={initialHeader?.avatar} details={header} titleId={titleId}
        notificationsMuted={notificationsMuted}
        onBack={onBack} infoButtonRef={infoButton} onOpenInfo={openInfo}
        infoEnabled={snapshot.phase === 'ready' && snapshot.permissions.canRead.state === 'allowed'} searchButtonRef={searchButton} searchEnabled={snapshot.phase === 'ready'}
        searchPanelId={searchPanelId} onToggleSearch={searchOpen ? closeSearch : controller.openSearch}
        searchField={search.state !== 'closed' ? <ChatSearch id={searchPanelId} input={searchInput} search={search}
          onQuery={controller.setSearchQuery} onMove={controller.moveSearchMatch} /> : undefined} />
    </div>
    {snapshot.phase === 'ready' ? <MessageList onReconnect={onReconnect} controller={controller} snapshot={snapshot} view={view} items={view.items} title={title} onOpenPhoto={openPhoto} onMessageAction={requestMessageAction} obscured={photoVisible || infoOpen || !!actionTarget} />
      : <div className="conversation-state">
        {view.initial.pending ? <AppStatus loading message={t($ => $.state.loading)} /> : <div className="conversation-notice" role={view.initial.error ? 'alert' : 'status'}>
          <p>{snapshot.phase === 'error' ? t($ => $.state.failed) : snapshot.phase === 'suspended' ? t($ => $.state.suspended) : t($ => $.state.closed)}</p>
          {view.initial.error && <p>{errorT($ => $[view.initial.error!.messageCode], view.initial.error.messageParams)}</p>}
          {reconnect && <button type="button" className="glass-control conversation-history-button" onClick={() => { void onReconnect?.(); }}>{t($ => $.state.reconnect)}</button>}
          {!reconnect && view.initial.retryable && <button type="button" className="glass-control conversation-history-button" onClick={() => { void controller.retry(); }}>{commonT($ => $.retry)}</button>}
        </div>}
      </div>}
    {searchOpen && search.count > 1 && <div className="conversation-search-nav" onPointerDown={event => {
      if (event.button === 0 && document.activeElement === searchInput.current) event.preventDefault();
    }}>
      <button type="button" className="glass-control conversation-control" aria-label={t($ => $.searchPanel.previous)}
        onClick={() => controller.moveSearchMatch('previous')}><JumpArrow up /></button>
      <button type="button" className="glass-control conversation-control" aria-label={t($ => $.searchPanel.next)}
        onClick={() => controller.moveSearchMatch('next')}><JumpArrow /></button>
    </div>}
    {!searchOpen && snapshot.phase === 'ready' && !snapshot.position.atLatest && !view.empty && <div className="conversation-latest">
      {latestError && <p className="conversation-latest-error" role="alert">
        {errorT($ => $[latestError!.messageCode], latestError.messageParams)}</p>}
      <button type="button" className="glass-control conversation-control conversation-latest-button" disabled={snapshot.composer.verification?.state === 'checking' || snapshot.older.state === 'pending' || snapshot.newer.state === 'pending' ||
        (snapshot.newer.state === 'failed' && snapshot.newer.target === 'read' && !snapshot.newer.error.retryable)}
        aria-busy={snapshot.newer.state === 'pending' && snapshot.newer.target === 'read'}
        aria-label={snapshot.newer.state === 'pending' && snapshot.newer.target === 'read' ? t($ => $.latest.loading)
          : latestError ? t($ => $.latest.retry) : snapshot.position.newMessageCount
            ? t($ => $.latest.newMessages, { count: snapshot.position.newMessageCount, value: numbers.format(snapshot.position.newMessageCount) }) : t($ => $.latest.go)}
        onClick={() => { void controller.goToReadPosition(); }}>
        {snapshot.newer.state === 'pending' && snapshot.newer.target === 'read' ? <AppIcon name="spinner" className="auth-spinner" />
          : <JumpArrow />}
        {snapshot.position.newMessageCount > 0 && <span className="conversation-latest-count" aria-hidden="true">
          {snapshot.position.newMessageCount > 99 ? t($ => $.latest.counterMore, { value: numbers.format(99) }) : numbers.format(snapshot.position.newMessageCount)}
        </span>}
      </button>
    </div>}
    <footer ref={footer} className="conversation-footer">
      <Composer controller={controller} onReconnect={onReconnect} active={!infoOpen} state={snapshot.phase === 'ready' ? snapshot.composer : undefined}
        writable={snapshot.phase === 'ready' && snapshot.permissions.canWrite.state === 'allowed' && snapshot.permissions.canRead.state === 'allowed'} />
    </footer>
    {actionTarget && actionMessage && snapshot.phase === 'ready' &&
      <MessageActionMenu key={actionTarget.seq} target={actionTarget} message={actionMessage}
        writable={snapshot.permissions.canWrite.state === 'allowed' && !editLocked}
        deletion={conversationDeleteOptions(actionMessage, snapshot.identity, snapshot.permissions, snapshot.maxDeleteAgeSeconds)}
        verifyDeleteForAll={controller.verifyDeleteForAll}
        deleteBusy={deleteNotice?.owner === controller && deleteNotice.state === 'pending'}
        onDelete={scope => runDelete(actionTarget.seq, scope)} onClose={closeMessageAction} onCopy={copyMessage} onEdit={() => {
          if (controller.beginMessageEdit(actionTarget.seq)) closeMessageAction();
        }} />}
    {deleteNotice?.owner === controller && snapshot.phase === 'ready' && !actionTarget && !infoOpen && !photoVisible &&
      <div className="conversation-action-notice">
        <span role={deleteNotice.state === 'rejected' || deleteNotice.state === 'unknown' ? 'alert' : 'status'}>
          {t($ => $.messageActions[deleteNoticeCodes[deleteNotice.state]])}
        </span>
        {deleteNotice.state === 'unknown' && <button type="button" className="conversation-delete-check"
          onClick={() => runDelete(deleteNotice.seq)}>{t($ => $.messageActions.checkDeletion)}</button>}
      </div>}
    {deleteNotice?.owner !== controller && copyNotice?.owner === controller && snapshot.phase === 'ready' && !actionTarget && !infoOpen && !photoVisible &&
      <p key={copyNotice.id} className="conversation-action-notice" role={copyNotice.code === 'copyFailed' ? 'alert' : 'status'}>
        {t($ => $.messageActions[copyNotice.code])}
      </p>}
    {photoVisible && <PhotoDialog key={selectedPhoto.photo.media.state === 'available' ? selectedPhoto.photo.media.resourceId : ''}
      controller={controller} photo={selectedPhoto.photo} returnFocus={selectedPhoto.trigger} onClose={closePhoto} />}
  </section>
  {infoOpen && info && <ScreenBoundary resetKey={String(info.navigation.identity.panelGeneration) + ':' + infoAttempt}
    fallback={<ProtectedScreenFailure onBack={closeInfo} onRetry={() => setInfoAttempt(value => value + 1)} />}>
    <Suspense fallback={<ProtectedScreenLoading onBack={closeInfo} />}>
      <InfoRoute {...info.navigation} onBack={closeInfo} chatList={chatList} />
    </Suspense>
  </ScreenBoundary>}
  </>;
}
