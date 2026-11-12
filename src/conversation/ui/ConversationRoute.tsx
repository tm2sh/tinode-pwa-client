// @refresh reset
import { useEffect, useLayoutEffect, useState } from 'react';
import { useScreenTranslations } from '../../i18n';
import type { ConversationNavigation } from '../../app/ConversationNavigation';
import { ConversationContinuation } from '../ConversationContinuation';
import { ConversationController } from '../ConversationController';
import type { ChatListView } from '../../chats/chat-list-presenter';
import { ChatScreen } from './ChatScreen';

// HMR retires the old generation through the same auth owner; production has no such hook.
const hotRoutes = import.meta.hot ? new Set<{ owner: ConversationContinuation; reconnect: () => Promise<void> }>() : undefined;
if (import.meta.hot && hotRoutes) import.meta.hot.dispose(() => {
  for (const route of hotRoutes) { route.owner.clear(); void route.reconnect(); }
  hotRoutes.clear();
});

export function ConversationRoute({ navigation, notificationsMuted, onBack, continuation, onReconnect, chatList }: {
  readonly navigation: ConversationNavigation;
  readonly notificationsMuted: boolean;
  readonly chatList: Pick<ChatListView, 'items' | 'phase'>;
  readonly onBack: () => void;
  readonly continuation: { current: ConversationContinuation | undefined };
  readonly onReconnect: () => Promise<void>;
}) {
  useScreenTranslations('chat', 'media');
  const [instance] = useState(() => {
    if (!continuation.current?.matches(navigation.identity)) {
      continuation.current?.clear(); continuation.current = new ConversationContinuation(navigation.identity);
    }
    const owner = continuation.current;
    return { owner, controller: new ConversationController(navigation.identity, navigation.openPort,
      owner.readFor(navigation.identity), navigation.draftPort) };
  });
  useLayoutEffect(() => {
    const route = { owner: instance.owner, reconnect: onReconnect };
    hotRoutes?.add(route);
    const detach = instance.owner.bind(instance.controller);
    return () => { hotRoutes?.delete(route); detach(); };
  }, [instance, onReconnect]);
  const controller = instance.controller;
  useEffect(() => {
    controller.restoreServerDraft();
    const onPageHide = () => { void controller.saveServerDraft(); };
    const onVisibility = () => { if (document.visibilityState === 'hidden') onPageHide(); };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [controller]);
  const exit = () => { void controller.saveServerDraft(); onBack(); };
  return <ChatScreen controller={controller} onBack={exit} onReconnect={onReconnect} initialHeader={navigation.headerPreview}
    notificationsMuted={notificationsMuted} chatList={chatList} />;
}
