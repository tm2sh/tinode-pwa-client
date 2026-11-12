import type { AccountScope, AvatarResource } from '../chats/chat-list-types';

export interface ContactSearchResult {
  readonly id: string;
  readonly name?: string;
  readonly avatar: AvatarResource;
}

export type ContactSearchOutcome =
  | { readonly state: 'ready'; readonly people: readonly ContactSearchResult[] }
  | { readonly state: 'failed'; readonly error: 'invalidQuery' | 'searchFailed' };

export interface ContactSearchPort {
  readonly account: AccountScope;
  search(input: string, signal: AbortSignal): Promise<ContactSearchOutcome>;
  loadAvatar(userId: string): Promise<AvatarResource>;
  dispose(): void;
}

export type OpenContactSearchPort = () => Promise<ContactSearchPort>;
