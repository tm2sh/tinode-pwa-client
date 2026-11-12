import { useState } from 'react';
import type { AvatarResource } from '../chat-list-types';
import '../../styles/chat-avatar.css';

interface ChatAvatarProps {
  readonly avatar: AvatarResource;
  readonly name: string;
  readonly className?: string;
  readonly imageOnly?: boolean;
}

export function ChatAvatar({ avatar, name, className = '', imageOnly = false }: ChatAvatarProps) {
  const image = avatar.state === 'ready' ? avatar.imageSource : undefined;
  const [failedImage, setFailedImage] = useState<string>();
  if (imageOnly && (!image || failedImage === image)) return null;
  const initial = Array.from(name.trim())[0]?.toUpperCase() ?? '';
  return (
    <span className={'chat-avatar ' + className} aria-hidden="true">
      {image && failedImage !== image
        ? <img src={image} alt="" decoding="async" onError={() => setFailedImage(image)} />
        : initial}
    </span>
  );
}
