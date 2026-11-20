import { BackButton } from '../BackButton';

interface SettingsHeaderProps {
  readonly title: string;
  readonly titleId: string;
  readonly onBack: () => void;
  readonly backDisabled?: boolean;
  readonly action?: {
    readonly label: string;
    readonly disabled?: boolean;
    readonly onClick: () => void;
  };
}

const maxActionLabelCharacters = 12;
let actionLabelSegmenter: Intl.Segmenter | undefined;

function shortenActionLabel(label: string): string {
  if (label.length <= maxActionLabelCharacters) return label;
  if (typeof Intl.Segmenter === 'function') {
    actionLabelSegmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  }
  const characters = actionLabelSegmenter
    ? Array.from(actionLabelSegmenter.segment(label), ({ segment }) => segment)
    : Array.from(label);
  return characters.length > maxActionLabelCharacters
    ? characters.slice(0, maxActionLabelCharacters).join('').trimEnd() + '…'
    : label;
}

export function SettingsHeader({ title, titleId, onBack, backDisabled, action }: SettingsHeaderProps) {
  return <header className="settings-header">
    <BackButton className="settings-back" onBack={onBack} disabled={backDisabled} />
    <h1 id={titleId}>{title}</h1>
    {action && <button type="button" className="glass-control settings-header-action" aria-label={action.label}
      disabled={action.disabled} onClick={action.onClick}><span>{shortenActionLabel(action.label)}</span></button>}
  </header>;
}
