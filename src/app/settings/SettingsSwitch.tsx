interface SettingsSwitchProps {
  readonly checked: boolean | undefined;
  readonly labelId: string;
  readonly descriptionId?: string;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly readOnly?: boolean;
  readonly onChange?: (checked: boolean) => void;
}

export function SettingsSwitch({ checked, labelId, descriptionId, disabled, busy, readOnly, onChange }: SettingsSwitchProps) {
  const known = checked !== undefined;
  const unavailable = disabled || !known || !onChange;
  // A temporary lock keeps the control in the tab order and preserves focus.
  const locked = unavailable || busy || readOnly;
  return <button type="button" className="settings-switch-target" disabled={unavailable}
    role={known ? 'switch' : undefined} aria-checked={checked} aria-disabled={locked || undefined}
    aria-labelledby={labelId} aria-describedby={descriptionId} aria-busy={busy || undefined}
    onClick={() => { if (!locked) onChange?.(!checked); }}>
    <span className={'settings-switch' + (checked ? ' is-on' : '')} aria-hidden="true">
      <span className="settings-switch-thumb" />
    </span>
  </button>;
}
