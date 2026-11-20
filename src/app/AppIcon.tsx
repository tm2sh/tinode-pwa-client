import iconSprite from '../assets/ui-icons.svg?no-inline';

type AppIconName = 'spinner' | 'back' | 'logout' | 'eye' | 'eye-off' | 'search' |
  'plus' | 'close' | 'close-wide' | 'attachment' | 'microphone' | 'attachment-glass' | 'microphone-glass' | 'recording-pending' | 'send' |
  'down' | 'up' | 'photo' | 'file' | 'error' | 'play' | 'pause' | 'bell' | 'muted' | 'copy' | 'link' | 'edit' | 'trash' | 'check' | 'double-check';

interface AppIconProps {
  readonly name: AppIconName;
  readonly className?: string;
  readonly size?: number;
}

export function AppIcon({ name, className, size }: AppIconProps) {
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24"
    fill="none" aria-hidden="true" focusable="false">
    <use href={iconSprite + '#' + name} />
  </svg>;
}
