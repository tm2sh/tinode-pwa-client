import { useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { filterChatContacts } from '../../chats/chat-creation-contacts';
import type { ChatListView } from '../../chats/chat-list-presenter';
import { HeaderSearchField } from '../HeaderSearch';
import { SettingsHeader } from './SettingsHeader';
import { SettingsPeopleList } from './SettingsPeopleList';
import type { SettingsPerson } from './SettingsPeopleList';
import '../../styles/create-group.css';

interface ParticipantPickerProps {
  readonly title: string;
  readonly contacts: readonly SettingsPerson[];
  readonly phase: ChatListView['phase'];
  readonly query: string;
  readonly onQuery: (query: string) => void;
  readonly selected: ReadonlySet<string>;
  readonly onToggle: (id: string) => void;
  readonly onBack: () => void;
  readonly action: { readonly label: string; readonly onClick: () => void; readonly disabled?: boolean };
  readonly limitReached?: boolean;
  readonly locked?: boolean;
  readonly busy?: boolean;
  readonly feedback?: ReactNode;
}

export function ParticipantPicker({ title, contacts, phase, query, onQuery, selected, onToggle, onBack,
  action, limitReached = false, locked = false, busy = false, feedback }: ParticipantPickerProps) {
  const { t, i18n } = useTranslation('createGroup');
  const titleId = useId(), searchId = useId();
  const search = useRef<HTMLInputElement>(null);
  const visible = filterChatContacts(contacts, query, i18n.resolvedLanguage ?? i18n.language);
  const find = t($ => $.find);
  return <section className="chats-screen settings-screen group-create-screen participant-picker" aria-labelledby={titleId} aria-busy={busy}>
    <SettingsHeader title={title} titleId={titleId} onBack={onBack} backDisabled={busy}
      action={{ label: action.label, disabled: busy || action.disabled, onClick: () => {
        search.current?.blur();
        action.onClick();
      } }} />
    <HeaderSearchField id={searchId} input={search} label={find} placeholder={find} autoFocus={false}
      query={query} onQuery={onQuery} />
    {feedback}
    {limitReached && !locked && <p className="group-create-note" role="status">{t($ => $.limitReached)}</p>}
    {visible.length > 0
      ? <SettingsPeopleList people={visible} disabled={locked || busy} selection={{ checked: selected, onToggle, limitReached }} />
      : <p className="group-create-note" role="status">{t($ => phase === 'error' ? $.contactsUnavailable
        : phase !== 'ready' ? $.contactsLoading : query.trim() ? $.noMatches : $.noContacts)}</p>}
  </section>;
}
