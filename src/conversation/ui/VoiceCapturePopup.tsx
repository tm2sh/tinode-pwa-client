import { useEffect, useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { ErrorMessageCode } from '../../i18n/resources';

export function VoiceCapturePopup({ code, onClose }: { readonly code: ErrorMessageCode; readonly onClose: () => void }) {
  const { t } = useTranslation('media'), { t: errorT } = useTranslation('errors');
  const dialog = useRef<HTMLDialogElement>(null), title = useId(), description = useId();
  useEffect(() => {
    const node = dialog.current!, previous = document.activeElement;
    node.showModal();
    return () => { node.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  return <dialog ref={dialog} className="conversation-voice-popup" aria-labelledby={title} aria-describedby={description}
    onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div><h2 id={title}>{t($ => $.voice.popupTitle)}</h2><p id={description}>{errorT($ => $[code])}</p>
      <button type="button" autoFocus className="glass-control conversation-history-button" onClick={onClose}>{t($ => $.voice.closePopup)}</button></div>
  </dialog>;
}
