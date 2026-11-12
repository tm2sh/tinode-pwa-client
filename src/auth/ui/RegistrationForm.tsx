import { useEffect, useId, useRef, useState } from 'react';
import { AppIcon } from '../../app/AppIcon';
import type { FormEvent, KeyboardEvent, PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { AuthError, AuthField, RegistrationFormProps } from '../auth-types';
import type { ErrorMessageCode } from '../../i18n/resources';
import { authErrorText } from '../../i18n/auth-error';
import '../../styles/registration.css';

type RegistrationField = Exclude<AuthField, 'code'>;
interface ValidationError {
  readonly fields: readonly RegistrationField[];
  readonly messageCode: ErrorMessageCode;
}

const passwordFields = ['password', 'passwordRepeat'] as const;

export function RegistrationForm({ emailRequired, busy = false, preparing = false, submissionBlocked = false,
  onRetryRequirements, error, onSubmit, onBack, onEdit }: RegistrationFormProps) {
  const { t } = useTranslation('auth');
  const { t: commonT } = useTranslation('common');
  const { t: errorT } = useTranslation('errors');
  const id = useId();
  const errorId = id + '-error';
  const passwordInput = useRef<HTMLInputElement>(null);
  const repeatInput = useRef<HTMLInputElement>(null);
  const submitLock = useRef(false);
  const mounted = useRef(false);
  const clearDraft = useRef<(() => void) | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const [validation, setValidation] = useState<ValidationError | undefined>();
  const [submitError, setSubmitError] = useState(false);
  const [dismissedError, setDismissedError] = useState<AuthError | undefined>();
  const [visible, setVisible] = useState({ password: false, passwordRepeat: false });
  const waiting = busy || sending;
  const visibleError = error !== dismissedError ? error : undefined;
  const message = validation ? errorT(($) => $[validation.messageCode])
    : visibleError ? authErrorText(errorT, visibleError)
      : submitError ? errorT(($) => $.registrationFailed) : undefined;

  useEffect(() => {
    mounted.current = true;
    const password = passwordInput.current;
    const repeat = repeatInput.current;
    return () => {
      mounted.current = false;
      // StrictMode reruns effects on the same DOM nodes. Clear the form only when it is detached.
      if ((password && !password.isConnected) || (repeat && !repeat.isConnected)) {
        clearDraft.current?.();
        if (password) password.value = '';
        if (repeat) repeat.value = '';
      }
    };
  }, []);

  function invalid(field: RegistrationField): true | undefined {
    return validation?.fields.includes(field) || visibleError?.field === field ? true : undefined;
  }

  function edit() {
    setValidation(undefined);
    setSubmitError(false);
    setDismissedError(error);
    onEdit?.();
  }

  function back() {
    clearDraft.current?.();
    if (passwordInput.current) passwordInput.current.value = '';
    if (repeatInput.current) repeatInput.current.value = '';
    onBack();
  }

  function nextField(event: KeyboardEvent<HTMLFormElement>) {
    if (event.defaultPrevented || event.key !== 'Enter' || event.nativeEvent.isComposing || waiting ||
      !(event.target instanceof HTMLInputElement)) return;
    const fields = Array.from(event.currentTarget.querySelectorAll('input'));
    const next = fields[fields.indexOf(event.target) + 1];
    if (next) {
      event.preventDefault();
      // After focus changes, useAuthViewport handles scrolling the long form.
      next.focus({ preventScroll: true });
    }
  }

  function keepPasswordFocus(event: PointerEvent<HTMLButtonElement>, field: HTMLInputElement | null) {
    if (document.activeElement === field) event.preventDefault();
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (waiting || preparing || submissionBlocked || submitLock.current || !onSubmit) return;
    const data = new FormData(event.currentTarget);
    const text = (name: string) => {
      const value = data.get(name);
      return typeof value === 'string' ? value : '';
    };
    const draft = {
      displayName: text('nickname'), login: text('username'),
      password: text('password'), passwordRepeat: text('passwordRepeat'),
      ...(emailRequired ? { email: text('email') } : {}),
    };
    for (const name of ['nickname', 'username', 'password', 'passwordRepeat', 'email']) data.delete(name);
    const missing: Array<{ field: RegistrationField; messageCode: ErrorMessageCode }> = [];
    if (!draft.displayName.trim()) missing.push({ field: 'displayName', messageCode: 'displayNameRequired' });
    if (!draft.login.trim()) missing.push({ field: 'login', messageCode: 'loginRequired' });
    if (draft.password === '') missing.push({ field: 'password', messageCode: 'passwordRequired' });
    if (draft.passwordRepeat === '') missing.push({ field: 'passwordRepeat', messageCode: 'passwordRepeatRequired' });
    if (emailRequired && !draft.email?.trim()) missing.push({ field: 'email', messageCode: 'emailRequired' });
    if (missing.length || draft.password !== draft.passwordRepeat) {
      setValidation(missing.length
        ? { fields: missing.map(({ field }) => field), messageCode: missing[0].messageCode }
        : { fields: ['passwordRepeat'], messageCode: 'passwordMismatch' });
      setDismissedError(error);
      draft.password = ''; draft.passwordRepeat = '';
      return;
    }

    setValidation(undefined);
    setSubmitError(false);
    setDismissedError(error);
    submitLock.current = true;
    setSending(true);
    const password = passwordInput.current;
    const repeat = repeatInput.current;
    const clear = () => {
      draft.password = ''; draft.passwordRepeat = '';
      if (password) password.value = '';
      if (repeat) repeat.value = '';
    };
    clearDraft.current = clear;
    const finish = () => {
      // A late response clears the submitted form only, leaving a new instance alone.
      clear();
      if (clearDraft.current === clear) clearDraft.current = undefined;
      submitLock.current = false;
      if (mounted.current) {
        setSending(false);
        setVisible({ password: false, passwordRepeat: false });
      }
    };
    const failed = () => { if (mounted.current) setSubmitError(true); };
    try {
      void Promise.resolve(onSubmit(draft)).catch(failed).finally(finish);
    } catch {
      failed();
      finish();
    }
  }

  return (
    <form className="auth-form registration-form" method="post" noValidate aria-busy={waiting || preparing}
      onSubmit={submit} onInput={edit} onKeyDown={nextField}>
      <div className="auth-card">
        <div className="auth-field">
          <label htmlFor={id + '-name'}>{t(($) => $.registration.displayNameLabel)}</label>
          <input id={id + '-name'} name="nickname" type="text"
            placeholder={t(($) => $.registration.displayNamePlaceholder)} autoComplete="nickname"
            enterKeyHint="next" required readOnly={waiting}
            aria-invalid={invalid('displayName')} aria-describedby={errorId} />
        </div>
        <div className="auth-field">
          <label htmlFor={id + '-login'}>{t(($) => $.registration.loginLabel)}</label>
          <input id={id + '-login'} name="username" type="text"
            placeholder={t(($) => $.registration.loginPlaceholder)} autoComplete="username"
            autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="next"
            required readOnly={waiting} aria-invalid={invalid('login')} aria-describedby={errorId} />
        </div>
        {passwordFields.map((field) => {
          const repeat = field === 'passwordRepeat';
          const input = repeat ? repeatInput : passwordInput;
          return <div className="auth-field" key={field}>
            <label htmlFor={id + '-' + field}>{repeat
              ? t(($) => $.registration.passwordRepeatLabel) : t(($) => $.registration.passwordLabel)}</label>
            <div className="auth-password-row">
              <input ref={input} id={id + '-' + field} name={field}
                type={visible[field] ? 'text' : 'password'}
                placeholder={repeat ? t(($) => $.registration.passwordRepeatPlaceholder) : t(($) => $.registration.passwordPlaceholder)}
                autoComplete="new-password" autoCapitalize="none" autoCorrect="off" spellCheck={false}
                enterKeyHint={repeat && !emailRequired ? 'go' : 'next'} required readOnly={waiting}
                aria-invalid={invalid(field)} aria-describedby={errorId} />
              <button className="auth-password-toggle" type="button"
                aria-label={repeat
                  ? visible[field] ? t(($) => $.registration.hidePasswordRepeat) : t(($) => $.registration.showPasswordRepeat)
                  : visible[field] ? t(($) => $.registration.hidePassword) : t(($) => $.registration.showPassword)}
                aria-pressed={visible[field]} aria-controls={id + '-' + field}
                onPointerDown={(event) => keepPasswordFocus(event, input.current)}
                onClick={() => setVisible((previous) => ({ ...previous, [field]: !previous[field] }))}>
                <AppIcon name={visible[field] ? 'eye-off' : 'eye'} />
              </button>
            </div>
          </div>;
        })}
        {emailRequired && <div className="auth-field">
          <label htmlFor={id + '-email'}>{t(($) => $.registration.emailLabel)}</label>
          <input id={id + '-email'} name="email" type="email"
            placeholder={t(($) => $.registration.emailPlaceholder)} autoComplete="email"
            autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="go"
            required readOnly={waiting} aria-invalid={invalid('email')} aria-describedby={errorId} />
        </div>}
      </div>
      <p className="auth-error" id={errorId} role="alert" hidden={!message}>{message}</p>
      <div className="registration-actions">
        <button className="auth-submit" type={onRetryRequirements ? 'button' : 'submit'}
          disabled={waiting || preparing || (!onRetryRequirements && (submissionBlocked || !onSubmit))}
          onClick={onRetryRequirements ? () => { void onRetryRequirements(); } : undefined}>
          <AppIcon name="spinner" className={waiting || preparing ? 'auth-spinner' : 'auth-spinner is-hidden'} />
          <span aria-live="polite">{waiting ? t(($) => $.registration.submitting)
            : preparing ? t(($) => $.registration.loadingRequirements)
              : onRetryRequirements ? commonT(($) => $.retry) : t(($) => $.registration.submit)}</span>
        </button>
        <button className="auth-submit auth-back" type="button" onClick={back}>{commonT(($) => $.backToLogin)}</button>
      </div>
    </form>
  );
}
