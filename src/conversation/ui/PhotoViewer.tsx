import { useEffect, useRef, useState } from 'react';
import { AppIcon } from '../../app/AppIcon';
import { useTranslation } from 'react-i18next';
import { MediaFailure } from '../../media/MediaResources';
import type { MediaLease } from '../../media/MediaResources';
import type { ConversationController } from '../ConversationController';
import type { PhotoAttachment } from '../conversation-types';
import '../../styles/media-viewer.css';

export interface PhotoViewerProps {
  readonly controller: ConversationController;
  readonly photo: PhotoAttachment;
}
type State = { readonly kind: 'loading' } | { readonly kind: 'ready'; readonly url: string } |
  { readonly kind: 'failed'; readonly reason?: MediaFailure['reason'] };

export default function PhotoViewer({ controller, photo }: PhotoViewerProps) {
  const { t } = useTranslation('media'), { t: commonT } = useTranslation('common'), { t: errorT } = useTranslation('errors');
  const image = useRef<HTMLImageElement>(null);
  const resource = useRef<MediaLease>(undefined);
  const [attempt, retry] = useState(0);
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [decoded, setDecoded] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    const node = image.current;
    setState({ kind: 'loading' });
    setDecoded(false);
    void controller.acquirePhoto(photo, abort.signal).then(lease => {
      if (abort.signal.aborted) { lease.release({ discard: true }); return; }
      resource.current = lease;
      setState({ kind: 'ready', url: lease.url });
    }, (reason: unknown) => {
      if (!abort.signal.aborted) setState({ kind: 'failed', reason: reason instanceof MediaFailure ? reason.reason : undefined });
    });
    return () => {
      abort.abort();
      // Detach the decoder before releasing a URL still referenced by an image element.
      node?.removeAttribute('src');
      resource.current?.release({ discard: true });
      resource.current = undefined;
    };
  }, [controller, photo, attempt]);

  const failed = () => {
    if (!resource.current || image.current?.getAttribute('src') !== resource.current.url) return;
    image.current?.removeAttribute('src');
    resource.current?.release({ discard: true });
    resource.current = undefined;
    setState({ kind: 'failed' });
  };
  const message = state.kind === 'failed' && state.reason === 'tooLarge' ? errorT($ => $.conversationMediaTooLarge)
    : state.kind === 'failed' && state.reason === 'unsupported' ? errorT($ => $.conversationMediaUnsupported) : t($ => $.viewerFailed);
  return <div className="conversation-photo-viewer">
    <img ref={image} className={decoded ? 'is-decoded' : ''} src={state.kind === 'ready' ? state.url : undefined}
      alt={photo.filename ?? t($ => $.photo)} draggable={false} decoding="async" onLoad={event => {
        const node = event.currentTarget;
        if (node.getAttribute('src') !== resource.current?.url) return;
        if (!node.naturalWidth || !node.naturalHeight || node.naturalWidth * node.naturalHeight > 25_000_000) failed();
        else setDecoded(true);
      }} onError={failed} />
    {state.kind === 'failed' ? <div className="conversation-photo-viewer-status">
      <p role="alert">{message}</p>
      <button type="button" className="conversation-history-button" onClick={() => retry(value => value + 1)}>{commonT($ => $.retry)}</button>
    </div> : !decoded && <div className="conversation-photo-viewer-status" role="status">
      <AppIcon name="spinner" className="auth-spinner" />
      <p>{t($ => $.viewerLoading)}</p>
    </div>}
  </div>;
}
