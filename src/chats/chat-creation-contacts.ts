import type { ChatListItemView } from './chat-list-presenter';

export function personalChatContacts(items: readonly ChatListItemView[], language: string) {
  const collator = new Intl.Collator(language, { sensitivity: 'base' });
  return items.filter(chat => chat.kind === 'personal')
    .map(chat => ({ id: chat.topicKey, name: chat.title, avatar: chat.avatar }))
    .sort((first, second) => collator.compare(first.name, second.name));
}

export function filterChatContacts<T extends { readonly name: string }>(contacts: readonly T[], query: string, language: string): readonly T[] {
  const term = query.trim().normalize('NFC').toLocaleLowerCase(language);
  return term ? contacts.filter(contact => contact.name.normalize('NFC').toLocaleLowerCase(language).includes(term)) : contacts;
}
