import type { TFunction } from 'i18next';
import type {
  AvatarResource, ChatKind, ChatListError, ChatListItem, ChatListSnapshot,
  ChatUnreadCount, CurrentUserProfile, LastMessage, LastMessagePreview,
} from './chat-list-types';
import { normalizeServerTimestamp } from './chat-list-normalize';

export interface ChatListPresenterOptions {
  readonly language: 'ru' | 'en';
  readonly t: TFunction<'chats'>;
  readonly errorT: TFunction<'errors'>;
  // Use the device time zone by default. Callers can set one explicitly for a separate view.
  readonly timeZone?: string;
}

export interface ChatPreviewView {
  readonly state: LastMessagePreview['state'];
  readonly text: string;
  readonly ariaLabel: string;
  readonly warning?: string;
  readonly lastKnown: boolean;
}

export type ChatTimeView =
  | { readonly state: 'known'; readonly text: string; readonly dateTime: string; readonly ariaLabel: string }
  | { readonly state: 'unknown'; readonly text: ''; readonly ariaLabel: string };

export type ChatUnreadView =
  | { readonly state: 'hidden'; readonly text: ''; readonly ariaLabel: string }
  | { readonly state: 'count'; readonly count: number; readonly text: string; readonly ariaLabel: string }
  | { readonly state: 'unknown'; readonly text: string; readonly ariaLabel: string };

export interface ChatListItemView {
  readonly topicKey: string;
  readonly title: string;
  readonly kind: ChatKind;
  readonly kindLabel: string;
  readonly avatar: AvatarResource;
  readonly avatarLabel: string;
  readonly draftLabel?: string;
  readonly sender?: { readonly name: string; readonly avatar: AvatarResource };
  readonly notificationsMuted: boolean;
  readonly mentioned: boolean;
  readonly mentionLabel: string;
  readonly preview: ChatPreviewView;
  readonly time: ChatTimeView;
  readonly unread: ChatUnreadView;
  readonly ariaLabel: string;
}

export interface ChatProfileView {
  readonly state: CurrentUserProfile['state'];
  readonly name: string;
  readonly avatar: AvatarResource;
  readonly avatarLabel: string;
  readonly openLabel: string;
  readonly warning?: string;
}

export interface ChatListView {
  readonly phase: ChatListSnapshot['phase'];
  readonly title: string;
  readonly ariaLabel: string;
  readonly items: readonly ChatListItemView[];
  readonly profile: ChatProfileView;
  readonly statusText?: string;
  readonly searchEmptyText?: string;
  readonly statusRole?: 'status' | 'alert';
  readonly errorText?: string;
  readonly empty: boolean;
  readonly emptyText?: string;
  readonly refresh: { readonly state: 'idle' | 'pending' | 'failed'; readonly text?: string };
}

// Use confirmed lastActivityAt only, without falling back to updated, read, or arrival time.
function activityTimestamp(item: ChatListItem): string | undefined {
  return item.preview.state !== 'empty' && item.lastActivityAt.state === 'known'
    ? normalizeServerTimestamp(item.lastActivityAt.at) : undefined;
}

function compareKeys(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

export function sortChatListItems(items: readonly ChatListItem[]): readonly ChatListItem[] {
  const ranked = items.map((item) => {
    const at = activityTimestamp(item);
    return { item, rank: item.preview.state === 'empty' ? 2 : at === undefined ? 1 : 0,
      time: at === undefined ? 0 : Date.parse(at) };
  });
  ranked.sort((a, b) => a.rank - b.rank || b.time - a.time || compareKeys(a.item.topicKey, b.item.topicKey));
  return Object.freeze(ranked.map(({ item }) => item));
}

export function chatListErrorText(t: TFunction<'errors'>, error: ChatListError): string {
  return t(($) => $[error.messageCode], { serverCode: error.serverCode, seconds: error.messageParams?.seconds });
}

function copyAvatar(avatar: AvatarResource): AvatarResource {
  return avatar.state === 'ready' ? Object.freeze({ state: 'ready', imageSource: avatar.imageSource })
    : Object.freeze({ state: avatar.state });
}

export function createChatListPresenter({ language, t, errorT, timeZone }: ChatListPresenterOptions) {
  const numbers = new Intl.NumberFormat(language);
  const clock = new Intl.DateTimeFormat(language, { hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23', ...(timeZone === undefined ? {} : { timeZone }) });
  const dates = new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short',
    ...(timeZone === undefined ? {} : { timeZone }) });
  // Treat names and messages as plain text, without interpreting them as translation keys or HTML.
  const interpolation = { escapeValue: false, skipOnVariables: true } as const;
  const errorText = (error: ChatListError) => chatListErrorText(errorT, error);

  function messageText(message: LastMessage, kind: ChatKind, includeSender = true): string {
    const content = message.content;
    let text: string;
    if (content.kind === 'text') text = content.text;
    else {
      const type = content.kind === 'photo' ? t(($) => $.preview.photo)
        : content.kind === 'voice' ? t(($) => $.preview.voice)
          : content.kind === 'video' ? t(($) => $.preview.video)
            : content.kind === 'file' ? t(($) => $.preview.file) : t(($) => $.preview.unsupported);
      text = content.caption === undefined || content.caption.trim() === '' ? type
        : t(($) => $.preview.withCaption, { type, caption: content.caption, interpolation });
    }
    if (kind === 'personal' || !includeSender) return text;
    const sender = message.sender.state === 'self' ? t(($) => $.sender.self)
      : message.sender.state === 'known' ? message.sender.displayName : t(($) => $.sender.unknown);
    return t(($) => $.preview.withSender, { sender, message: text, interpolation });
  }

  function previewView(preview: LastMessagePreview, kind: ChatKind): ChatPreviewView {
    if (preview.state === 'available') {
      const text = messageText(preview.message, kind, false);
      return Object.freeze({ state: 'available', text, ariaLabel: messageText(preview.message, kind), lastKnown: false });
    }
    if (preview.state === 'pending') {
      const text = preview.lastKnown === undefined ? t(($) => $.preview.loading)
        : t(($) => $.preview.loadingLastKnown, { message: messageText(preview.lastKnown, kind, false), interpolation });
      const ariaLabel = preview.lastKnown === undefined ? text
        : t(($) => $.preview.loadingLastKnown, { message: messageText(preview.lastKnown, kind), interpolation });
      return Object.freeze({ state: 'pending', text, ariaLabel, lastKnown: preview.lastKnown !== undefined });
    }
    if (preview.state === 'empty') {
      const text = preview.reason === 'noMessages' ? t(($) => $.preview.noMessages) : t(($) => $.preview.noAvailableMessages);
      return Object.freeze({ state: 'empty', text, ariaLabel: text, lastKnown: false });
    }
    const warning = errorText(preview.error);
    const text = preview.lastKnown === undefined ? warning : t(($) => $.preview.lastKnown,
      { message: messageText(preview.lastKnown, kind, false), interpolation });
    const accessiblePreview = preview.lastKnown === undefined ? text
      : t(($) => $.preview.lastKnown, { message: messageText(preview.lastKnown, kind), interpolation });
    const ariaLabel = preview.lastKnown === undefined ? text
      : t(($) => $.a11y.previewWithWarning, { preview: accessiblePreview, warning, interpolation });
    return Object.freeze({ state: 'unavailable', text, warning, ariaLabel, lastKnown: preview.lastKnown !== undefined });
  }

  function unreadView(unread: ChatUnreadCount): ChatUnreadView {
    if (unread.state !== 'known' || !Number.isSafeInteger(unread.value) || unread.value < 0) {
      return Object.freeze({ state: 'unknown', text: t(($) => $.unread.unknownBadge), ariaLabel: t(($) => $.unread.unknown) });
    }
    if (unread.value === 0) return Object.freeze({ state: 'hidden', text: '', ariaLabel: t(($) => $.unread.none) });
    return Object.freeze({ state: 'count', count: unread.value, text: numbers.format(unread.value),
      ariaLabel: t(($) => $.unread.count, { count: unread.value, value: numbers.format(unread.value) }) });
  }

  function timeView(item: ChatListItem): ChatTimeView {
    const at = activityTimestamp(item);
    if (at === undefined) return Object.freeze({ state: 'unknown', text: '', ariaLabel: t(($) => $.a11y.timeUnknown) });
    const date = new Date(at);
    const ariaLabel = (item.preview.state === 'unavailable' || item.preview.state === 'pending') && item.preview.lastKnown !== undefined
      ? t(($) => $.a11y.lastKnownActivity, { dateTime: dates.format(date) })
      : t(($) => $.a11y.lastActivity, { dateTime: dates.format(date) });
    return Object.freeze({ state: 'known', text: clock.format(date), dateTime: at, ariaLabel });
  }

  function avatarLabel(avatar: AvatarResource, title: string): string {
    return avatar.state === 'ready' ? t(($) => $.a11y.avatar, { title, interpolation })
      : avatar.state === 'pending' ? t(($) => $.a11y.avatarLoading, { title, interpolation })
        : avatar.state === 'missing' ? t(($) => $.a11y.avatarMissing, { title, interpolation })
          : t(($) => $.a11y.avatarUnavailable, { title, interpolation });
  }

  function itemView(item: ChatListItem, ownProfile: CurrentUserProfile): ChatListItemView {
    const title = item.title.state === 'known' ? item.title.text
      : item.kind === 'group' ? t(($) => $.fallback.group) : t(($) => $.fallback.personal);
    const kindLabel = item.kind === 'group' ? t(($) => $.kind.group) : t(($) => $.kind.personal);
    const draftLabel = item.draft ? t(($) => $.preview.draft) : undefined;
    const preview: ChatPreviewView = item.draft
      ? Object.freeze({ state: 'available', text: item.draft.text,
        ariaLabel: t(($) => $.sender.self) + '. ' + draftLabel + ' ' + item.draft.text, lastKnown: false })
      : previewView(item.preview, item.kind);
    const time = timeView(item);
    const unread = unreadView(item.unread);
    const message = item.preview.state === 'available' ? item.preview.message
      : item.preview.state === 'unavailable' || item.preview.state === 'pending' ? item.preview.lastKnown : undefined;
    const sender = item.draft ? Object.freeze({
      name: t(($) => $.sender.self),
      avatar: copyAvatar(ownProfile.state === 'available' ? ownProfile.avatar : { state: 'missing' }),
    }) : item.kind === 'group' && message ? Object.freeze({
      name: message.sender.state === 'self' ? t(($) => $.sender.self)
        : message.sender.state === 'known' ? message.sender.displayName : t(($) => $.sender.unknown),
      avatar: copyAvatar(message.sender.state === 'self' && ownProfile.state === 'available'
        ? ownProfile.avatar : message.sender.avatar ?? { state: 'missing' }),
    }) : undefined;
    const notificationsMuted = item.notificationsMuted === true;
    const mentioned = item.mentionUnread === true;
    const mentionLabel = t(($) => $.a11y.mentioned);
    return Object.freeze({ topicKey: item.topicKey, title, kind: item.kind, kindLabel,
      avatar: copyAvatar(item.avatar), avatarLabel: avatarLabel(item.avatar, title), preview, time, unread,
      ...(sender === undefined ? {} : { sender }), ...(draftLabel === undefined ? {} : { draftLabel }),
      notificationsMuted, mentioned, mentionLabel,
      ariaLabel: (notificationsMuted ? t(($) => $.a11y.notificationsMuted) + '. ' : '') +
        (mentioned ? mentionLabel + '. ' : '') + t(($) => item.title.state === 'known' ? $.a11y.card : $.a11y.cardUnknown,
        { type: kindLabel, title, preview: preview.ariaLabel,
        time: time.ariaLabel, unread: unread.ariaLabel, interpolation }) });
  }

  function profileView(profile?: CurrentUserProfile): ChatProfileView {
    const name = profile?.state === 'available' && profile.displayName.state === 'known'
      ? profile.displayName.text : t(($) => $.fallback.profile);
    const avatar: AvatarResource = profile?.state === 'available' ? copyAvatar(profile.avatar)
      : Object.freeze({ state: profile?.state === 'unavailable' ? 'unavailable' : 'pending' });
    return Object.freeze({ state: profile?.state ?? 'pending', name, avatar,
      avatarLabel: avatarLabel(avatar, name), openLabel: t(($) => $.openProfile),
      ...(profile?.state === 'unavailable' ? { warning: errorText(profile.error) } : {}) });
  }

  function snapshotView(snapshot: ChatListSnapshot, query = ''): ChatListView {
    const ready = snapshot.phase === 'ready';
    const refresh = ready ? snapshot.refresh : undefined;
    const failed = refresh?.state === 'failed';
    const pending = refresh?.state === 'pending';
    const term = query.trim().normalize('NFC').toLocaleLowerCase(language);
    const chats = ready ? snapshot.items : [];
    const matching = term ? chats.filter(({ title }) => title.state === 'known' &&
      title.text.normalize('NFC').toLocaleLowerCase(language).includes(term)) : chats;
    const items = Object.freeze(ready ? sortChatListItems(matching).map(item => itemView(item, snapshot.ownProfile)) : []);
    const empty = ready && chats.length === 0;
    const noMatches = ready && !failed && !pending && term !== '' && items.length === 0;
    const statusText = snapshot.phase === 'idle' || snapshot.phase === 'loading' ? t(($) => $.state.loading)
      : snapshot.phase === 'error' ? t(($) => $.state.failed)
        : snapshot.phase === 'closed' ? t(($) => $.state.closed)
          : failed ? t(($) => $.state.refreshFailed)
            : pending ? t(($) => $.state.refreshing) : empty && !noMatches ? t(($) => $.state.empty) : undefined;
    const statusRole = snapshot.phase === 'error' || failed ? 'alert' as const
      : statusText === undefined ? undefined : 'status' as const;
    const detail = snapshot.phase === 'error' ? errorText(snapshot.error)
      : refresh?.state === 'failed' ? errorText(refresh.error) : undefined;
    return Object.freeze({ phase: snapshot.phase, title: t(($) => $.title), ariaLabel: t(($) => $.a11y.list), items,
      profile: profileView('ownProfile' in snapshot ? snapshot.ownProfile : undefined),
      ...(noMatches ? { searchEmptyText: t(($) => $.search.empty) } : {}),
      ...(statusText === undefined ? {} : { statusText }), ...(statusRole === undefined ? {} : { statusRole }),
      ...(detail === undefined ? {} : { errorText: detail }), empty,
      ...(empty ? { emptyText: t(($) => $.state.empty) } : {}),
      refresh: Object.freeze({ state: refresh?.state ?? 'idle',
        ...(pending ? { text: t(($) => $.state.refreshing) } : failed ? { text: t(($) => $.state.refreshFailed) } : {}) }),
    });
  }

  return Object.freeze({ item: itemView, snapshot: snapshotView, profile: profileView });
}
