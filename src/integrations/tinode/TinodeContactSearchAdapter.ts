import { normalizeChatTitle } from '../../chats/chat-list-normalize';
import type { AvatarResource } from '../../chats/chat-list-types';
import type { ContactSearchOutcome, ContactSearchPort, ContactSearchResult } from '../../contacts/contact-search-types';
import { discoveryTagValue, TinodeSessionFailure } from './TinodeSessionScope';
import type { TinodeSessionScope, TinodeSessionValue } from './TinodeSessionScope';
import { TinodeAvatarLoader } from './tinode-avatar';

const userId = /^usr[A-Za-z0-9_-]+$/;
const unavailable = Object.freeze({ state: 'unavailable' } as const);

function contactTag(input: string): string | undefined {
  const value = input.trim();
  const alias = value.startsWith('@');
  const term = alias ? value.slice(1) : value;
  if (!discoveryTagValue.test(term)) return undefined;
  return (alias ? 'alias:' : 'basic:') + term;
}

export class TinodeContactSearchAdapter implements ContactSearchPort {
  readonly account;
  readonly #scope;
  readonly #discovery;
  readonly #avatars;
  readonly #profiles = new Map<string, TinodeSessionValue | undefined>();
  #releaseResults: (() => void) | undefined;
  #disposed = false;

  constructor(scope: TinodeSessionScope) {
    this.#scope = scope;
    this.account = scope.account;
    this.#discovery = scope.openContactDiscovery();
    this.#avatars = new TinodeAvatarLoader(scope);
  }

  async search(input: string, signal: AbortSignal): Promise<ContactSearchOutcome> {
    this.#releaseResults?.();
    const tag = contactTag(input);
    if (!tag) return { state: 'failed', error: 'invalidQuery' };
    if (this.#disposed || !this.#scope.active || signal.aborted) {
      throw new TinodeSessionFailure('aborted');
    }
    const release = () => {
      signal.removeEventListener('abort', release);
      for (const id of this.#profiles.keys()) this.#avatars.release(id);
      this.#profiles.clear();
      this.#releaseResults = undefined;
    };
    this.#releaseResults = release;
    signal.addEventListener('abort', release, { once: true });
    try {
      const rows = await this.#discovery.find(tag, signal);
      if (this.#releaseResults !== release || !this.#scope.active) throw new TinodeSessionFailure('aborted');
      const people: ContactSearchResult[] = [];
      for (const row of rows) {
        if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
        const record = row as Readonly<Record<string, TinodeSessionValue>>;
        const id = record.topic ?? record.user;
        if (typeof id !== 'string' || !userId.test(id) || id === this.account.uid ||
          (record.user !== undefined && record.user !== id) || this.#profiles.has(id)) continue;
        const profile = record.public;
        const title = normalizeChatTitle(profile);
        this.#profiles.set(id, profile);
        people.push({ id, name: title.state === 'known' ? title.text.trim() : undefined, avatar: this.#avatars.state(profile) });
      }
      return { state: 'ready', people };
    } catch (reason: unknown) {
      if (this.#releaseResults === release) release();
      if (signal.aborted || this.#disposed || (reason instanceof TinodeSessionFailure && reason.reason === 'aborted')) {
        throw new TinodeSessionFailure('aborted');
      }
      return { state: 'failed', error: 'searchFailed' };
    }
  }

  loadAvatar(userId: string): Promise<AvatarResource> {
    return this.#profiles.has(userId) ? this.#avatars.load(userId, this.#profiles.get(userId))
      : Promise.resolve(unavailable);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#releaseResults?.();
    this.#avatars.dispose();
    this.#discovery.dispose();
  }
}
