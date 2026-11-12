import type { ConversationError, ConversationIdentity, ConversationMessage, ConversationSearchState, ConversationSnapshot } from './conversation-types';
import { normalizeServerTimestamp } from '../chats/chat-list-normalize';
import { createConversationReadStatus } from './conversation-read-status';
import type { ConversationReadStatus } from './conversation-read-status';

export type ConversationDateView = { readonly state: 'known'; readonly key: string; readonly text: string } | { readonly state: 'unknown' };
export type ConversationTimeView = { readonly state: 'known'; readonly text: string; readonly dateTime: string } | { readonly state: 'unknown' };
export interface ConversationMessageView {
  readonly key: number;
  readonly message: ConversationMessage;
  readonly side: 'incoming' | 'outgoing';
  readonly series: 'single' | 'first' | 'middle' | 'last';
  readonly showSenderName: boolean;
  readonly showSenderAvatar: boolean;
  readonly dateSeparator?: ConversationDateView;
  readonly time: ConversationTimeView;
  readonly edited?: Extract<ConversationTimeView, { state: 'known' }>;
}
export type ConversationSearchView = ConversationSearchState & {
  readonly count: number;
  readonly activeSeq?: number;
};

const noReadStatus: ConversationReadStatus = () => undefined;
const closedSearchView = Object.freeze({ state: 'closed', count: 0 } as const);

export interface ConversationView {
  readonly phase: ConversationSnapshot['phase'];
  readonly identity: ConversationIdentity;
  readonly items: readonly ConversationMessageView[];
  readonly outgoingReadStatus: ConversationReadStatus;
  readonly empty: boolean;
  readonly search: ConversationSearchView;
  readonly status?: 'opening' | 'error' | 'empty' | 'suspended' | 'closed';
  readonly initial: { readonly pending: boolean; readonly error?: ConversationError; readonly retryable: boolean };
  readonly older: { readonly pending: boolean; readonly error?: ConversationError; readonly enabled: boolean };
}

export function createConversationPresenter(options: { readonly language: 'ru' | 'en'; readonly timeZone?: string }) {
  const clock = new Intl.DateTimeFormat(options.language, { hour: '2-digit', minute: '2-digit', timeZone: options.timeZone });
  const editedDateLabel = new Intl.DateTimeFormat(options.language, { dateStyle: 'medium', timeZone: options.timeZone });
  const dateLabel = new Intl.DateTimeFormat(options.language, { dateStyle: 'long', timeZone: options.timeZone });
  const day = new Intl.DateTimeFormat('en-CA', { calendar: 'iso8601', numberingSystem: 'latn',
    year: 'numeric', month: '2-digit', day: '2-digit', timeZone: options.timeZone });
  const cache = new WeakMap<ConversationSnapshot, { today: string; view: ConversationView }>();
  type MessageCache = { today: string; items: readonly ConversationMessageView[] };
  const messageCache = {
    personal: new WeakMap<readonly ConversationMessage[], MessageCache>(),
    group: new WeakMap<readonly ConversationMessage[], MessageCache>(),
  };
  const emptyItems: readonly ConversationMessageView[] = Object.freeze([]);
  function messagesForDay(values: readonly ConversationMessage[], kind: ConversationIdentity['kind'], today: string): readonly ConversationMessageView[] {
    const previous = messageCache[kind].get(values);
    if (previous?.today === today) return previous.items;
    const times = values.map(message => {
      const at = message.timestamp.state === 'known' ? normalizeServerTimestamp(message.timestamp.at) : undefined;
      return at === undefined ? undefined : new Date(at);
    });
    const days = times.map(date => {
      if (!date) return undefined;
      const parts = day.formatToParts(date);
      return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)?.value).join('-');
    });
    function sameSeries(a: number, b: number): boolean {
      const one = values[a], two = values[b];
      return one !== undefined && two !== undefined && days[a] !== undefined && days[a] === days[b] &&
        one.sender.state !== 'unknown' && two.sender.state !== 'unknown' &&
        one.sender.state === two.sender.state && one.sender.uid === two.sender.uid;
    }
    const items = Object.freeze(values.map((message, index): ConversationMessageView => {
      const before = sameSeries(index - 1, index), after = sameSeries(index, index + 1);
      const showSender = kind === 'group' && message.sender.state !== 'self' && !before;
      const date = times[index];
      const separator = index === 0 || days[index] !== days[index - 1];
      const editedAt = message.versionSeq === undefined ? undefined : normalizeServerTimestamp(message.editedAt);
      const editedDate = editedAt === undefined ? undefined : new Date(editedAt);
      const edited = editedAt === undefined || editedDate === undefined ? undefined : Object.freeze({
        state: 'known' as const, dateTime: editedAt,
        text: (day.format(editedDate) === today ? clock : editedDateLabel).format(editedDate),
      });
      return Object.freeze({ key: message.serverSeq, message, side: message.sender.state === 'self' ? 'outgoing' : 'incoming',
        series: before ? after ? 'middle' : 'last' : after ? 'first' : 'single',
        showSenderName: showSender, showSenderAvatar: showSender, ...(edited === undefined ? {} : { edited }),
        ...(separator ? { dateSeparator: Object.freeze(date === undefined ? { state: 'unknown' } as const
          : { state: 'known', key: days[index]!, text: dateLabel.format(date) } as const) } : {}),
        time: Object.freeze(date === undefined ? { state: 'unknown' } as const
          : { state: 'known', text: clock.format(date), dateTime: message.timestamp.state === 'known' ? message.timestamp.at : '' } as const) });
    }));
    messageCache[kind].set(values, { today, items }); return items;
  }
  function searchView(search: ConversationSearchState | undefined): ConversationSearchView {
    if (!search || search.state === 'closed') return closedSearchView;
    if (search.state !== 'matches') return Object.freeze({ ...search, count: 0 });
    return Object.freeze({ ...search, count: search.matches.length,
      activeSeq: search.matches[search.activeIndex]!.serverSeq });
  }
  function snapshot(value: ConversationSnapshot, now = Date.now()): ConversationView {
    const today = day.format(now);
    const previous = cache.get(value); if (previous?.today === today) return previous.view;
    const ready = value.phase === 'ready', empty = ready && value.messages.length === 0
      && value.history.older.state === 'end' && value.history.newer.state === 'end';
    const initialError = value.phase === 'error' || value.phase === 'suspended' ? value.error : undefined;
    const olderError = ready && value.older.state === 'failed' ? value.older.error : undefined;
    const view = Object.freeze({ phase: value.phase, identity: value.identity,
      items: ready ? messagesForDay(value.messages, value.identity.kind, today) : emptyItems, empty,
      outgoingReadStatus: ready ? createConversationReadStatus(value.identity, value.header, value.receipts) : noReadStatus,
      search: searchView(ready ? value.search : undefined),
      ...(value.phase === 'idle' || value.phase === 'opening' ? { status: 'opening' as const }
        : ready ? empty ? { status: 'empty' as const } : {} : { status: value.phase }),
      initial: Object.freeze({ pending: value.phase === 'idle' || value.phase === 'opening',
        ...(initialError === undefined ? {} : { error: initialError }), retryable: value.phase === 'error' && value.error.retryable }),
      older: Object.freeze({ pending: ready && value.older.state === 'pending',
        ...(olderError === undefined ? {} : { error: olderError }),
        enabled: ready && value.history.older.state === 'more' && value.older.state !== 'pending' && (olderError === undefined || olderError.retryable) }) });
    cache.set(value, { today, view }); return view;
  }
  const messages = (values: readonly ConversationMessage[], kind: ConversationIdentity['kind'], now = Date.now()) =>
    messagesForDay(values, kind, day.format(now));
  return Object.freeze({ messages, snapshot });
}
