import { useEffect, useRef, useState } from 'react';
import { AppIcon } from '../../app/AppIcon';
import { useTranslation } from 'react-i18next';
import type { MediaLease } from '../../media/MediaResources';
import type { ConversationController } from '../ConversationController';
import type { PhotoAttachment } from '../conversation-types';

type PreviewState = { readonly preview: NonNullable<PhotoAttachment['preview']> } &
  ({ readonly kind: 'error' } | { readonly kind: 'ready'; readonly url: string });
export type OpenPhoto = (photo: PhotoAttachment, trigger: HTMLButtonElement) => void;

type LoadPreview = ConversationController['acquirePhotoPreview'];

export function PhotoIcon() {
  return <AppIcon name="photo" />;
}

export function PhotoPreview({ photo, loadPreview, onOpen }: { readonly photo: PhotoAttachment; readonly loadPreview: LoadPreview; readonly onOpen: OpenPhoto }) {
  const { t } = useTranslation('media');
  const box = useRef<HTMLButtonElement>(null);
  const lease = useRef<MediaLease>(undefined);
  const [loaded, setState] = useState<PreviewState>();
  const preview = photo.preview;
  const state = loaded?.preview === preview ? loaded : undefined;
  useEffect(() => {
    if (!preview || !box.current) return;
    const abort = new AbortController();
    let observer: IntersectionObserver | undefined;
    let started = false;
    const start = () => {
      if (started || abort.signal.aborted) return;
      started = true;
      observer?.disconnect();
      void loadPreview(preview, abort.signal).then(resource => {
        if (abort.signal.aborted) { resource.release(); return; }
        lease.current = resource;
        setState({ kind: 'ready', preview, url: resource.url });
      }, () => {
        if (!abort.signal.aborted) setState({ kind: 'error', preview });
      });
    };
    if (typeof IntersectionObserver === 'function') {
      observer = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) start();
      }, { rootMargin: '100px 0px' });
      observer.observe(box.current);
    } else start();
    return () => {
      observer?.disconnect();
      abort.abort();
      lease.current?.release();
      lease.current = undefined;
    };
  }, [loadPreview, preview]);
  const label = photo.filename ?? t($ => $.photo);
  const ratio = photo.dimensions.state === 'known'
    ? Math.min(2, Math.max(1, photo.dimensions.width / photo.dimensions.height)) : 4 / 3;
  return <button ref={box} type="button" aria-label={t($ => $.openPhoto)} disabled={photo.media.state !== 'available'} onClick={event => onOpen(photo, event.currentTarget)} className={'conversation-photo' + (preview ? ' has-preview' : '')} style={preview ? { aspectRatio: ratio } : undefined}>
    {preview && state?.kind === 'ready' ? <img src={state.url} alt={label} decoding="async" onError={() => {
      lease.current?.release();
      lease.current = undefined;
      setState({ kind: 'error', preview });
    }} /> : <span className="conversation-photo-placeholder">
      <PhotoIcon />
      <span>{label}</span>
      <small>{!preview ? t($ => $.previewMissing) : state?.kind === 'error' ? t($ => $.previewFailed) : t($ => $.previewLoading)}</small>
    </span>}
  </button>;
}
