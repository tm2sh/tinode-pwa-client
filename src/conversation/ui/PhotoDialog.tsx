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
export function PhotoDialog({ controller, photo, album, returnFocus, onClose }: {
  readonly controller: ConversationController;
  readonly photo: PhotoAttachment;
  readonly album?: readonly PhotoAttachment[];
  readonly returnFocus: HTMLButtonElement;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation('media'), { t: commonT } = useTranslation('common');
  const photos = album?.length ? album : [photo];
  const [index, setIndex] = useState(Math.max(0, photos.indexOf(photo)));
  const current = photos[Math.min(index, photos.length - 1)]!;
  const pointer = useRef<{ x: number; y: number } | undefined>(undefined);
  const step = (delta: number) => setIndex(value => (value + delta + photos.length) % photos.length);
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
  return <dialog ref={dialog} className={"conversation-photo-dialog" + (photos.length > 1 ? " has-album" : "")} aria-label={t($ => $.viewerTitle)}
    onKeyDown={event => {
      if (photos.length < 2 || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); step(event.key === 'ArrowRight' ? 1 : -1); }
    }}
    onPointerDown={event => { if (photos.length > 1 && event.target instanceof HTMLImageElement) pointer.current = { x: event.clientX, y: event.clientY }; }}
    onPointerCancel={() => { pointer.current = undefined; }}
    onPointerUp={event => {
      const start = pointer.current; pointer.current = undefined;
      if (!start) return;
      const dx = event.clientX - start.x, dy = event.clientY - start.y;
      if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy)) step(dx < 0 ? 1 : -1);
    }}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <button autoFocus type="button" className="glass-control conversation-control conversation-photo-close"
      aria-label={t($ => $.close)} onClick={onClose}>
      <AppIcon name="close-wide" />
    </button>
    {photos.length > 1 && <>
      <span className="conversation-photo-position" role="status">{t($ => $.photoPosition, { current: index + 1, total: photos.length })}</span>
      <nav className="conversation-photo-navigation" aria-label={t($ => $.viewerTitle)}>
        <button type="button" className="glass-control conversation-control" aria-label={t($ => $.previousPhoto)} onClick={() => step(-1)}><AppIcon name="back" /></button>
        <button type="button" className="glass-control conversation-control" aria-label={t($ => $.nextPhoto)} onClick={() => step(1)}><AppIcon name="back" className="conversation-photo-next" /></button>
      </nav>
    </>}
    {Viewer ? <Viewer key={current.media.state === 'available' ? current.media.resourceId : index} controller={controller} photo={current} />
      : viewer.failed ? <div className="conversation-photo-viewer-status">
        <p role="alert">{t($ => $.viewerFailed)}</p>
        <button type="button" className="glass-control conversation-history-button" onClick={() => retry(value => value + 1)}>{commonT($ => $.retry)}</button>
      </div> : <PhotoLoading />}
  </dialog>;
}
