import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppIcon } from '../../app/AppIcon';
import { ParticipantPicker } from '../../app/settings/ParticipantPicker';
import { personalChatContacts } from '../../chats/chat-creation-contacts';
import type { ChatListView } from '../../chats/chat-list-presenter';
import { useScreenTranslations } from '../../i18n';
import type { ChatInfoAddMembersResult } from '../chat-info-types';

export function AddChatMembersScreen({ chatList, ownUid, memberIds, onAdd, onBack }: {
  readonly chatList: Pick<ChatListView, 'items' | 'phase'>;
  readonly ownUid: string;
  readonly memberIds: ReadonlySet<string>;
  readonly onAdd: (ids: readonly string[]) => Promise<ChatInfoAddMembersResult>;
  readonly onBack: () => void;
}) {
  useScreenTranslations('createGroup');
  const { t, i18n } = useTranslation('chatInfo');
  const { t: errorT } = useTranslation('errors');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [result, setResult] = useState<ChatInfoAddMembersResult>();
  const [busy, setBusy] = useState(false);
  const request = useRef(false);
  const language = i18n.resolvedLanguage ?? i18n.language;
  const contacts = useMemo(() => personalChatContacts(chatList.items, language)
    .filter(person => person.id !== ownUid && !memberIds.has(person.id)), [chatList.items, language, ownUid, memberIds]);
  const eligible = new Set(contacts.map(person => person.id));
  const chosen = new Set([...selected].filter(uid => eligible.has(uid)));
  const issue = result?.error;
  const denied = issue?.retryable === false;

  const toggle = (id: string) => {
    if (request.current || denied || !eligible.has(id)) return;
    setResult(undefined);
    setSelected(previous => {
      const next = new Set(previous);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  };
  const submit = async () => {
    if (request.current || denied || !chosen.size) return;
    request.current = true;
    setBusy(true);
    setResult(undefined);
    try {
      const outcome = await onAdd([...chosen]);
      if (outcome.failed.length === 0) onBack();
      else {
        setSelected(new Set(outcome.failed));
        setResult(outcome);
      }
    } finally {
      request.current = false;
      setBusy(false);
    }
  };

  return <ParticipantPicker title={t($ => $.members.addLabel)} contacts={contacts} phase={chatList.phase}
    query={query} onQuery={setQuery} selected={chosen} onToggle={toggle} onBack={onBack} busy={busy} locked={denied}
    action={{ label: t($ => $.members.addAction), disabled: !chosen.size || denied,
      onClick: () => { void submit(); } }}
    feedback={busy ? <p className="group-create-note group-create-progress" role="status">
      <AppIcon name="spinner" className="auth-spinner" />{t($ => $.members.adding)}
    </p> : result && <div className="group-create-result group-create-picker-feedback" role="alert">
      <p className="settings-editor-error">{issue ? errorT($ => $[issue.messageCode]) : t($ => $.members.addIncomplete)}</p>
    </div>} />;
}
