import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ContactSearchOutcome, ContactSearchPort, OpenContactSearchPort } from '../contacts/contact-search-types';
import { useScreenTranslations } from '../i18n';
import { AppIcon } from './AppIcon';
import { BackButton } from './BackButton';
import type { ContactOpeningState } from './ChatCreationScreen';
import { HeaderSearchField } from './HeaderSearch';
import { SettingsPeopleList } from './settings/SettingsPeopleList';
import '../styles/add-contact.css';

type SearchState = ContactSearchOutcome | { readonly state: 'idle' | 'searching' };

export function AddContactScreen({ openPort, contactOpening, onOpenContact, onBack }: {
  readonly openPort: OpenContactSearchPort;
  readonly contactOpening: ContactOpeningState;
  readonly onOpenContact: (userId: string) => void;
  readonly onBack: () => void;
}) {
  useScreenTranslations('addContact');
  const { t } = useTranslation('addContact');
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | undefined>(undefined);
  const port = useRef<ContactSearchPort | undefined>(undefined);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<SearchState>({ state: 'idle' });
  const [selected, setSelected] = useState(false);
  const opening = contactOpening === 'opening';

  useEffect(() => () => {
    request.current?.abort();
    port.current?.dispose();
    port.current = undefined;
  }, []);

  const updateQuery = (value: string) => {
    request.current?.abort();
    setQuery(value);
    setResult({ state: 'idle' });
    setSelected(false);
  };

  const submit = async () => {
    if (!query.trim() || result.state === 'searching' || opening) return;
    request.current?.abort();
    const current = new AbortController();
    request.current = current;
    const { signal } = current;
    setResult({ state: 'searching' });
    setSelected(false);
    input.current?.blur();
    try {
      const search = port.current ?? await openPort();
      if (signal.aborted) {
        if (search !== port.current) search.dispose();
        return;
      }
      port.current = search;
      const outcome = await search.search(query, signal);
      if (signal.aborted) return;
      setResult(outcome);
      if (outcome.state === 'ready') {
        for (const person of outcome.people) {
          if (person.avatar.state !== 'pending') continue;
          void search.loadAvatar(person.id).then(avatar => {
            if (!signal.aborted) setResult(previous => previous.state === 'ready'
              ? { state: 'ready', people: previous.people.map(entry => entry.id === person.id ? { ...entry, avatar } : entry) }
              : previous);
          });
        }
      }
    } catch {
      if (!signal.aborted) setResult({ state: 'failed', error: 'searchFailed' });
    }
  };

  return <section className="chats-screen chats-overlay-screen settings-screen add-contact-screen" aria-label={t($ => $.title)}>
    <header className="chats-header">
      <BackButton className="header-glass-button" onBack={onBack} />
      <HeaderSearchField id={id} input={input} label={t($ => $.title)} placeholder={t($ => $.placeholder)}
        query={query} onQuery={updateQuery} disabled={opening} onKeyDown={event => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
            event.preventDefault();
            void submit();
          }
        }} />
      <button type="button" className="header-glass-button" aria-label={t($ => $.search)}
        disabled={!query.trim() || result.state === 'searching' || opening} onClick={() => { void submit(); }}>
        <AppIcon name="search" />
      </button>
    </header>
    <div className="chats-overlay-scroll">
      {result.state === 'searching' && <p className="add-contact-feedback" role="status">
        <AppIcon name="spinner" className="auth-spinner" />{t($ => $.searching)}
      </p>}
      {result.state === 'failed' && <div className="add-contact-feedback is-error" role="alert">
        <span>{t($ => $[result.error])}</span>
        {result.error === 'searchFailed' &&
          <button type="button" className="auth-secondary-button" onClick={() => { void submit(); }}>{t($ => $.retry)}</button>}
      </div>}
      {result.state === 'ready' && (result.people.length === 0
        ? <p className="add-contact-feedback" role="status">{t($ => $.empty)}</p>
        : <>
          {opening && <p className="add-contact-feedback" role="status">
            <AppIcon name="spinner" className="auth-spinner" />{t($ => $.openingChat)}
          </p>}
          {selected && (contactOpening === 'failed' || contactOpening === 'unconfirmed') &&
            <p className="add-contact-feedback is-error" role="alert">
              {t($ => contactOpening === 'failed' ? $.openChatFailed : $.openChatUnconfirmed)}
            </p>}
          <SettingsPeopleList people={result.people.map(person => ({ ...person, name: person.name ?? t($ => $.unnamed) }))}
            disabled={opening} onSelect={userId => { setSelected(true); onOpenContact(userId); }} />
        </>)}
    </div>
  </section>;
}
