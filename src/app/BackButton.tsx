import { useTranslation } from 'react-i18next';
import { AppIcon } from './AppIcon';

export function BackButton({ onBack, className, disabled }: { readonly onBack: () => void; readonly className: string; readonly disabled?: boolean }) {
  const { t } = useTranslation('common');
  return <button type="button" className={className} aria-label={t($ => $.back)} onClick={onBack} disabled={disabled}>
    <AppIcon name="back" />
  </button>;
}
