import type { GroupCreationInput, GroupCreationKind, GroupCreationPort, GroupCreationProgress, GroupCreationResult, OpenGroupCreationPort } from '../groups/group-creation-types';
import { loadTranslations, useScreenTranslations } from '../i18n';
import { useTranslation } from 'react-i18next';
import { authErrorText } from '../i18n/auth-error';
import { clientConfig } from '../config';
import { lazy, Suspense, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { OpenContactSearchPort } from '../contacts/contact-search-types';
import type { AuthError, OpenConversationPort } from '../auth/auth-types';
import type { ChatListItem, ChatListPort, ChatPreviewPause } from '../chats/chat-list-types';
import type { ContactOpeningState } from './ChatCreationScreen';
import type { OwnProfilePort } from '../profile/own-profile-types';
import type { ConversationContinuation } from '../conversation/ConversationContinuation';
import type { ConversationTopicKey } from '../conversation/conversation-types';
import { ChatListController } from '../chats/ChatListController';
import { createChatListPresenter } from '../chats/chat-list-presenter';
import { ChatListFailure } from '../chats/chat-list-normalize';
import { ChatList } from '../chats/ui/ChatList';
import { ChatAvatar } from '../chats/ui/ChatAvatar';
import { ConversationNavigation } from './ConversationNavigation';
import { ProtectedScreenLoading } from './ProtectedScreenLoading';
import { AppStatus } from './AppStatus';
import { AppIcon } from './AppIcon';
import { HeaderSearchField, HeaderSearchToggle } from './HeaderSearch';
import { ScreenBoundary } from './ScreenBoundary';
import '../styles/authenticated-shell.css';

const ProfilePanel = lazy(() => Promise.all([import('./ProfilePanel'), loadTranslations('profile')])
  .then(([module]) => ({ default: module.ProfilePanel })));
const ConversationRoute = lazy(() => Promise.all([import('../conversation/ui/ConversationRoute'), loadTranslations('chat'), loadTranslations('media')])
  .then(([module]) => ({ default: module.ConversationRoute })));

const ChatCreationScreen = lazy(() => Promise.all([import('./ChatCreationScreen'), loadTranslations('chatCreation')])
  .then(([module]) => ({ default: module.ChatCreationScreen })));

const AddContactScreen = lazy(() => Promise.all([import('./AddContactScreen'), loadTranslations('addContact')])
  .then(([module]) => ({ default: module.AddContactScreen })));

const CreateGroupScreen = lazy(() => Promise.all([import('./CreateGroupScreen'), loadTranslations('createGroup')])
  .then(([module]) => ({ default: module.CreateGroupScreen })));

type Route = { readonly kind: 'list' | 'profile' | 'create' | 'addContact' | 'resuming' }
  | { readonly kind: 'createGroup'; readonly topicKind: GroupCreationKind }
  | { readonly kind: 'chat'; readonly navigation: ConversationNavigation };
const hotControllers = import.meta.hot ? new Set<ChatListController>() : undefined;
const hotRecoveries = import.meta.hot ? new Set<() => Promise<void>>() : undefined;
const hotContinuations = import.meta.hot ? new Set<{ current: ConversationContinuation | undefined }>() : undefined;
if (import.meta.hot && hotControllers) import.meta.hot.dispose(() => {
  for (const holder of hotContinuations ?? []) { holder.current?.clear(); holder.current = undefined; }
  hotContinuations?.clear();
  for (const controller of hotControllers) controller.dispose(); hotControllers.clear();
  for (const recover of hotRecoveries ?? []) void recover();
  hotRecoveries?.clear();
});
interface AuthenticatedShellProps {
  readonly warning?: AuthError;
  readonly onLogout: () => void;
  readonly openChatListPort: () => Promise<ChatListPort>;
  readonly openContactSearchPort: OpenContactSearchPort;
  readonly openGroupCreationPort: OpenGroupCreationPort;
  readonly openOwnProfilePort: () => Promise<OwnProfilePort>;
  readonly openConversationPort: OpenConversationPort;
  readonly continuation: { current: ConversationContinuation | undefined };
  readonly onReconnect: () => Promise<void>;
}
export function AuthenticatedShell(props: AuthenticatedShellProps) {
  return <AuthenticatedShellInstance key={import.meta.hot ? import.meta.url : undefined} {...props} />;
}
function AuthenticatedShellInstance({ warning, onLogout, openChatListPort, openOwnProfilePort, openContactSearchPort, openGroupCreationPort, openConversationPort, continuation, onReconnect }: AuthenticatedShellProps) {
  useScreenTranslations('chats');
  const { t, i18n } = useTranslation('chats'), { t: commonT } = useTranslation('common'), { t: errorT } = useTranslation('errors');
  const titleId = useId(), searchPanelId = useId();
  const searchButton = useRef<HTMLButtonElement>(null), searchInput = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null), headerRef = useRef<HTMLElement>(null), listPosition = useRef(0);
  const generation = useRef(0), currentNavigation = useRef<ConversationNavigation | undefined>(undefined);
  const cleanup = useRef<Promise<void>>(Promise.resolve());
  const [route, setRoute] = useState<Route>(() => ({ kind: continuation.current?.resumeTarget ? 'resuming' : 'list' }));
  const [navigationError, setNavigationError] = useState(false);
  const [contactOpening, setContactOpening] = useState<ContactOpeningState>('idle');
  const contactRequest = useRef<AbortController | undefined>(undefined);
  const [searchQuery, setSearchQuery] = useState<string>();
  const searchOpen = searchQuery !== undefined;
  const [controller] = useState(() => new ChatListController(openChatListPort, { deferPreviews: true }));
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const language = i18n.language === 'ru' ? 'ru' : 'en';
  const presenter = useMemo(() => createChatListPresenter({ language, t, errorT }), [language, t, errorT]);
  const view = useMemo(() => presenter.snapshot(snapshot, searchQuery), [presenter, snapshot, searchQuery]);
  const openSearch = () => {
    listPosition.current = scrollRef.current?.scrollTop ?? 0;
    setSearchQuery('');
  };
  const closeSearch = () => {
    setSearchQuery(undefined);
    searchButton.current?.focus({ preventScroll: true });
  };
  const backToList = () => {
    contactRequest.current?.abort();
    contactRequest.current = undefined;
    setContactOpening('idle');
    continuation.current?.clear();
    const previous = currentNavigation.current; currentNavigation.current = undefined;
    if (previous) cleanup.current = previous.close();
    setRoute({ kind: 'list' });
  };
  const openProfile = () => {
    listPosition.current = scrollRef.current?.scrollTop ?? 0;
    setNavigationError(false); setRoute({ kind: 'profile' });
  };
  const openChatCreation = () => {
    listPosition.current = scrollRef.current?.scrollTop ?? 0;
    setRoute({ kind: 'create' });
  };
  const openAddContact = () => {
    if (!clientConfig.chatCreationEnabled || contactRequest.current) return;
    setContactOpening('idle');
    setRoute({ kind: 'addContact' });
  };
  const backToContacts = () => {
    contactRequest.current?.abort();
    contactRequest.current = undefined;
    setContactOpening('idle');
    setRoute({ kind: 'create' });
  };
  const openGroupCreation = (topicKind: GroupCreationKind) => {
    if (clientConfig.chatCreationEnabled && !contactRequest.current) {
      setContactOpening('idle');
      setRoute({ kind: 'createGroup', topicKind });
    }
  };
  const backFromGroupCreation = () => setRoute({ kind: 'create' });

  const getChat = (topicKey: string) => {
    const state = controller.getSnapshot();
    return state.phase === 'ready' ? state.items.find(item => item.topicKey === topicKey) : undefined;
  };
  const showConversation = (item: ChatListItem, handoff: ChatPreviewPause, confirmedChannel = false) => {
    const isChannel = item.kind === 'group' && (confirmedChannel || item.topicKey.startsWith('chn'));
    const navigation = new ConversationNavigation(
      { account: handoff.account, topicKey: item.topicKey as ConversationTopicKey, kind: item.kind },
      handoff, openConversationPort, cleanup.current,
      { kind: item.kind, title: item.title, avatar: item.avatar, participantCount: item.participantCount,
        ...(isChannel ? { isChannel: true } : {}) },
      controller.openDraft(item.topicKey));
    if (route.kind === 'list' && !searchOpen) listPosition.current = scrollRef.current?.scrollTop ?? 0;
    setSearchQuery(undefined);
    currentNavigation.current = navigation;
    setNavigationError(false); setRoute({ kind: 'chat', navigation });
  };
  const openChat = (topicKey: string) => {
    if (currentNavigation.current?.active) return;
    const item = getChat(topicKey);
    if (!item) return;
    let handoff: ChatPreviewPause | undefined;
    try {
      // Pause new previews before setting state and importing the conversation screen.
      handoff = controller.pausePreviews(++generation.current);
      showConversation(item, handoff);
    } catch {
      handoff?.release();
      continuation.current?.clear(); setNavigationError(true); setRoute({ kind: 'list' });
    }
  };
  const openContact = async (userId: string) => {
    if (contactRequest.current || currentNavigation.current?.active) return;
    const request = new AbortController();
    contactRequest.current = request;
    let handoff: ChatPreviewPause | undefined;
    try {
      handoff = controller.pausePreviews(++generation.current);
      let item = getChat(userId);
      if (!item) {
        if (!handoff.preparePersonalChat) throw new Error('Personal chat is unavailable.');
        setContactOpening('opening');
        await handoff.preparePersonalChat(userId, request.signal);
        item = getChat(userId);
      }
      if (request.signal.aborted) return;
      if (item?.kind !== 'personal' || !handoff.active) throw new Error('Personal chat is unavailable.');
      showConversation(item, handoff);
      handoff = undefined;
      setContactOpening('idle');
    } catch (reason: unknown) {
      if (!request.signal.aborted) {
        const uncertain = reason instanceof ChatListFailure &&
          reason.chatListError.area === 'preview' && reason.chatListError.kind === 'unavailable' && !reason.chatListError.retryable;
        setContactOpening(uncertain ? 'unconfirmed' : 'failed');
      }
    } finally {
      handoff?.release();
      if (contactRequest.current === request) contactRequest.current = undefined;
    }
  };
  const runGroupCreation = async (port: GroupCreationPort, input: GroupCreationInput,
    previous: GroupCreationProgress | undefined, signal: AbortSignal): Promise<GroupCreationResult> => {
    const failed = previous ?? { state: 'rejected', reason: 'unavailable' } as const;
    if (route.kind !== 'createGroup' || route.topicKind !== input.kind || signal.aborted) return failed;
    let handoff: ChatPreviewPause | undefined;
    try {
      handoff = controller.pausePreviews(++generation.current);
      if (handoff.account.uid !== port.account.uid || handoff.account.serverId !== port.account.serverId ||
        handoff.account.generation !== port.account.generation) return failed;
      const snapshot = controller.getSnapshot();
      const knownGroups = snapshot.phase === 'ready'
        ? snapshot.items.filter(item => item.kind === 'group').map(item => item.topicKey)
        : [];
      return await port.run(input, previous, signal, knownGroups);
    } finally { handoff?.release(); }
  };

  const openCreatedGroup = async (created: Extract<GroupCreationResult, { state: 'created' }>, signal: AbortSignal): Promise<boolean> => {
    const { topicKey, kind } = created;
    if (route.kind !== 'createGroup' || route.topicKind !== kind || signal.aborted) return false;
    let handoff: ChatPreviewPause | undefined;
    try {
      handoff = controller.pausePreviews(++generation.current);
      if (!handoff.prepareCreatedGroup) return false;
      await handoff.prepareCreatedGroup(topicKey, signal, kind);
      const item = getChat(topicKey);
      if (signal.aborted || !handoff.active || item?.kind !== 'group') return false;
      showConversation(item, handoff, kind === 'channel');
      handoff = undefined;
      return true;
    } catch { return false; }
    finally { handoff?.release(); }
  };

  useEffect(() => {
    if (route.kind !== 'resuming' || snapshot.phase !== 'ready') return;
    const target = continuation.current?.resumeTarget;
    if (!target || !snapshot.items.some(item => item.topicKey === target.topicKey && item.kind === target.kind)) {
      continuation.current?.clear(); setNavigationError(true); setRoute({ kind: 'list' }); return;
    }
    openChat(target.topicKey);
  }, [snapshot, route.kind, controller, continuation]);
  useLayoutEffect(() => {
    if (route.kind === 'list' && scrollRef.current) {
      scrollRef.current.scrollTop = searchQuery === undefined ? listPosition.current : 0;
    }
  }, [route.kind, searchQuery]);
  useEffect(() => {
    hotRecoveries?.add(onReconnect); hotContinuations?.add(continuation); hotControllers?.add(controller); const detach = controller.attach(); void controller.start();
    let backgrounded = document.visibilityState === 'hidden';
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') backgrounded = true;
      else if (backgrounded) {
        backgrounded = false;
        controller.reconcileForeground();
      }
    };
    const onPageHide = () => { backgrounded = true; };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) onVisibility();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
      contactRequest.current?.abort();
      contactRequest.current = undefined;
      const navigation = currentNavigation.current; currentNavigation.current = undefined;
      if (navigation) void navigation.close();
      hotRecoveries?.delete(onReconnect); hotContinuations?.delete(continuation); hotControllers?.delete(controller); detach();
    };
  }, [controller]);
  const backLabel = commonT($ => $.backToChats);
  return <>
    <section className="chats-screen chats-overlay-screen" aria-labelledby={titleId} hidden={route.kind !== 'list'}>
      <header className="chats-header" ref={headerRef}>
        {!searchOpen && <button className="header-glass-button chats-profile-button" type="button" aria-label={view.profile.openLabel} onClick={openProfile}>
          <ChatAvatar avatar={view.profile.avatar} name={view.profile.name} />
        </button>}
        <h1 id={titleId} aria-label={view.title} hidden={searchOpen}>
          {clientConfig.chatCreationEnabled ? <button className="header-glass-pill chats-create-button" type="button"
            aria-label={t($ => $.openCreation)} onClick={openChatCreation}>
            <span>{view.title}</span>
            <AppIcon name="plus" />
          </button> : view.title}
        </h1>
        {searchQuery !== undefined && <HeaderSearchField id={searchPanelId} input={searchInput} label={t($ => $.search.open)}
          placeholder={t($ => $.search.placeholder)} query={searchQuery} onQuery={setSearchQuery} onKeyDown={event => {
            if (event.key === 'Escape' && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
              event.preventDefault();
              closeSearch();
            }
          }} />}
        <HeaderSearchToggle buttonRef={searchButton} open={searchOpen} disabled={!searchOpen && view.phase !== 'ready'}
          label={searchOpen ? t($ => $.search.close) : t($ => $.search.open)}
          panelId={searchPanelId} onToggle={searchOpen ? closeSearch : openSearch} />
      </header>
      <div className="chats-overlay-scroll" ref={scrollRef} tabIndex={-1}>
        {warning && <p className="chats-warning" role="alert">{authErrorText(errorT, warning)}</p>}
        {navigationError && <p className="chats-warning" role="alert">{errorT($ => $.conversationUnavailable)}</p>}
        <ChatList controller={controller} view={view} scrollRef={scrollRef} headerRef={headerRef} active={route.kind === 'list'} onOpenChat={openChat} />
      </div>
    </section>
    {route.kind === 'resuming' && (snapshot.phase !== 'error' ? <ProtectedScreenLoading onBack={backToList} /> : <AppStatus
      message={snapshot.phase === 'error' ? errorT($ => $[snapshot.error.messageCode], snapshot.error.messageParams) : commonT($ => $.loadingScreen)}
      onRetry={snapshot.phase === 'error' && snapshot.error.retryable ? () => { void controller.retry(); } : undefined}
      onBack={backToList} backLabel={backLabel} />)}
    {route.kind === 'profile' && <ScreenBoundary resetKey="profile" onBack={backToList} backLabel={backLabel}>
      <Suspense fallback={<ProtectedScreenLoading onBack={backToList} />}>
        <ProfilePanel profile={'ownProfile' in snapshot ? snapshot.ownProfile : undefined}
          onRetryProfile={controller.retryOwnProfile} onProfileSaved={controller.refreshOwnProfile} openOwnProfilePort={openOwnProfilePort} warning={warning} onBack={backToList} onLogout={onLogout} />
      </Suspense>
    </ScreenBoundary>}
    {(route.kind === 'create' || route.kind === 'addContact' || route.kind === 'createGroup') && <ScreenBoundary resetKey="create" onBack={backToList} backLabel={backLabel}>
      <Suspense fallback={route.kind === 'create' ? <ProtectedScreenLoading onBack={backToList} /> : null}>
        <ChatCreationScreen chatList={view} contactOpening={contactOpening} hidden={route.kind !== 'create'}
          onAddContact={openAddContact} onCreateGroup={() => openGroupCreation('group')}
          onCreateChannel={() => openGroupCreation('channel')} onOpenContact={openContact} onBack={backToList} />
      </Suspense>
    </ScreenBoundary>}
    {route.kind === 'addContact' && <ScreenBoundary resetKey="addContact" onBack={backToContacts} backLabel={commonT($ => $.back)}>
      <Suspense fallback={<ProtectedScreenLoading onBack={backToContacts} />}>
        <AddContactScreen openPort={openContactSearchPort} contactOpening={contactOpening}
          onOpenContact={openContact} onBack={backToContacts} />
      </Suspense>
    </ScreenBoundary>}
    {route.kind === 'createGroup' && <ScreenBoundary resetKey={route.topicKind} onBack={backFromGroupCreation} backLabel={commonT($ => $.back)}>
      <Suspense fallback={<ProtectedScreenLoading onBack={backFromGroupCreation} />}>
        <CreateGroupScreen key={route.topicKind} kind={route.topicKind} chatList={view} openPort={openGroupCreationPort}
          onRun={runGroupCreation} onOpen={openCreatedGroup} onBack={backFromGroupCreation} />
      </Suspense>
    </ScreenBoundary>}
    {route.kind === 'chat' && <ScreenBoundary resetKey={route.navigation.identity.topicKey + ':' + route.navigation.generation}
      onBack={backToList} backLabel={backLabel}>
      <Suspense fallback={<ProtectedScreenLoading onBack={backToList} />}>
        <ConversationRoute key={route.navigation.generation} navigation={route.navigation}
          notificationsMuted={snapshot.phase === 'ready' &&
            snapshot.items.find(item => item.topicKey === route.navigation.identity.topicKey)?.notificationsMuted === true}
          onBack={backToList} continuation={continuation} onReconnect={onReconnect} chatList={view} />
      </Suspense>
    </ScreenBoundary>}
  </>;
}
