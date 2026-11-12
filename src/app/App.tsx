import { loadTranslations } from '../i18n';
import { useTranslation } from 'react-i18next';
import { authErrorText } from '../i18n/auth-error';
import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AuthController } from '../auth/AuthController';
import { AppStatus } from './AppStatus';
import { ScreenBoundary } from './ScreenBoundary';
import { clientConfig } from '../config';
import { sdkVersion } from '../integrations/tinode/sdk';

import { AuthScreen } from '../auth/ui/AuthScreen';
import type { ConversationContinuation } from '../conversation/ConversationContinuation';
import { tinodeServerId } from '../config/server-id';

// Load sign-in and registration with the initial shell. Load protected screens when opened.
const AuthenticatedShell = lazy(() => Promise.all([import('./AuthenticatedShell'), loadTranslations('chats')])
  .then(([module]) => ({ default: module.AuthenticatedShell })));

// Hot reload closes the previous owner before creating a new connection or port.
const hotControllers = import.meta.hot ? new Set<AuthController>() : undefined;
if (import.meta.hot && hotControllers) {
  import.meta.hot.dispose(() => {
    for (const controller of hotControllers) controller.dispose();
    hotControllers.clear();
  });
}

// The module URL changes on hot reload. Use it as the key to recreate the controller owner.
export function App() {
  return <AppInstance key={import.meta.hot ? import.meta.url : undefined} />;
}

function AppInstance() {
  const { t } = useTranslation('common');
  const { t: errorT } = useTranslation('errors');
  const [controller] = useState(() => new AuthController(clientConfig));
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const continuation = useRef<ConversationContinuation | undefined>(undefined);
  const lifetime = useRef(0);
  const [loginFormVersion, setLoginFormVersion] = useState(0);
  const logout = () => {
    continuation.current?.clear();
    controller.logout();
    setLoginFormVersion((version) => version + 1);
  };

  useEffect(() => {
    ++lifetime.current;
    const sync = () => continuation.current?.synchronizeAuth(controller.getSnapshot(), tinodeServerId(clientConfig));
    const unsubscribe = controller.subscribe(sync);
    sync();
    hotControllers?.add(controller);
    const detach = controller.attach();
    void controller.initialize();
    return () => {
      unsubscribe(); hotControllers?.delete(controller);
      detach();
      const version = ++lifetime.current;
      queueMicrotask(() => { if (version === lifetime.current) { continuation.current?.clear(); continuation.current = undefined; } });
    };
  }, [controller]);

  const emailStep = snapshot.phase === 'pendingEmail' || snapshot.phase === 'confirming'
    ? snapshot.challenge : undefined;
  const returnToLogin = () => controller.returnToLogin();
  const registration = clientConfig.registrationEnabled &&
    (snapshot.phase === 'loadingRequirements' ||
      ((snapshot.phase === 'signedOut' || snapshot.phase === 'submitting') && snapshot.flow === 'registration'));
  const requirements = 'requirements' in snapshot ? snapshot.requirements : undefined;
  const authView = emailStep ? 'email' : registration ? 'registration' : 'login';

  let content;
  if (snapshot.phase === 'checkingSession') {
    content = <AppStatus loading message={t(($) => $.checkingSession)} />;
  } else if (snapshot.phase === 'restoreError') {
    content = <AppStatus message={authErrorText(errorT, snapshot.error)}
      onRetry={snapshot.error.retryable ? () => { void controller.retryRestore(); } : undefined}
      onBack={() => controller.returnToLogin()} />;
  } else if (snapshot.phase === 'authenticated') {
    content = <AuthenticatedShell key={snapshot.identity.uid} warning={snapshot.warning} onLogout={logout}
      continuation={continuation} onReconnect={controller.reconnectSession}
      openChatListPort={controller.openChatListPort} openConversationPort={controller.openConversationPort}
      openOwnProfilePort={controller.openOwnProfilePort} openContactSearchPort={controller.openContactSearchPort}
      openGroupCreationPort={controller.openGroupCreationPort} />;
  } else {
    const error = snapshot.phase === 'signedOut' || snapshot.phase === 'pendingEmail' ? snapshot.error : undefined;
    content = <AuthScreen key={loginFormVersion} appName={clientConfig.appName}
      busy={snapshot.phase === 'submitting' || snapshot.phase === 'confirming'} error={error}
      flow={registration ? 'registration' : 'login'} registrationEnabled={clientConfig.registrationEnabled}
      loadingRequirements={snapshot.phase === 'loadingRequirements'} requirements={requirements}
      onOpenRegistration={clientConfig.registrationEnabled ? controller.openRegistration : undefined}
      onRegister={clientConfig.registrationEnabled ? controller.register : undefined}
      challenge={emailStep} onLogin={controller.login} onConfirmEmail={controller.confirmEmail}
      onReturnToLogin={returnToLogin}
      onRetryLogout={error?.operation === 'logout' ? logout : undefined} />;
  }

  return (
    <main className="app-shell" data-sdk-version={sdkVersion}>
      <ScreenBoundary resetKey={snapshot.phase + ":" + authView} onBack={emailStep || registration ? returnToLogin : undefined}>
        <Suspense fallback={<AppStatus loading message={t(($) => $.loadingScreen)} />}>{content}</Suspense>
      </ScreenBoundary>
    </main>
  );
}
