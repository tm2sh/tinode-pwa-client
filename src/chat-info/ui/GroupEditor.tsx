import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingsAvatarPicker } from '../../app/settings/SettingsAvatarPicker';
import type { AvatarResource } from '../../chats/chat-list-types';
import type { PreparedAvatar } from '../../media/AvatarPreparation';
import type { ServerLimit } from '../../media/MediaResources';
import type { ChatInfoGroupPatch, ChatInfoGroupSaveResult, ChatInfoGroupSaveState } from '../chat-info-types';
import { isGroupTitle } from '../group-public-patch';

interface GroupEditorProps {
  readonly name: string;
  readonly avatar: AvatarResource;
  readonly topicKey: string;
  readonly maxMessageSize?: ServerLimit;
  readonly busy: boolean;
  readonly operation?: ChatInfoGroupSaveState;
  readonly onSave: (patch: ChatInfoGroupPatch) => Promise<ChatInfoGroupSaveResult | undefined>;
  readonly onCheck: () => Promise<ChatInfoGroupSaveResult | undefined>;
  readonly onConfirmed: () => void;
}

export function GroupEditor({ name, avatar, topicKey, maxMessageSize, busy, operation, onSave, onCheck, onConfirmed }: GroupEditorProps) {
  const { t } = useTranslation('chatInfo'), { t: errorText } = useTranslation('errors');
  const nameId = useId();
  const [nameDraft, setNameDraft] = useState<string>();
  const [avatarDraft, setAvatarDraft] = useState<PreparedAvatar>();
  const [preparing, setPreparing] = useState(false);

  const value = nameDraft ?? name;
  const title = nameDraft !== undefined && nameDraft.trim() !== name ? nameDraft.trim() : undefined;
  const saving = operation?.state === 'saving', checking = operation?.state === 'checking';
  const error = operation?.state === 'failed' || operation?.state === 'unknown' ? operation.error : undefined;
  const locked = busy || saving || checking || error?.messageCode === 'chatInfoGroupSaveDenied';
  const canSave = !locked && !preparing && (title !== undefined || avatarDraft !== undefined) &&
    (title === undefined || isGroupTitle(title));
  async function save() {
    if (!canSave) return;
    const result = await onSave({ title, avatar: avatarDraft });
    if (result?.state === 'confirmed') onConfirmed();
  }

  async function check() {
    const result = await onCheck();
    if (result?.state === 'confirmed') onConfirmed();
  }

  return <form className="settings-editor" onSubmit={event => { event.preventDefault(); void save(); }}>
    <SettingsAvatarPicker name={value} avatar={avatar} draft={avatarDraft} topicKey={topicKey}
      maxMessageSize={maxMessageSize} disabled={locked} chooseLabel={t($ => $.edit.changePhoto)}
      preparingLabel={t($ => $.edit.preparingPhoto)} errorText={code => errorText($ => $[code])}
      onChoose={setAvatarDraft} onPreparing={setPreparing} />
    <label className="settings-editor-label" htmlFor={nameId}>{t($ => $.edit.groupName)}</label>
    <input id={nameId} className="settings-editor-name" value={value} disabled={locked}
      onChange={event => setNameDraft(event.currentTarget.value)} />
    <button type="submit" className="settings-editor-action settings-editor-save" disabled={!canSave} aria-busy={saving}>
      {saving ? t($ => $.edit.saving) : t($ => $.edit.save)}
    </button>
    {error && <p className="settings-editor-error" role="alert">{errorText($ => $[error.messageCode])}</p>}
    {(operation?.state === 'unknown' || checking) &&
      <button type="button" className="settings-editor-action" disabled={locked || preparing}
        onClick={() => { void check(); }} aria-busy={checking}>
        {checking ? t($ => $.edit.checking) : t($ => $.edit.check)}
      </button>}
  </form>;
}
