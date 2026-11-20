import { useEffect, useId, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { AppIcon } from '../../app/AppIcon';
import type { ComponentProps } from 'react';
import { VoiceRecorder } from '../../media/VoiceRecorder';
import { VoiceCapturePopup } from './VoiceCapturePopup';
import { useTranslation } from 'react-i18next';
import type { ConversationController } from '../ConversationController';
import type { ConversationComposerState } from '../conversation-types';

function ComposerIcon(props: ComponentProps<typeof AppIcon>) {
  const variant = props.name === 'attachment' ? 'attachment-glass'
    : props.name === 'microphone' ? 'microphone-glass' : undefined;
  return <>
    <AppIcon {...props} className={[variant ? 'conversation-composer-icon-default' : '', props.className].filter(Boolean).join(' ') || undefined} />
    {variant && <AppIcon name={variant} size={props.size} className="conversation-composer-icon-glass" />}
  </>;
}

export function Composer({ controller, state, writable, active = true, onReconnect }: { readonly controller: ConversationController;
  readonly state?: ConversationComposerState; readonly writable: boolean; readonly active?: boolean; readonly onReconnect?: () => Promise<void> }) {
  const { t } = useTranslation('chat'), { t: errorT } = useTranslation('errors');
  const { t: mediaT } = useTranslation('media');
  const photoInput = useRef<HTMLInputElement>(null), messageInput = useRef<HTMLTextAreaElement>(null), activeRef = useRef(active);
  const edit = state?.edit, editTarget = edit?.serverSeq, editVersion = edit?.versionSeq;
  const editingId = useId(), editStatusId = useId();
  activeRef.current = active;
  const limit = controller.voiceLimit(), signal = controller.voiceSignal;
  const limitValue = limit.state === 'known' ? limit.value : undefined;
  const recorder = useMemo(() => new VoiceRecorder({ maxFileUploadSize: limitValue === undefined ? { state: 'unknown' } : { state: 'known', value: limitValue }, signal }), [limitValue, signal]);
  const capture = useSyncExternalStore(recorder.subscribe, recorder.getSnapshot, recorder.getSnapshot);
  const capturing = capture.phase !== 'idle' && capture.phase !== 'error';
  const popup = capture.phase === 'error' && (capture.error.messageCode === 'conversationCapturePermission' || capture.error.messageCode === 'conversationCaptureDeviceMissing' || capture.error.messageCode === 'conversationCaptureUnsupported') ? capture.error.messageCode : undefined;
  useEffect(() => () => recorder.cancel(), [recorder]);
  useLayoutEffect(() => { if (!active || editTarget !== undefined) recorder.cancel(); }, [active, editTarget, recorder]);
  useLayoutEffect(() => {
    if (editTarget === undefined || !active || !writable || capturing) return;
    const input = messageInput.current;
    input?.focus({ preventScroll: true });
    input?.setSelectionRange(input.value.length, input.value.length);
  }, [active, writable, capturing, editTarget, editVersion]);
  useEffect(() => { if (!writable) recorder.cancel(); }, [writable, recorder]);
  const uncertainId = useId(), composing = useRef(false), justComposed = useRef(false);
  const reset = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const text = edit?.text ?? state?.text ?? '';
  const hasText = !!text.trim();
  const blocked = !active || !writable || !!state?.pending || !!state?.uncertain;
  const canSaveEdit = !!edit && !blocked && !edit.stale && hasText && text !== edit.originalText;
  const editOperation = state?.editOperation, editPhase = editOperation?.phase;
  const editError = editOperation?.phase === 'rejected' ? editOperation.error : edit ? state?.error : undefined;
  const savingEdit = editPhase === 'preparing' || editPhase === 'publishing';
  const unknownEdit = editPhase === 'unknown';
  const checkingEdit = unknownEdit && state?.verification?.state === 'checking';
  const reconnectEdit = unknownEdit && state?.verification?.state === 'failed' && !state.verification.error.retryable && !!onReconnect;
  const editLocked = savingEdit || unknownEdit;
  const editStatus = unknownEdit ? t($ => $.composer.editUnknown)
    : edit?.stale ? t($ => $.composer.editStale)
      : savingEdit ? t($ => $.composer.editSaving)
        : editError ? errorT($ => $[editError.messageCode], editError.messageParams) : undefined;
  const canSendNewMessage = () => {
    const current = controller.getSnapshot();
    return activeRef.current && !signal.aborted && current.phase === 'ready' && !current.composer.edit;
  };
  const compositionBoundary = () => { justComposed.current = true; clearTimeout(reset.current); reset.current = setTimeout(() => { justComposed.current = false; }, 0); };
  useEffect(() => () => clearTimeout(reset.current), []);
  const sendVoice = () => {
    if (!canSendNewMessage() || blocked || capture.phase !== 'ready') return;
    const file = recorder.takeRecording();
    if (file) void controller.submitVoice(file);
  };
  useEffect(() => {
    const current = controller.getSnapshot();
    if (!activeRef.current || signal.aborted || current.phase !== 'ready' || current.composer.edit ||
      capture.phase !== 'ready' || capture.stoppedBy !== 'sizeLimit' || blocked) return;
    const file = recorder.takeRecording();
    if (file) void controller.submitVoice(file);
  }, [capture, blocked, recorder, controller, signal]);
  const seconds = 'durationMs' in capture ? Math.floor(capture.durationMs / 1000) : 0;
  const time = Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
  const submit = () => {
    if (!activeRef.current || capturing || composing.current || justComposed.current) return;
    if (unknownEdit) {
      if (reconnectEdit) void onReconnect?.();
      else if (state?.canVerify) void controller.reconcileText();
    } else if (hasText && !blocked) {
      if (edit) void controller.submitMessageEdit();
      else void controller.submitText();
    }
  };
  return <>
    {state?.uncertain && <p id={uncertainId} className="conversation-visually-hidden">{errorT($ => $.conversationSendUnknown)}</p>}
    {!writable && state && <p className="conversation-readonly">{errorT($ => $.conversationWriteDenied)}</p>}
    {!edit && state?.error && <p className="conversation-composer-error" role="alert">{errorT($ => $[state.error!.messageCode], state.error.messageParams)}</p>}
    {editStatus && <p className="conversation-edit-status" id={editStatusId} role={edit?.stale || editPhase === 'rejected' ? 'alert' : 'status'}>{editStatus}</p>}
    <form className="conversation-composer" aria-label={t($ => $.a11y.controls)} onSubmit={event => { event.preventDefault(); submit(); }}>
      <input ref={photoInput} type="file" hidden accept="image/*,.heic,.heif" multiple
        onChange={event => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = '';
          if (files.length && canSendNewMessage() && !blocked && !capturing) void controller.submitPhotos(files);
        }} />
      <button className="conversation-control" type="button" disabled={edit ? !active || editLocked : blocked && !capturing}
        aria-label={edit ? t($ => $.composer.cancelEdit) : capturing ? mediaT($ => $.voice.cancel) : mediaT($ => $.choosePhoto)}
        onPointerDown={event => { if (edit && document.activeElement === messageInput.current) event.preventDefault(); }}
        onClick={() => {
          if (edit) { controller.cancelMessageEdit(); messageInput.current?.focus({ preventScroll: true }); }
          else if (capturing) recorder.cancel();
          else photoInput.current?.click();
        }}>
        <ComposerIcon name={edit || capturing ? 'close' : 'attachment'} />
      </button>
      <div className="conversation-message-field">{capturing ? <div className="conversation-capture-status" role="status">
        <span className={capture.phase === 'recording' ? 'conversation-recording-dot' : undefined} aria-hidden="true" />
        <span>{capture.phase === 'requesting' ? mediaT($ => $.voice.requesting) : capture.phase === 'finalizing' ? mediaT($ => $.voice.finalizing)
          : capture.phase === 'ready' ? mediaT($ => $.voice.ready) : mediaT($ => $.voice.recording)}</span>
        {'durationMs' in capture && <time aria-label={mediaT($ => $.voice.elapsed, { time })}>{time}</time>}
      </div> : <div className="conversation-message-editor" data-editing={!!edit || undefined}>
        {edit && <div className="conversation-edit-label" id={editingId}>{t($ => $.composer.editing)}</div>}
        <div className="conversation-message-measure" aria-hidden="true">{text}{' '}</div>
        <textarea ref={messageInput} name="message" rows={1} wrap="soft" value={text} disabled={!writable || !active} readOnly={editLocked}
          placeholder={t($ => $.message)} aria-label={t($ => $.message)} autoComplete="off" enterKeyHint="enter"
          aria-describedby={edit ? editStatus ? editingId + ' ' + editStatusId : editingId : undefined}
          onChange={event => {
            if (edit) controller.setMessageEdit(event.currentTarget.value);
            else controller.setDraft(event.currentTarget.value);
          }}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; compositionBoundary(); }} />
      </div>}</div>
      <button className={'conversation-control' + (edit || (!capturing && hasText) || (capture.phase === 'ready' || capture.phase === 'recording') ? ' conversation-send' : '')}
        type={edit || (!capturing && hasText) ? 'submit' : 'button'}
        disabled={edit ? unknownEdit ? !active || (!reconnectEdit && !state?.canVerify) : !canSaveEdit : blocked || capture.phase === 'finalizing' || capture.phase === 'requesting'}
        aria-label={edit ? unknownEdit ? t($ => $.composer.checkEdit) : t($ => $.composer.saveEdit) : capture.phase === 'recording' || capture.phase === 'ready' ? mediaT($ => $.voice.send)
          : hasText ? t($ => $.composer.send) : mediaT($ => $.voice.record)} aria-busy={capture.phase === 'finalizing' || !!state?.pending}
        aria-describedby={state?.uncertain ? uncertainId : undefined} onPointerDown={event => event.preventDefault()}
        onClick={() => { if (edit) return;
          if (capture.phase === 'recording') void recorder.stop().then(() => { if (!canSendNewMessage()) { recorder.cancel(); return; } const file = recorder.takeRecording(); if (file) void controller.submitVoice(file); }); else if (capture.phase === 'ready') sendVoice();
          else if (!hasText && !blocked && canSendNewMessage()) void recorder.start(); }}>
        <ComposerIcon name={savingEdit || checkingEdit ? 'spinner' : edit ? 'send' : capture.phase === 'finalizing' || capture.phase === 'requesting'
          ? 'recording-pending' : hasText || capture.phase === 'ready' || capture.phase === 'recording'
            ? 'send' : 'microphone'} className={savingEdit || checkingEdit ? 'auth-spinner' : undefined} />
      </button>
    </form>
    {capture.phase === 'error' && !popup && <p className="conversation-composer-error" role="alert">{errorT($ => $[capture.error.messageCode])}</p>}
    {popup && <VoiceCapturePopup code={popup} onClose={recorder.cancel} />}
  </>;
}
