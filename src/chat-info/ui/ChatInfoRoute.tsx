import { lazy, Suspense, useState } from 'react';
import { ScreenBoundary } from '../../app/ScreenBoundary';
import { ProtectedScreenFailure, ProtectedScreenLoading } from '../../app/ProtectedScreenLoading';
import { loadTranslations } from '../../i18n';
import type { ChatListView } from '../../chats/chat-list-presenter';
import type { ChatInfoIdentity, ChatInfoNavigation } from '../chat-info-types';

export interface ChatInfoRouteProps extends ChatInfoNavigation {
  readonly onBack: () => void;
  readonly chatList?: Pick<ChatListView, 'items' | 'phase'>;
}

function createContent() {
  return lazy(() => Promise.all([
    import('./ChatInfoScreen'), loadTranslations('chatInfo', { retry: true }),
  ]).then(([module]) => ({ default: module.ChatInfoRouteContent })));
}

// React can retry a render before it commits. Share the lazy component across
// those renders, including its rejected result, until the user retries or reopens.
const panelLoads = new WeakMap<ChatInfoIdentity, Map<number, ReturnType<typeof createContent>>>();

function contentFor(identity: ChatInfoIdentity, attempt: number) {
  let attempts = panelLoads.get(identity);
  if (!attempts) {
    attempts = new Map();
    panelLoads.set(identity, attempts);
  }
  let content = attempts.get(attempt);
  if (!content) {
    content = createContent();
    attempts.set(attempt, content);
  }
  return content;
}

export function ChatInfoRoute(props: ChatInfoRouteProps) {
  const [attempt, setAttempt] = useState(0);
  const Content = contentFor(props.identity, attempt);
  const { account, topicKey, kind, panelGeneration } = props.identity;
  const key = JSON.stringify([account.serverId, account.uid, account.generation, topicKey, kind, panelGeneration]);
  return <ScreenBoundary resetKey={key + ':' + attempt}
    fallback={<ProtectedScreenFailure onBack={props.onBack} onRetry={() => setAttempt(value => value + 1)} />}>
    <Suspense fallback={<ProtectedScreenLoading onBack={props.onBack} />}>
      <Content key={key} {...props} />
    </Suspense>
  </ScreenBoundary>;
}
