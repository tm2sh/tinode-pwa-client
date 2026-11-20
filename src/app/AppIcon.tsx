import iconSprite from '../assets/ui-icons.svg?no-inline';

type AppIconName = 'spinner' | 'back' | 'logout' | 'eye' | 'eye-off' | 'search' |
  'plus' | 'close' | 'close-wide' | 'attachment' | 'microphone' | 'attachment-glass' | 'microphone-glass' | 'back-glass' | 'search-glass' | 'plus-glass' | 'recording-pending' | 'send' |
  'down' | 'up' | 'photo' | 'file' | 'error' | 'play' | 'pause' | 'bell' | 'muted' | 'copy' | 'link' | 'edit' | 'trash' | 'check' | 'double-check';

const glassVariants: Partial<Record<AppIconName, AppIconName>> = {
  attachment: 'attachment-glass', microphone: 'microphone-glass',
  back: 'back-glass', search: 'search-glass', plus: 'plus-glass',
};

interface AppIconProps {
  readonly name: AppIconName;
  readonly className?: string;
  readonly size?: number;
}

export function AppIcon({ name, className, size }: AppIconProps) {
  const variant = glassVariants[name];
  const classes = [className, name === 'attachment' || name === 'microphone' ? 'app-icon-composer' : undefined].filter(Boolean).join(' ') || undefined;
  return <svg className={classes} width={size} height={size} viewBox="0 0 24 24"
    fill="none" aria-hidden="true" focusable="false">
    <use className={variant ? 'app-icon-default' : undefined} href={iconSprite + '#' + name} />
    {variant && <use className="app-icon-glass" href={iconSprite + '#' + variant} />}
  </svg>;
}
