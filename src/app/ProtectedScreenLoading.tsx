import { useTranslation } from 'react-i18next';
import { AppStatus } from './AppStatus';
import { BackButton } from './BackButton';

export function ProtectedScreenLoading({ onBack }: { readonly onBack: () => void }) {
  const { t } = useTranslation('common');
  return <section className="chats-screen protected-screen-loading">
    <header className="chats-header"><BackButton className="chats-round-button" onBack={onBack} /></header>
    <AppStatus loading message={t($ => $.loadingScreen)} />
  </section>;
}

// Retrying a lazily loaded panel keeps the parent screen, user input, and session intact.
export function ProtectedScreenFailure({ onBack, onRetry }: { readonly onBack: () => void; readonly onRetry: () => void }) {
  const { t } = useTranslation('common');
  return <section className="chats-screen protected-screen-failure">
    <header className="chats-header"><BackButton className="chats-round-button" onBack={onBack} /></header>
    <div className="protected-screen-error">
      <p role="alert">{t($ => $.panelLoadFailed)}</p>
      <button type="button" className="glass-control app-status-button" onClick={onRetry}>{t($ => $.retry)}</button>
    </div>
  </section>;
}
