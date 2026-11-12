import type { AuthError, SessionRecord } from './auth-types';
import type { ErrorMessageCode } from '../i18n/resources';
import type { ClientConfig } from '../config/client-config';
import { tinodeServerId } from '../config/server-id';

export type InvalidSessionReason =
  | 'malformed'
  | 'unsupportedSchema'
  | 'wrongServer'
  | 'expired';

type StorageAction = 'read' | 'write' | 'remove';

interface StorageFailure {
  readonly kind: 'unavailable';
  readonly action: StorageAction;
  readonly error: AuthError & { readonly kind: 'storageUnavailable' };
}

type InvalidSession = {
  readonly kind: 'invalid';
  readonly reason: InvalidSessionReason;
};

type ValidSession = {
  readonly kind: 'session';
  readonly session: SessionRecord;
};

export type SessionReadResult =
  | { readonly kind: 'empty' }
  | ValidSession
  | InvalidSession
  | StorageFailure;

export type SessionWriteResult =
  | { readonly kind: 'saved' }
  | (InvalidSession & { readonly error: AuthError & { readonly kind: 'invalidResponse' } })
  | StorageFailure;

export type SessionDiscardResult = SessionRemoveResult | { readonly kind: 'changed' };

export type SessionRemoveResult =
  | { readonly kind: 'removed' }
  | StorageFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !/\s/.test(value);
}

// Accept ISO UTC timestamps with seconds and up to three fractional digits.
// A round trip rejects dates that do not exist.
function readExpiry(value: unknown): { iso: string; timestamp: number } | undefined {
  if (typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) {
    return undefined;
  }
  const canonical = value.replace(/(?:\.(\d{1,3}))?Z$/, (_match, fraction: string | undefined) =>
    '.' + (fraction ?? '').padEnd(3, '0') + 'Z');
  const timestamp = Date.parse(canonical);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== canonical) {
    return undefined;
  }
  return { iso: canonical, timestamp };
}

function validateSession(value: unknown, serverId: string): ValidSession | InvalidSession {
  if (!isRecord(value)) {
    return { kind: 'invalid', reason: 'malformed' };
  }
  if (value.schemaVersion !== 1) {
    return { kind: 'invalid', reason: 'unsupportedSchema' };
  }
  if (typeof value.serverId !== 'string') {
    return { kind: 'invalid', reason: 'malformed' };
  }
  if (value.serverId !== serverId) {
    return { kind: 'invalid', reason: 'wrongServer' };
  }
  const expires = readExpiry(value.expiresAt);
  if (!isIdentifier(value.uid) || !isIdentifier(value.token) || !expires) {
    return { kind: 'invalid', reason: 'malformed' };
  }
  if (expires.timestamp <= Date.now()) {
    return { kind: 'invalid', reason: 'expired' };
  }
  return {
    kind: 'session',
    // Pick SessionRecord fields explicitly to exclude passwords, codes, and other values.
    session: Object.freeze({
      schemaVersion: 1,
      serverId,
      uid: value.uid,
      token: value.token,
      expiresAt: expires.iso,
    }),
  };
}

function unavailable(action: StorageAction): StorageFailure {
  const messages: Record<StorageAction, ErrorMessageCode> = {
    read: 'storageRead',
    write: 'storageWrite',
    remove: 'storageRemove',
  };
  // Keep the original Error and record contents out of diagnostics.
  return {
    kind: 'unavailable',
    action,
    error: Object.freeze({
      kind: 'storageUnavailable',
      messageCode: messages[action],
      retryable: true,
    }),
  };
}

export class SessionStore {
  readonly key: string;
  readonly serverId: string;

  constructor(config: Readonly<ClientConfig>) {
    this.serverId = tinodeServerId(config);
    // Treat a relative base of ./ as root hosting, as the manifest does.
    const appBase = config.appBase === './' ? '/' : config.appBase;
    this.key = ['tinode-pwa-client', 'session', 'v1', config.appName, appBase, this.serverId]
      .map((part) => encodeURIComponent(part)).join(':');
  }

  read(): SessionReadResult {
    let raw: string | null;
    try {
      // Accessing localStorage can itself throw SecurityError.
      raw = window.localStorage.getItem(this.key);
    } catch {
      return unavailable('read');
    }
    return this.#decode(raw);
  }

  // Keep the storage event payload inside the session layer and out of React.
  readEvent(event: StorageEvent): SessionReadResult | undefined {
    try {
      if (event.storageArea !== window.localStorage ||
        (event.key !== this.key && event.key !== null)) return undefined;
    } catch {
      return undefined;
    }
    return this.#decode(event.newValue);
  }

  #decode(raw: string | null): SessionReadResult {
    if (raw === null) return { kind: 'empty' };
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return { kind: 'invalid', reason: 'malformed' };
    }
    return validateSession(value, this.serverId);
  }

  // Preserve any newer session another tab received while the request was in flight.
  removeIfCurrent(expected: SessionRecord): SessionDiscardResult {
    const current = this.read();
    if (current.kind === 'unavailable') return current;
    if (current.kind !== 'session' || current.session.uid !== expected.uid ||
      current.session.token !== expected.token || current.session.expiresAt !== expected.expiresAt) {
      return { kind: 'changed' };
    }
    return this.remove();
  }

  removeInvalid(): SessionDiscardResult {
    const current = this.read();
    if (current.kind === 'unavailable') return current;
    return current.kind === 'invalid' ? this.remove() : { kind: 'changed' };
  }

  // The controller calls this only after the adapter confirms the result.
  // Valid record structure does not establish that the server still accepts the token.
  write(session: SessionRecord): SessionWriteResult {
    const result = validateSession(session, this.serverId);
    if (result.kind === 'invalid') {
      return {
        ...result,
        error: Object.freeze({
          kind: 'invalidResponse',
          messageCode: 'invalidSessionRecord',
          retryable: false,
        }),
      };
    }
    try {
      window.localStorage.setItem(this.key, JSON.stringify(result.session));
      return { kind: 'saved' };
    } catch {
      return unavailable('write');
    }
  }

  remove(): SessionRemoveResult {
    try {
      window.localStorage.removeItem(this.key);
      return { kind: 'removed' };
    } catch {
      return unavailable('remove');
    }
  }
}
