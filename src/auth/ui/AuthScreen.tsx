import { useTranslation } from 'react-i18next';
import { authErrorText } from '../../i18n/auth-error';
import { lazy, Suspense, useId, useRef } from 'react';
import { LoginForm } from './LoginForm';
import { RegistrationForm } from './RegistrationForm';
import { useAuthViewport } from './useAuthViewport';
import type { AuthError, AuthFlow, LoginCredentials, PendingEmailInfo, RegistrationCredentials, RegistrationRequirements } from '../auth-types';
import '../../styles/auth.css';
import '../../styles/auth-viewport.css';

const EmailStep = lazy(() => import('./EmailStep').then((module) => ({ default: module.EmailStep })));

interface AuthScreenProps {
  readonly appName: string;
  readonly busy?: boolean;
  readonly flow?: AuthFlow;
  readonly registrationEnabled?: boolean;
  readonly loadingRequirements?: boolean;
  readonly requirements?: RegistrationRequirements;
  readonly onOpenRegistration?: () => void | Promise<void>;
  readonly onRegister?: (credentials: RegistrationCredentials) => void | Promise<void>;
  readonly challenge?: PendingEmailInfo;
  readonly onConfirmEmail?: (code: string) => void | Promise<void>;
  readonly onReturnToLogin: () => void;
  readonly error?: AuthError;
  readonly onLogin?: (credentials: LoginCredentials) => void | Promise<void>;
  readonly onEdit?: () => void;
  readonly onRetryLogout?: () => void;
}

export function AuthScreen({ appName, busy, error, challenge, onLogin, onConfirmEmail, onReturnToLogin, onEdit, onRetryLogout,
  flow = 'login', registrationEnabled = false, loadingRequirements = false, requirements, onOpenRegistration, onRegister }: AuthScreenProps) {
  const { t } = useTranslation('auth');
  const { t: commonT } = useTranslation('common');
  const { t: errorT } = useTranslation('errors');
  const logoutError = error?.operation === 'logout' ? error : undefined;
  const registration = registrationEnabled && flow === 'registration' && !challenge;
  const registrationBlocked = error?.kind === 'unsupportedCredential' ||
    (error?.kind === 'invalidResponse' && error.operation === 'getRequirements');
  const back = <button className="glass-control auth-submit auth-back" type="button"
    onClick={onReturnToLogin}>{commonT(($) => $.backToLogin)}</button>;
  const titleId = useId();
  const screenRef = useRef<HTMLElement>(null);
  useAuthViewport(screenRef);

  let form;
  if (challenge) {
    form = <>
      <Suspense fallback={<p className="auth-code-loading" role="status">{t(($) => $.email.loading)}</p>}>
        <EmailStep challenge={challenge} busy={busy} error={error} onSubmit={onConfirmEmail} onEdit={onEdit} />
      </Suspense>
      {back}
    </>;
  } else if (registration) {
    form = <RegistrationForm emailRequired={requirements?.emailRequired ?? false}
      busy={busy} preparing={loadingRequirements} submissionBlocked={!requirements || registrationBlocked}
      error={error} onSubmit={onRegister} onBack={onReturnToLogin} onEdit={onEdit}
      onRetryRequirements={error?.operation === 'getRequirements' && error.retryable ? onOpenRegistration : undefined} />;
  } else {
    form = <>
      <LoginForm busy={busy} error={logoutError ? undefined : error} onSubmit={onLogin} onEdit={onEdit} />
      {registrationEnabled && onOpenRegistration && <button className="glass-control auth-submit auth-back" type="button"
        disabled={busy} onClick={() => { void onOpenRegistration(); }}>{t(($) => $.registration.submit)}</button>}
    </>;
  }

  return (
    <section ref={screenRef} className="auth-screen" aria-labelledby={titleId}>
      <div className="auth-content">
        <header className="auth-heading">
          <h1 id={titleId}>{appName}</h1>
          <p>{challenge ? t(($) => $.email.title) : registration ? t(($) => $.registration.title) : t(($) => $.login.subtitle)}</p>
        </header>
        {form}
        {logoutError && <p className="auth-error" role="alert">{authErrorText(errorT, logoutError)}</p>}
        {onRetryLogout && <button className="glass-control auth-submit" type="button" onClick={onRetryLogout}>{t(($) => $.retryLogout)}</button>}
      </div>
    </section>
  );
}
