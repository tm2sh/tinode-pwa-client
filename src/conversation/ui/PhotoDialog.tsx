import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AppIcon } from '../../app/AppIcon';
import type { ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConversationController } from '../ConversationController';
import type { PhotoAttachment } from '../conversation-types';
import type { PhotoViewerProps } from './PhotoViewer';

function PhotoLoading() {
  const { t } = useTranslation('media');
  return <div className="conversation-photo-viewer-status" role="status">
    <AppIcon name="spinner" className="auth-spinner" />
    <p>{t($ => $.viewerLoading)}</p>
  </div>;
}

// Only the modal shell is part of the chat chunk. Image loading and styles are deferred.
export function PhotoDialog({ controller, photo, returnFocus, onClose }: {
  readonly controller: ConversationController;
  readonly photo: PhotoAttachment;
  readonly returnFocus: HTMLButtonElement;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation('media'), { t: commonT } = useTranslation('common');
  const dialog = useRef<HTMLDialogElement>(null);
  const [attempt, retry] = useState(0);
  const [viewer, setViewer] = useState<{ readonly component?: ComponentType<PhotoViewerProps>; readonly failed?: boolean }>({});
  useLayoutEffect(() => {
    const node = dialog.current;
    const history = returnFocus.closest<HTMLElement>('.conversation-history');
    node?.showModal();
    return () => {
      node?.close();
      if (returnFocus.isConnected) returnFocus.focus({ preventScroll: true });
      else if (history?.isConnected) history.focus({ preventScroll: true });
    };
  }, [returnFocus]);
  useEffect(() => {
    let current = true;
    setViewer({});
    void import('./PhotoViewer').then(module => {
      if (current) setViewer({ component: module.default });
    }, () => {
      if (current) setViewer({ failed: true });
    });
    return () => { current = false; };
  }, [attempt]);
  const Viewer = viewer.component;
  return <dialog ref={dialog} className="conversation-photo-dialog" aria-label={t($ => $.viewerTitle)}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <button autoFocus type="button" className="conversation-control conversation-photo-close"
      aria-label={t($ => $.close)} onClick={onClose}>
      <AppIcon name="close-wide" />
    </button>
    {Viewer ? <Viewer controller={controller} photo={photo} />
      : viewer.failed ? <div className="conversation-photo-viewer-status">
        <p role="alert">{t($ => $.viewerFailed)}</p>
        <button type="button" className="conversation-history-button" onClick={() => retry(value => value + 1)}>{commonT($ => $.retry)}</button>
      </div> : <PhotoLoading />}
  </dialog>;
}
