import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useScreenTranslations } from '../i18n';
import { AppIcon } from './AppIcon';
import { BackButton } from './BackButton';
import { HeaderSearchField, HeaderSearchToggle } from './HeaderSearch';
import { SettingsPeopleList } from './settings/SettingsPeopleList';
import type { ChatListView } from '../chats/chat-list-presenter';
import { filterChatContacts, personalChatContacts } from '../chats/chat-creation-contacts';
import '../styles/chat-creation.css';

function CreationActions({ actions }: { readonly actions: readonly { readonly label: string; readonly onClick?: () => void }[] }) {
  return <ul className="settings-list">
    {actions.map(({ label, onClick }) => <li key={label} className="settings-list-row chat-creation-row">
      <button type="button" className="chat-creation-action" disabled={!onClick} onClick={onClick}>{label}</button>
    </li>)}
  </ul>;
}

export type ContactOpeningState = 'idle' | 'opening' | 'failed' | 'unconfirmed';

export function ChatCreationScreen({ chatList, contactOpening, hidden, onAddContact, onCreateGroup, onCreateChannel, onOpenContact, onBack }: {
  readonly chatList: Pick<ChatListView, 'items' | 'phase'>;
  readonly contactOpening: ContactOpeningState;
  readonly hidden: boolean;
  readonly onAddContact: () => void;
  readonly onCreateGroup: () => void;
  readonly onCreateChannel: () => void;
  readonly onOpenContact: (userId: string) => void;
  readonly onBack: () => void;
}) {
  useScreenTranslations('chatCreation');
  const { t, i18n } = useTranslation('chatCreation');
  const searchId = useId(), contactsId = useId();
  const input = useRef<HTMLInputElement>(null), searchButton = useRef<HTMLButtonElement>(null);
  const scroll = useRef<HTMLDivElement>(null), listPosition = useRef(0);
  const [query, setQuery] = useState<string>();
  const searchOpen = query !== undefined;
  const language = i18n.resolvedLanguage ?? i18n.language;
  const contacts = useMemo(() => personalChatContacts(chatList.items, language), [chatList.items, language]);
  const matches = filterChatContacts(contacts, query ?? '', language);
  const noMatch = chatList.phase === 'ready' && Boolean(query?.trim()) && matches.length === 0;
  const contactsStatus = chatList.phase === 'ready' ? t($ => noMatch ? $.contacts.notFound : $.contacts.empty)
    : chatList.phase === 'loading' || chatList.phase === 'idle' ? t($ => $.contacts.loading)
    : t($ => $.contacts.unavailable);

  useLayoutEffect(() => {
    if (scroll.current) scroll.current.scrollTop = query === undefined ? listPosition.current : 0;
  }, [query]);

  const openSearch = () => {
    listPosition.current = scroll.current?.scrollTop ?? 0;
    setQuery('');
  };
  const closeSearch = () => {
    input.current?.blur();
    setQuery(undefined);
    searchButton.current?.focus({ preventScroll: true });
  };

  const findContact = t($ => $.findContact);
  const addContact = { label: t($ => $.addContact), onClick: () => {
    input.current?.blur();
    onAddContact();
  } };

  return <section className="chats-screen chats-overlay-screen settings-screen" hidden={hidden} aria-label={t($ => $.title)}>
    <header className="chats-header">
      {query === undefined ? <BackButton className="header-glass-button" onBack={onBack} />
        : <HeaderSearchField id={searchId} input={input} label={findContact} placeholder={findContact}
          query={query} onQuery={setQuery} onKeyDown={event => {
            if (event.key === 'Escape' && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
              event.preventDefault();
              closeSearch();
            }
          }} />}
      <HeaderSearchToggle buttonRef={searchButton} open={searchOpen} panelId={searchId}
        label={searchOpen ? t($ => $.clearSearch) : findContact}
        onToggle={searchOpen ? closeSearch : openSearch} />
    </header>
    <div className="chats-overlay-scroll" ref={scroll}>
      {!searchOpen && <CreationActions actions={[
        addContact,
        { label: t($ => $.createGroup), onClick: onCreateGroup },
        { label: t($ => $.createChannel), onClick: onCreateChannel },
      ]} />}
      <section className="chat-creation-contacts" aria-labelledby={contactsId}>
        <h2 className="settings-list-heading" id={contactsId}>{t($ => $.contacts.title)}</h2>
        {contactOpening === 'opening' && <p className="chat-creation-feedback" role="status">
          <AppIcon name="spinner" className="auth-spinner" />{t($ => $.openingChat)}
        </p>}
        {(contactOpening === 'failed' || contactOpening === 'unconfirmed') &&
          <p className="chat-creation-feedback is-error" role="alert">
            {t($ => contactOpening === 'unconfirmed' ? $.openChatUnconfirmed : $.openChatFailed)}
          </p>}
        {matches.length > 0 ? <SettingsPeopleList people={matches}
          onSelect={onOpenContact} disabled={contactOpening === 'opening'} />
          : <p className="chat-creation-contacts-note" role="status">{contactsStatus}</p>}
        {noMatch && <CreationActions actions={[addContact]} />}
      </section>
    </div>
  </section>;
}
