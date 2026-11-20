import { useId, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChatInfoError } from '../chat-info-types';

interface MemberRemovalDialogProps {
  readonly name: string;
  readonly trigger: HTMLButtonElement;
  readonly fallback: HTMLHeadingElement | null;
  readonly onClose: () => void;
  readonly onConfirm: () => Promise<ChatInfoError | undefined>;
}

export function MemberRemovalDialog({ name, trigger, fallback, onClose, onConfirm }: MemberRemovalDialogProps) {
  const { t } = useTranslation('chatInfo');
  const { t: commonT } = useTranslation('common');
  const { t: errorT } = useTranslation('errors');
  const dialog = useRef<HTMLDialogElement>(null);
  const waiting = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ChatInfoError>();
  const titleId = useId();

  useLayoutEffect(() => {
    const node = dialog.current;
    if (!node) return;
    node.showModal();
    return () => {
      node.close();
      if (trigger.isConnected && !trigger.disabled) trigger.focus({ preventScroll: true });
      else if (fallback?.isConnected) fallback.focus({ preventScroll: true });
    };
  }, [trigger, fallback]);

  const confirm = async () => {
    if (waiting.current) return;
    waiting.current = true;
    setError(undefined);
    setPending(true);
    const problem = await onConfirm();
    waiting.current = false;
    setPending(false);
    if (problem) setError(problem);
    else onClose();
  };

  return <dialog ref={dialog} className="chat-info-remove-dialog" aria-labelledby={titleId} aria-busy={pending}
    onCancel={event => { event.preventDefault(); if (!waiting.current) onClose(); }}
    onClick={event => { if (event.target === event.currentTarget && !waiting.current) onClose(); }}>
    <div className="chat-info-remove-content">
      <h2 id={titleId} className="chat-info-remove-title">{t($ => $.members.removeConfirm, { name })}</h2>
      {error && <div className="chat-info-error"><p role="alert">{errorT($ => $[error.messageCode])}</p></div>}
      <div className="chat-info-remove-actions">
        <button type="button" className="glass-control" disabled={pending} autoFocus onClick={onClose}>{commonT($ => $.cancel)}</button>
        <button type="button" className="glass-control glass-control-danger is-destructive" disabled={pending || error?.retryable === false}
          onClick={() => { void confirm(); }}>
          {pending ? t($ => $.members.removing) : t($ => $.members.removeAction)}
        </button>
      </div>
    </div>
  </dialog>;
}
