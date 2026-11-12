import { useTranslation } from 'react-i18next';
import { AppIcon } from './AppIcon';
import { clientConfig } from '../config';
import '../styles/app-status.css';

interface AppStatusProps {
  readonly message: string;
  readonly loading?: boolean;
  readonly role?: 'status' | 'alert';
  readonly onBack?: () => void;
  readonly backLabel?: string;
  readonly onRetry?: () => void;
  readonly retryLabel?: string;
}

export function AppStatus({ message, loading = false, role = 'status', onBack, backLabel,
  onRetry, retryLabel }: AppStatusProps) {
  const { t } = useTranslation('common');
  if (loading) return (
    <section className="app-loading" aria-label={t(($) => $.applicationState)}>
      <div className="app-loading-indicator">
        <AppIcon name="spinner" className="auth-spinner" />
        <p className="app-loading-message" role="status">{message}</p>
      </div>
      {onBack && <button className="app-status-button app-loading-back" type="button" onClick={onBack}>
        {backLabel ?? t(($) => $.backToLogin)}
      </button>}
    </section>
  );
  return (
    <section className="app-status" aria-label={t(($) => $.applicationState)}>
      <div className="app-status-content">
        <header className="app-status-heading">
          <h1>{clientConfig.appName}</h1>
          <p role={role}>{message}</p>
        </header>
        {onRetry && <button className="app-status-button" type="button" onClick={onRetry}>{retryLabel ?? t(($) => $.retry)}</button>}
        {onBack && <button className="app-status-button" type="button" onClick={onBack}>{backLabel ?? t(($) => $.backToLogin)}</button>}
      </div>
    </section>
  );
}
