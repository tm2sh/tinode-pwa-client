import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConversationController } from '../ConversationController';
import type { PhotoAttachment } from '../conversation-types';
import { PhotoPreview, PhotoIcon } from './PhotoPreview';
import type { OpenPhoto } from './PhotoPreview';
import '../../styles/photo-album.css';

function PhotoLayout({ count, children }: { readonly count: number; readonly children: ReactNode }) {
  const { t } = useTranslation('media');
  return <div className={count > 1 ? 'conversation-photo-album' : 'conversation-photo-single'}
    data-count={Math.min(count, 4)} role="group" aria-label={count > 1 ? t($ => $.photoCount, { count }) : t($ => $.photo)}>{children}</div>;
}
export function PhotoAlbum({ photos, loadPreview, onOpen }: { readonly photos: readonly PhotoAttachment[];
  readonly loadPreview: ConversationController['acquirePhotoPreview']; readonly onOpen: OpenPhoto }) {
  return <PhotoLayout count={photos.length}>{photos.slice(0, 4).map((photo, index) => <PhotoPreview
    key={photo.preview?.resourceId ?? (photo.media.state === 'available' ? photo.media.resourceId : index)}
    photo={photo} loadPreview={loadPreview} onOpen={onOpen} album={photos}
    extra={index === 3 ? Math.max(0, photos.length - 4) : 0} />)}</PhotoLayout>;
}
interface LocalPhoto { readonly filename: string; readonly preview?: string; readonly width?: number; readonly height?: number }
function LocalPreview({ photo, operationId, release, extra, single }: { readonly photo: LocalPhoto;
  readonly operationId: string; readonly release: ConversationController['releaseLocalPhotoPreview']; readonly extra: number; readonly single: boolean }) {
  const { t } = useTranslation('media');
  const element = useRef<HTMLSpanElement>(null);
  const preview = photo.preview;
  useEffect(() => {
    if (!preview) return;
    const node = element.current;
    return () => { queueMicrotask(() => { if (!node?.isConnected) release(operationId, preview); }); };
  }, [operationId, preview, release]);
  const ratio = photo.width && photo.height ? Math.min(4, Math.max(.25, photo.width / photo.height)) : 4 / 3;
  return <span ref={element} className="conversation-local-photo" style={single ? { aspectRatio: ratio } : undefined}>
    {preview ? <img src={preview} alt={photo.filename} draggable={false} /> : <span className="conversation-photo-placeholder"><PhotoIcon /><small>{t($ => $.preparing)}</small></span>}
    {extra > 0 && <span className="conversation-photo-more" aria-label={t($ => $.albumMore, { count: extra })}>+{extra}</span>}
  </span>;
}
export function LocalPhotoAlbum({ photos, operationId, release }: { readonly photos: readonly LocalPhoto[];
  readonly operationId: string; readonly release: ConversationController['releaseLocalPhotoPreview'] }) {
  return <PhotoLayout count={photos.length}>{photos.slice(0, 4).map((photo, index) => <LocalPreview key={index}
    photo={photo} operationId={operationId} release={release} single={photos.length === 1} extra={index === 3 ? Math.max(0, photos.length - 4) : 0} />)}</PhotoLayout>;
}
