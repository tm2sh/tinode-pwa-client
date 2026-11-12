import { createElement, Fragment, useCallback, useEffect, useRef } from 'react';
import { AppIcon } from '../../app/AppIcon';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConversationController } from '../ConversationController';
import type { OpenPhoto } from './PhotoPreview';
import { PhotoIcon, PhotoPreview } from './PhotoPreview';
import type { ConversationMessageView } from '../conversation-presenter';
import type { ConversationOutgoingReadStatus } from '../conversation-read-status';
import type { ConversationAttachment, ConversationText, ConversationOutgoingOperation, ConversationOutgoing, ConversationVerification, ConversationSearchRange } from '../conversation-types';
import { VoiceMessage } from './VoiceMessage';
import type { LoadVoice } from './VoiceMessage';
import { ChatAvatar } from '../../chats/ui/ChatAvatar';

type TextSpan = ConversationText['spans'][number];
interface SpanNode { readonly span: TextSpan; readonly children: SpanNode[] }
function messageText(value: ConversationText, hits: readonly ConversationSearchRange[] = []): ReactNode {
  const roots: SpanNode[] = [], stack: SpanNode[] = [];
  for (const span of [...value.spans].sort((a, b) => a.start - b.start || b.length - a.length)) {
    const node: SpanNode = { span, children: [] };
    while (stack.length && (span.start >= stack.at(-1)!.span.start + stack.at(-1)!.span.length ||
      span.start + span.length > stack.at(-1)!.span.start + stack.at(-1)!.span.length)) stack.pop();
    (stack.at(-1)?.children ?? roots).push(node); stack.push(node);
  }
  let hitIndex = 0;
  // Traverse the original text in order because a match can span a formatting or link boundary.
  function appendText(result: ReactNode[], start: number, end: number) {
    let cursor = start;
    while (cursor < end && hitIndex < hits.length) {
      const hit = hits[hitIndex]!, hitEnd = hit.start + hit.length;
      if (hitEnd <= cursor) { hitIndex++; continue; }
      if (hit.start >= end) break;
      const from = Math.max(cursor, hit.start), to = Math.min(end, hitEnd);
      if (from > cursor) result.push(value.text.slice(cursor, from));
      result.push(<mark className="conversation-search-hit" key={'hit-' + from}>{value.text.slice(from, to)}</mark>);
      cursor = to;
    }
    if (cursor < end) result.push(value.text.slice(cursor, end));
  }
  function render(start: number, end: number, nodes: readonly SpanNode[]): ReactNode[] {
    const result: ReactNode[] = []; let cursor = start;
    for (const { span, children } of nodes) {
      if (span.start < cursor || span.start + span.length > end) continue;
      appendText(result, cursor, span.start);
      const content = render(span.start, span.start + span.length, children);
      const key = span.start + ':' + span.length + ':' + span.kind;
      result.push(span.kind === 'link'
        ? <a key={key} href={span.url} target="_blank" rel="noopener noreferrer">{content}</a>
        : createElement(span.kind === 'bold' ? 'strong' : span.kind === 'italic' ? 'em' : span.kind === 'strike' ? 's'
          : span.kind === 'code' ? 'code' : span.kind === 'highlight' ? 'mark' : 'span',
        { key, className: span.kind === 'quote' ? 'conversation-quote' : undefined }, content));
      cursor = span.start + span.length;
    }
    appendText(result, cursor, end);
    return result;
  }
  return render(0, value.text.length, roots);
}
function authorColor(uid: string | undefined): number {
  let hash = 0; for (const char of uid ?? '') hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return Math.abs(hash % 4);
}
function Attachment({ attachment }: { readonly attachment: Exclude<ConversationAttachment, { kind: 'photo' }> }) {
  const { t } = useTranslation('chat');
  const title = attachment.kind === 'voice' ? t($ => $.attachment.voice)
    : attachment.contentType === 'video' ? t($ => $.attachment.video) : attachment.contentType === 'file' ? t($ => $.attachment.file)
      : attachment.contentType === 'form' ? t($ => $.attachment.form) : t($ => $.attachment.unknown);
  const duration = attachment.kind === 'voice' && attachment.durationMs.state === 'known'
    ? Math.floor(attachment.durationMs.value / 60_000) + ':' + String(Math.floor(attachment.durationMs.value / 1000) % 60).padStart(2, '0') : undefined;
  return <div className="conversation-attachment">
    <AppIcon name={attachment.kind === 'voice' ? 'microphone' : 'file'} />
    <div><strong>{title}</strong>{attachment.filename && (attachment.kind !== 'unsupported' || attachment.contentType === 'file' || attachment.contentType === 'video') && <span>{attachment.filename}</span>}
      {duration !== undefined && <span>{t($ => $.attachment.duration, { duration })}</span>}
      <small>{attachment.kind === 'unsupported' ? t($ => $.attachment.unsupported) : t($ => $.attachment.voiceLater)}</small></div>
  </div>;
}
function OutgoingVerificationError({ verification }: { readonly verification: Extract<ConversationVerification, { state: 'failed' }> }) {
  const { t } = useTranslation('errors');
  return <p className="conversation-composer-error" role="alert">{t($ => $[verification.error.messageCode], verification.error.messageParams)}</p>;
}
function OutgoingStatus({ operation }: { readonly operation: ConversationOutgoingOperation }) {
  const { t } = useTranslation('chat'), { t: errorT } = useTranslation('errors');
  return <span className={'conversation-send-status is-' + operation.phase} role={operation.phase === 'rejected' || operation.phase === 'unknown' ? 'alert' : 'status'}>
    {operation.phase === 'rejected' ? errorT($ => $[operation.error.messageCode], operation.error.messageParams)
      : operation.phase === 'unknown' ? errorT($ => $.conversationSendUnknown)
        : operation.phase === 'confirmed' ? t($ => $.composer.confirmed) : t($ => $.composer.pending)}
  </span>;
}
export function OutgoingBubble({ row, retryDisabled, onRetry, releasePreview, loadVoice, voiceSignal, verification, reconnect }: { readonly row: ConversationOutgoing;
  readonly retryDisabled: boolean; readonly verification?: ConversationVerification; readonly reconnect: boolean; readonly onRetry: (operationId: string) => void;
  readonly releasePreview: ConversationController['releaseLocalPhotoPreview']; readonly loadVoice: LoadVoice; readonly voiceSignal: AbortSignal }) {
  const { t } = useTranslation('chat'), { t: mediaT } = useTranslation('media');
  const photo = row.photo, voice = row.voice, phase = row.operation.phase;
  const canRetry = phase === 'unknown' || (phase === 'rejected' && (row.text !== undefined || voice?.canRetry));
  const checking = verification?.state === 'checking';
  const actionLabel = phase !== 'unknown' ? t($ => $.composer.retry) : reconnect ? t($ => $.state.reconnect)
    : checking ? t($ => $.composer.checking) : verification ? t($ => $.composer.checkAgain) : t($ => $.composer.check);
  const progress = photo?.uploadProgress;
  const preview = photo?.preview;
  const image = useRef<HTMLImageElement>(null);
  useEffect(() => {
    if (!preview) return;
    const element = image.current;
    return () => {
      // StrictMode replays effects while keeping the image mounted.
      queueMicrotask(() => {
        if (!element?.isConnected || element.getAttribute('src') !== preview) {
          releasePreview(row.operation.operationId, preview);
        }
      });
    };
  }, [preview, row.operation.operationId, releasePreview]);
  return <li className={'conversation-item is-outgoing series-single conversation-local-message' + (canRetry ? ' has-send-error' : '')} data-outgoing-id={row.operation.operationId}>
    <div className="conversation-row">
      {canRetry && <button type="button" className="conversation-send-retry" disabled={retryDisabled}
        aria-label={actionLabel} title={actionLabel} aria-busy={checking} onPointerDown={event => event.preventDefault()}
        onClick={() => onRetry(row.operation.operationId)}>
        <span aria-hidden="true">{checking
          ? <AppIcon name="spinner" className="auth-spinner" />
          : <AppIcon name="error" />}</span>
      </button>}
      <article className="conversation-bubble" aria-label={t($ => $.fallback.self)}>
        {photo && preview && <img ref={image} className="conversation-outgoing-preview" src={preview}
          alt={photo.filename || mediaT($ => $.photo)} draggable={false} />}
        {photo ? <div className="conversation-attachment conversation-outgoing-photo">
          <PhotoIcon /><div><strong>{photo.filename || mediaT($ => $.photo)}</strong>
            {phase === 'preparing' && (progress === undefined ? <small role="status">{mediaT($ => $.preparing)}</small>
              : <><small>{mediaT($ => $.uploading)} · {Math.round(progress * 100)}%</small>
                <progress max={1} value={progress} aria-label={mediaT($ => $.uploading)} /></>)}
            {phase === 'publishing' && <small role="status">{mediaT($ => $.publishing)}</small>}
          </div>
        </div> : voice ? <>
          {voice.attachment.media.state === 'available' ? <VoiceMessage voice={voice.attachment} loadVoice={loadVoice} signal={voiceSignal} />
            : <span>{t($ => $.attachment.voice)}</span>}

        </> : <div className="conversation-copy">{row.text}</div>}
        {(!photo || phase === 'rejected' || phase === 'unknown') && <div className="conversation-time"><OutgoingStatus operation={row.operation} /></div>}
        {verification?.state === 'unconfirmed' && <span role="status" className="conversation-visually-hidden">{t($ => $.composer.notConfirmed)}</span>}
        {verification?.state === 'failed' && <OutgoingVerificationError verification={verification} />}
    </article></div>
  </li>;
}
interface MessageBubbleProps {
  readonly item: ConversationMessageView;
  readonly onOpenPhoto: OpenPhoto;
  readonly loadPreview: ConversationController['acquirePhotoPreview'];
  readonly loadVoice: LoadVoice;
  readonly voiceSignal: AbortSignal;
  readonly personal: boolean;
  readonly outgoing?: ConversationOutgoingOperation;
  readonly readStatus?: ConversationOutgoingReadStatus;
  readonly searchHits?: readonly ConversationSearchRange[];
  readonly activeSearchMatch?: boolean;
  readonly peerName: string;
  readonly position: number;
  readonly total: number;
  readonly onRef: (seq: number, row: HTMLLIElement | null) => void;
  readonly leading?: ReactNode;
  readonly trailing?: ReactNode;
}
export function MessageBubble({ item, loadPreview, onOpenPhoto, loadVoice, voiceSignal, personal, peerName, position, total, onRef, leading, trailing, outgoing, readStatus, searchHits, activeSearchMatch }: MessageBubbleProps) {
  const { t } = useTranslation('chat');
  const { message } = item;
  const author = message.sender.state === 'self' ? t($ => $.fallback.self)
    : message.sender.state === 'other' && message.sender.displayName.state === 'known' ? message.sender.displayName.text
      : personal ? peerName : t($ => $.fallback.sender);
  const rowRef = useCallback((row: HTMLLIElement | null) => onRef(item.key, row), [item.key, onRef]);
  const time = item.time.state === 'known' ? item.time.text : t($ => $.time.unknown);
  return <li ref={rowRef} data-message-seq={item.key} className={'conversation-item is-' + item.side + ' series-' + item.series + (personal ? ' is-personal' : '')}
    aria-posinset={position} aria-setsize={total}>
    {leading}
    {item.dateSeparator && <div className="conversation-date"><span>{item.dateSeparator.state === 'known' ? item.dateSeparator.text : t($ => $.time.unknownDate)}</span></div>}
    <div className={'conversation-row conversation-author-' + authorColor(message.sender.uid)}>
      {!personal && item.side === 'incoming' && <span className="conversation-sender-avatar" aria-hidden="true">
        {item.showSenderAvatar && <ChatAvatar name={author} avatar={message.sender.state === 'other' ? message.sender.avatar : { state: 'unavailable' }} />}
      </span>}
      <article className={activeSearchMatch ? "conversation-bubble conversation-search-current" : "conversation-bubble"}
        data-message-action-seq={message.delivery === 'serverConfirmed' ? item.key : undefined}
        tabIndex={message.delivery === 'serverConfirmed' ? 0 : undefined}
        aria-keyshortcuts={message.delivery === 'serverConfirmed' ? 'ContextMenu Shift+F10' : undefined}
        aria-label={t($ => $.a11y.message, { author, time })}>
        {item.showSenderName && <div className="conversation-author-name">{author}</div>}
        {message.content.text.text && <div className="conversation-copy">{messageText(message.content.text, searchHits)}</div>}
        {message.content.attachments.map((attachment, index) => attachment.kind === 'photo'
          ? <PhotoPreview key={attachment.preview?.resourceId ?? attachment.media.state + index} photo={attachment} loadPreview={loadPreview} onOpen={onOpenPhoto} />
          : attachment.kind === 'voice' ? <VoiceMessage key={index} voice={attachment} loadVoice={loadVoice} signal={voiceSignal} />
            : <Fragment key={index}><Attachment attachment={attachment} /></Fragment>)}
        {!message.content.text.text && message.content.attachments.length === 0 && <div className="conversation-copy">{t($ => $.attachment.empty)}</div>}
        <div className="conversation-time">
          {outgoing && !readStatus && <OutgoingStatus operation={outgoing} />}
          {item.edited && <time className="conversation-edited" dateTime={item.edited.dateTime}>{t($ => $.time.edited, { when: item.edited.text })}</time>}
          <span className="conversation-timestamp">
            {item.time.state === 'known' ? <time dateTime={item.time.dateTime}>{time}</time> : <span>{time}</span>}
            {readStatus && <span className={'conversation-read-status is-' + readStatus} role="img"
              aria-label={readStatus === 'read' ? t($ => $.time.read) : t($ => $.time.sent)}>
              <AppIcon name={readStatus === 'read' ? 'double-check' : 'check'} size={16} />
            </span>}
          </span>
        </div>
      </article>
    </div>
    {trailing}
  </li>;
}
