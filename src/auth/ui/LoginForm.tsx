import { useTranslation } from 'react-i18next';
import { AppIcon } from '../../app/AppIcon';
import { authErrorText } from '../../i18n/auth-error';
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, PointerEvent } from 'react';
import type { AuthError, LoginCredentials } from '../auth-types';

interface LoginFormProps {
  readonly busy?: boolean;
  readonly error?: AuthError;
  readonly onSubmit?: (credentials: LoginCredentials) => void | Promise<void>;
  readonly onEdit?: () => void;
}

interface MissingFields {
  readonly login: boolean;
  readonly password: boolean;
}

export function LoginForm({ busy = false, error, onSubmit, onEdit }: LoginFormProps) {
  const { t } = useTranslation('auth');
  const { t: errorT } = useTranslation('errors');
  const id = useId();
  const loginId = id + '-login';
  const passwordId = id + '-password';
  const errorId = id + '-error';
  const passwordInput = useRef<HTMLInputElement>(null);
  const submitLock = useRef(false);
  const mounted = useRef(false);
  const [sending, setSending] = useState(false);
  const [submitError, setSubmitError] = useState<boolean>(false);
  const waiting = busy || sending;

  useEffect(() => {
    mounted.current = true;
    const field = passwordInput.current;
    return () => {
      mounted.current = false;
      // StrictMode reruns effects on the same DOM node. Clear the input only when it is detached.
      if (field && !field.isConnected) field.value = '';
    };
  }, []);

  const [passwordVisible, setPasswordVisible] = useState(false);
  const [missing, setMissing] = useState<MissingFields | null>(null);
  const [dismissedError, setDismissedError] = useState<AuthError | undefined>();
  const visibleError = error !== dismissedError ? error : undefined;
  const message = missing
    ? missing.login && missing.password ? errorT(($) => $.credentialsRequired)
      : missing.login ? errorT(($) => $.loginRequired) : errorT(($) => $.passwordRequired)
    : submitError ? errorT(($) => $.loginFailed) : visibleError ? authErrorText(errorT, visibleError) : undefined;
  const loginInvalid = Boolean(missing?.login || visibleError?.field === 'login' ||
    visibleError?.kind === 'invalidCredentials');
  const passwordInvalid = Boolean(missing?.password || visibleError?.field === 'password' ||
    visibleError?.kind === 'invalidCredentials');

  function edit() {
    setMissing(null);
    setSubmitError(false);
    setDismissedError(error);
    onEdit?.();
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (waiting || submitLock.current || !onSubmit) return;

    const data = new FormData(event.currentTarget);
    const loginValue = data.get('username');
    const passwordValue = data.get('password');
    const login = typeof loginValue === 'string' ? loginValue : '';
    const password = typeof passwordValue === 'string' ? passwordValue : '';
    const fields = { login: login.trim() === '', password: password === '' };
    if (fields.login || fields.password) {
      setMissing(fields);
      setDismissedError(error);
      return;
    }

    setMissing(null);
    setSubmitError(false);
    submitLock.current = true;
    setSending(true);
    const passwordField = passwordInput.current;
    const finish = () => {
      // Clear the submitted form even if it has already unmounted.
      if (passwordField) passwordField.value = '';
      submitLock.current = false;
      if (mounted.current) {
        setSending(false);
        setPasswordVisible(false);
      }
    };
    const failed = () => {
      if (mounted.current) setSubmitError(true);
    };
    try {
      const pending = onSubmit({ login, password });
      void Promise.resolve(pending).catch(failed).finally(finish);
    } catch {
      failed();
      finish();
    } finally {
      data.delete('password');
      data.delete('username');
    }
  }

  function keepPasswordFocus(event: PointerEvent<HTMLButtonElement>) {
    if (document.activeElement === passwordInput.current) event.preventDefault();
  }

  return (
    <form className="auth-form" method="post" noValidate aria-busy={waiting}
      onSubmit={submit} onInput={edit}>
      <div className="auth-card">
        <div className="auth-field">
          <label htmlFor={loginId}>{t(($) => $.login.loginLabel)}</label>
          <input id={loginId} name="username" type="text" placeholder={t(($) => $.login.loginPlaceholder)}
            autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false}
            enterKeyHint="next" required readOnly={waiting}
            aria-invalid={loginInvalid || undefined} aria-describedby={errorId} />
        </div>
        <div className="auth-field">
          <label htmlFor={passwordId}>{t(($) => $.login.passwordLabel)}</label>
          <div className="auth-password-row">
            <input ref={passwordInput} id={passwordId} name="password"
              type={passwordVisible ? 'text' : 'password'} placeholder={t(($) => $.login.passwordPlaceholder)}
              autoComplete="current-password" autoCapitalize="none" autoCorrect="off" spellCheck={false}
              enterKeyHint="go" required readOnly={waiting}
              aria-invalid={passwordInvalid || undefined} aria-describedby={errorId} />
            <button type="button" className="auth-password-toggle"
              aria-label={passwordVisible ? t(($) => $.login.hidePassword) : t(($) => $.login.showPassword)}
              aria-pressed={passwordVisible} aria-controls={passwordId}
              onPointerDown={keepPasswordFocus}
              onClick={() => setPasswordVisible((visible) => !visible)}>
              <AppIcon name={passwordVisible ? 'eye-off' : 'eye'} />
            </button>
          </div>
        </div>
      </div>
      <p className="auth-error" id={errorId} role="alert" hidden={!message}>{message}</p>
      <button className="auth-submit" type="submit" disabled={waiting || !onSubmit}>
        <AppIcon name="spinner" className={waiting ? 'auth-spinner' : 'auth-spinner is-hidden'} />
        <span aria-live="polite">{waiting ? t(($) => $.login.submitting) : t(($) => $.login.submit)}</span>
      </button>
    </form>
  );
}
