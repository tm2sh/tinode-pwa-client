import { useTranslation } from 'react-i18next';
import { AppIcon } from '../../app/AppIcon';
import { authErrorText } from '../../i18n/auth-error';
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { AuthError, EmailStepProps } from '../auth-types';
import '../../styles/email-step.css';

export function EmailStep({ challenge, busy = false, error, onSubmit, onEdit }: EmailStepProps) {
  const { t } = useTranslation('auth');
  const { t: errorT } = useTranslation('errors');
  const id = useId();
  const inputId = id + '-code';
  const hintId = id + '-hint';
  const errorId = id + '-error';
  const input = useRef<HTMLInputElement>(null);
  const submitLock = useRef(false);
  const mounted = useRef(false);
  const [sending, setSending] = useState(false);
  const [missing, setMissing] = useState(false);
  const [submitError, setSubmitError] = useState<boolean>(false);
  const [dismissedError, setDismissedError] = useState<AuthError | undefined>();
  const waiting = busy || sending;
  const visibleError = error !== dismissedError ? error : undefined;
  const message = missing ? errorT(($) => $.codeRequired) : submitError ? errorT(($) => $.confirmEmailFailed)
    : visibleError ? authErrorText(errorT, visibleError) : undefined;
  const invalid = missing || visibleError?.field === 'code' || visibleError?.kind === 'confirmationRequired';

  useEffect(() => {
    mounted.current = true;
    const field = input.current;
    return () => {
      mounted.current = false;
      // StrictMode reruns effects on the same DOM node. Clear the field only when it is detached.
      if (field && !field.isConnected) field.value = '';
    };
  }, []);

  function edit() {
    setMissing(false);
    setSubmitError(false);
    setDismissedError(error);
    onEdit?.();
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (waiting || submitLock.current || !onSubmit) return;
    const data = new FormData(event.currentTarget);
    const value = data.get('code');
    const code = typeof value === 'string' ? value : '';
    data.delete('code');
    if (code.trim() === '') {
      setMissing(true);
      setDismissedError(error);
      return;
    }

    setMissing(false);
    setSubmitError(false);
    submitLock.current = true;
    setSending(true);
    const field = input.current;
    const finish = () => {
      // A late response clears the submitted field even if the form has already unmounted.
      if (field) field.value = '';
      submitLock.current = false;
      if (mounted.current) setSending(false);
    };
    const failed = () => {
      if (mounted.current) setSubmitError(true);
    };
    try {
      void Promise.resolve(onSubmit(code)).catch(failed).finally(finish);
    } catch {
      failed();
      finish();
    }
  }

  return (
    <form className="auth-form" method="post" noValidate aria-busy={waiting}
      onSubmit={submit} onInput={edit}>
      <p className="auth-code-hint" id={hintId}>
        {challenge.contactHint ? t(($) => $.email.hintWithContact, { contact: challenge.contactHint })
          : t(($) => $.email.hint)}
      </p>
      <div className="auth-card">
        <div className="auth-field">
          <label htmlFor={inputId}>{t(($) => $.email.codeLabel)}</label>
          <input ref={input} id={inputId} name="code" type="text" placeholder={t(($) => $.email.codePlaceholder)}
            autoComplete="one-time-code" autoCapitalize="none" autoCorrect="off" spellCheck={false}
            enterKeyHint="go" required readOnly={waiting}
            aria-invalid={invalid || undefined} aria-describedby={hintId + ' ' + errorId} />
        </div>
      </div>
      <p className="auth-error" id={errorId} role="alert" hidden={!message}>{message}</p>
      <button className="auth-submit" type="submit" disabled={waiting || !onSubmit}>
        <AppIcon name="spinner" className={waiting ? 'auth-spinner' : 'auth-spinner is-hidden'} />
        <span aria-live="polite">{waiting ? t(($) => $.email.submitting) : t(($) => $.email.submit)}</span>
      </button>
    </form>
  );
}
