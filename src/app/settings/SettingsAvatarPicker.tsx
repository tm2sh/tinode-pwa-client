import { useEffect, useRef, useState } from 'react';
import type { AvatarImageSource, AvatarResource } from '../../chats/chat-list-types';
import type { ErrorMessageCode } from '../../i18n/resources';
import type { PreparedAvatar } from '../../media/AvatarPreparation';
import type { ServerLimit } from '../../media/MediaResources';
import { SettingsAvatar } from './SettingsAvatar';

interface SettingsAvatarPickerProps {
  readonly name: string;
  readonly avatar: AvatarResource;
  readonly draft?: PreparedAvatar;
  readonly topicKey: string;
  readonly creationTitle?: string;
  readonly maxMessageSize?: ServerLimit;
  readonly disabled: boolean;
  readonly chooseLabel: string;
  readonly preparingLabel: string;
  readonly errorText: (code: ErrorMessageCode) => string;
  readonly onChoose: (avatar: PreparedAvatar) => void;
  readonly onPreparing: (preparing: boolean) => void;
  readonly remove?: { readonly label: string; readonly onClick: () => void };
}

export function SettingsAvatarPicker({ name, avatar, draft, topicKey, creationTitle, maxMessageSize, disabled, chooseLabel,
  preparingLabel, errorText, onChoose, onPreparing, remove }: SettingsAvatarPickerProps) {
  const picker = useRef<HTMLInputElement>(null);
  const preparation = useRef<AbortController | undefined>(undefined);
  const [preview, setPreview] = useState<{ candidate: PreparedAvatar; source: AvatarImageSource }>();
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<ErrorMessageCode>();

  useEffect(() => () => {
    preparation.current?.abort();
    preparation.current = undefined;
  }, []);
  useEffect(() => {
    if (!draft) {
      setPreview(undefined);
      return;
    }
    const source = URL.createObjectURL(draft.blob);
    setPreview({ candidate: draft, source: source as AvatarImageSource });
    return () => URL.revokeObjectURL(source);
  }, [draft]);

  async function select(file: File) {
    if (disabled || preparation.current) return;
    const request = new AbortController();
    preparation.current = request;
    setError(undefined);
    setPreparing(true);
    onPreparing(true);
    let Failure: typeof import('../../media/AvatarPreparation').AvatarPreparationFailure | undefined;
    try {
      const module = await import('../../media/AvatarPreparation');
      Failure = module.AvatarPreparationFailure;
      const candidate = await module.prepareAvatar(file, { topicKey, creationTitle, maxMessageSize: maxMessageSize ?? { state: 'unknown' } }, request.signal);
      if (!request.signal.aborted) onChoose(candidate);
    } catch (reason: unknown) {
      if (!request.signal.aborted) setError(Failure && reason instanceof Failure ? reason.messageCode : 'chatInfoAvatarPreparationFailed');
    } finally {
      if (preparation.current === request) {
        preparation.current = undefined;
        setPreparing(false);
        onPreparing(false);
      }
    }
  }

  return <>
    <SettingsAvatar avatar={preview && preview.candidate === draft ? { state: 'ready', imageSource: preview.source } : avatar} name={name} />
    <input ref={picker} type="file" hidden accept="image/*,.heic,.heif"
      onChange={event => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = '';
        if (file) void select(file);
      }} />
    <div className="settings-editor-photo-actions">
      <button type="button" className="settings-editor-photo" disabled={disabled || preparing}
        onClick={() => picker.current?.click()} aria-busy={preparing}>{preparing ? preparingLabel : chooseLabel}</button>
      {remove && <button type="button" className="settings-editor-photo settings-editor-remove-photo"
        disabled={disabled || preparing} onClick={() => { setError(undefined); remove.onClick(); }}>{remove.label}</button>}
    </div>
    {error && <p className="settings-editor-error" role="alert">{errorText(error)}</p>}
  </>;
}
