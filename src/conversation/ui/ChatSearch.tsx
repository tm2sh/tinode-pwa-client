import { useMemo } from 'react';
import { HeaderSearchField } from '../../app/HeaderSearch';
import type { KeyboardEvent, RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConversationSearchView } from '../conversation-presenter';

interface ChatSearchProps {
  readonly id: string;
  readonly input: RefObject<HTMLInputElement | null>;
  readonly search: Exclude<ConversationSearchView, { state: 'closed' }>;
  readonly onQuery: (query: string) => void;
  readonly onMove: (direction: 'next' | 'previous') => void;
}
export function ChatSearch({ id, input, search, onQuery, onMove }: ChatSearchProps) {
  const { t, i18n } = useTranslation('chat');
  const numbers = useMemo(() => new Intl.NumberFormat(i18n.language), [i18n.language]);

  const moveOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    event.preventDefault();
    if (search.count > 1) onMove(event.shiftKey ? 'previous' : 'next');
  };
  const status = search.state === 'matches' ? t($ => $.searchPanel.position, {
    current: numbers.format(search.activeIndex + 1), total: numbers.format(search.count),
  }) : search.state === 'no-matches' ? t($ => $.searchPanel.noMatches) : null;
  return <HeaderSearchField id={id} input={input} label={t($ => $.search)} placeholder={t($ => $.searchPanel.placeholder)}
    inputLabel={t($ => $.searchPanel.input)} query={search.query} onQuery={onQuery} onKeyDown={moveOnEnter} status={status} />;
}
