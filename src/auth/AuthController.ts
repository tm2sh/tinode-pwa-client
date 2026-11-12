import type { OpenGroupCreationPort } from '../groups/group-creation-types';
import type { OpenContactSearchPort } from '../contacts/contact-search-types';
import type { AuthError, AuthOperation, AuthOutcome, AuthSnapshot, ClientConfig, LoginCredentials, PendingEmailInfo, RegistrationCredentials, RegistrationRequirements, SessionRecord } from './auth-types';
import { validateRegistration } from './registration-validation';
import { SessionStore } from './SessionStore';
import type { InvalidSessionReason, SessionReadResult } from './SessionStore';
import { TinodeAuthAdapter, TinodeAuthFailure, normalizeTinodeError } from '../integrations/tinode/TinodeAuthAdapter';

import type { OpenConversationPort } from './auth-types';
import type { ChatListPort } from '../chats/chat-list-types';
import type { OwnProfilePort } from '../profile/own-profile-types';

type Listener = () => void;
type OperationResult = { readonly kind: 'registrationReady'; readonly requirements: RegistrationRequirements; readonly error?: AuthError }
  | AuthOutcome;

interface OperationOptions {
  readonly operation?: AuthOperation;
  readonly pending: AuthSnapshot;
  readonly run: (adapter: TinodeAuthAdapter, signal: AbortSignal) => Promise<OperationResult>;
  readonly errorSnapshot: (error: AuthError) => AuthSnapshot;
  readonly clearSensitive?: () => void;
  readonly storedAtStart?: SessionReadResult;
}

interface Operation {
  readonly authOperation: AuthOperation | undefined;
  readonly storedAtStart: SessionReadResult;
  readonly errorSnapshot: (error: AuthError) => AuthSnapshot;
  readonly generation: number;
  readonly abort: AbortController;
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  clearSensitive: (() => void) | undefined;
}

// Pick public snapshot fields explicitly to keep raw errors, control packets, and causes private.
function publicError(error: AuthError): AuthError {
  return Object.freeze({
    kind: error.kind,
    messageCode: error.messageCode,
    ...(error.causeCode === undefined ? {} : { causeCode: error.causeCode }),
    ...(error.messageParams?.seconds === undefined ? {} : {
      messageParams: Object.freeze({ seconds: error.messageParams.seconds }),
    }),
    retryable: error.retryable,
    ...(error.operation === undefined ? {} : { operation: error.operation }),
    ...(error.field === undefined ? {} : { field: error.field }),
    ...(error.serverCode === undefined ? {} : { serverCode: error.serverCode }),
  });
}

function freezeSnapshot(snapshot: AuthSnapshot): AuthSnapshot {
  if ('requirements' in snapshot && snapshot.requirements) Object.freeze(snapshot.requirements);
  if ('identity' in snapshot) Object.freeze(snapshot.identity);
  if ('challenge' in snapshot) Object.freeze(snapshot.challenge);
  if ('error' in snapshot && snapshot.error) Object.freeze(snapshot.error);
  if ('warning' in snapshot && snapshot.warning) Object.freeze(snapshot.warning);
  return Object.freeze(snapshot);
}

function changedSessionError(): AuthError {
  return {
    kind: 'sessionChanged', operation: 'restore', retryable: false,
    messageCode: 'sessionChanged',
  };
}

function invalidSessionError(reason: InvalidSessionReason): AuthError {
  return {
    kind: 'restoreRejected', operation: 'restore', retryable: false,
    messageCode: reason === 'expired' ? 'sessionExpired'
      : 'invalidSession',
  };
}

const activeControllers = new Set<AuthController>();

export class AuthController {
  #config: Readonly<ClientConfig>;
  #store: SessionStore;
  #snapshot: AuthSnapshot = freezeSnapshot({ phase: 'checkingSession' });
  #listeners = new Set<Listener>();
  #adapter: TinodeAuthAdapter | undefined;
  #generation = 0;
  #operation: Operation | undefined;
  #initialization: Promise<void> | undefined;
  #disposed = false;
  #managedOwnership = false;
  #owners = 0;
  #ownershipVersion = 0;
  #session: SessionRecord | undefined;
  #storageLinked = false;
  #expiryTimer: ReturnType<typeof setTimeout> | undefined;
  #watching = false;

  constructor(config: Readonly<ClientConfig>) {
    this.#config = config;
    this.#store = new SessionStore(config);
    // Read only here so the first render knows whether a saved token needs validation.
    // Session cleanup, listeners, and the connection are handled by initialize and attach.
    this.#snapshot = freezeSnapshot(this.#store.read().kind === 'session'
      ? { phase: 'checkingSession' } : { phase: 'signedOut', flow: 'login' });
  }

  readonly getSnapshot = (): AuthSnapshot => this.#snapshot;

  readonly subscribe = (listener: Listener): (() => void) => {
    if (this.#disposed) return () => {};
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };

  get busy(): boolean {
    return this.#operation !== undefined;
  }

  // Deferring disposal lets the controller survive React StrictMode's setup, cleanup, and setup.
  // Without an owner, commits stop immediately, before the disposal microtask runs.
  attach(): () => void {
    if (this.#disposed) return () => {};
    this.#managedOwnership = true;
    this.#owners += 1;
    this.#ownershipVersion += 1;
    let attached = true;
    return () => {
      if (!attached) return;
      attached = false;
      this.#owners -= 1;
      const version = ++this.#ownershipVersion;
      queueMicrotask(() => {
        if (this.#owners === 0 && this.#ownershipVersion === version) this.dispose();
      });
    };
  }

  readonly login = (credentials: LoginCredentials): Promise<void> => {
    if (!this.#canRun()) return Promise.resolve();
    // The first input event can arrive before the shell's passive effect runs.
    void this.initialize();
    if (this.#operation) return this.#operation.promise;
    if (this.#snapshot.phase === 'authenticated' || this.#snapshot.phase === 'pendingEmail') {
      return Promise.resolve();
    }
    const login = typeof credentials?.login === 'string' ? credentials.login : '';
    const password = typeof credentials?.password === 'string' ? credentials.password : '';
    const missingLogin = login.trim() === '';
    const missingPassword = password === '';
    if (missingLogin || missingPassword) {
      const error: AuthError = {
        kind: 'validation', operation: 'login', retryable: false,
        messageCode: missingLogin && missingPassword ? 'credentialsRequired'
          : missingLogin ? 'loginRequired' : 'passwordRequired',
        ...(missingLogin === missingPassword ? {} : { field: missingLogin ? 'login' : 'password' }),
      };
      this.#publish({ phase: 'signedOut', flow: 'login', error: publicError(error) });
      return Promise.resolve();
    }
    const draft = { login, password };
    return this.#runOperation({
      operation: 'login',
      pending: { phase: 'submitting', flow: 'login', operation: 'login' },
      run: (adapter, signal) => adapter.login(draft, signal),
      clearSensitive: () => { draft.login = ''; draft.password = ''; },
      errorSnapshot: (error) => ({ phase: 'signedOut', flow: 'login', error }),
    });
  };

  readonly openRegistration = (): Promise<void> => {
    if (!this.#canRun() || !this.#config.registrationEnabled) return Promise.resolve();
    void this.initialize();
    if (this.#operation) return this.#operation.promise;
    if (this.#snapshot.phase !== 'signedOut') return Promise.resolve();
    return this.#runOperation({
      operation: 'getRequirements',
      pending: { phase: 'loadingRequirements', flow: 'registration' },
      run: async (adapter, signal) => ({ kind: 'registrationReady', requirements: await adapter.getRequirements(signal) }),
      errorSnapshot: (error) => this.#registrationFailure(error),
    });
  };

  readonly register = (credentials: RegistrationCredentials): Promise<void> => {
    if (!this.#canRun() || !this.#config.registrationEnabled) return Promise.resolve();
    if (this.#operation) return this.#operation.promise;
    if (this.#snapshot.phase !== 'signedOut' || this.#snapshot.flow !== 'registration') return Promise.resolve();
    const requirements = this.#snapshot.requirements;
    if (!requirements) {
      this.#publish(this.#registrationFailure({
        kind: 'validation', operation: 'getRequirements', messageCode: 'registrationRequirementsUnavailable', retryable: true,
      }));
      return Promise.resolve();
    }
    const draft = {
      displayName: typeof credentials?.displayName === 'string' ? credentials.displayName : '',
      login: typeof credentials?.login === 'string' ? credentials.login : '',
      password: typeof credentials?.password === 'string' ? credentials.password : '',
      passwordRepeat: typeof credentials?.passwordRepeat === 'string' ? credentials.passwordRepeat : '',
      ...(requirements.emailRequired ? { email: typeof credentials?.email === 'string' ? credentials.email : '' } : {}),
    };
    const clear = () => { draft.displayName = ''; draft.login = ''; draft.password = ''; draft.passwordRepeat = ''; draft.email = ''; };
    const error = validateRegistration(draft, requirements);
    if (error) {
      clear();
      this.#publish(this.#registrationFailure(error, requirements));
      return Promise.resolve();
    }
    return this.#runOperation({
      operation: 'register',
      pending: { phase: 'submitting', flow: 'registration', operation: 'register', requirements },
      run: async (adapter, signal) => {
        const current = await adapter.getRequirements(signal);
        if (current.emailRequired !== requirements.emailRequired) {
          return { kind: 'registrationReady', requirements: current, error: {
            kind: 'validation', operation: 'getRequirements', messageCode: 'registrationRequirementsChanged', retryable: false,
          } };
        }
        return adapter.register(draft, signal);
      },
      clearSensitive: clear,
      errorSnapshot: (error) => this.#registrationFailure(error, requirements),
    });
  };

  #registrationFailure(error: AuthError, requirements?: RegistrationRequirements): AuthSnapshot {
    return {
      phase: 'signedOut', flow: 'registration',
      ...(requirements ? { requirements: { emailRequired: requirements.emailRequired } } : {}),
      error: publicError({ ...error,
        ...(error.kind === 'network' && error.operation === 'register' ? { messageCode: 'registrationNetwork' as const } : {}),
      }),
    };
  }

  readonly confirmEmail = (code: string): Promise<void> => {
    if (!this.#canRun()) return Promise.resolve();
    if (this.#operation) return this.#operation.promise;
    if (this.#snapshot.phase !== 'pendingEmail') return Promise.resolve();
    const challenge = this.#snapshot.challenge;
    if (!this.#adapter?.canConfirmEmail) {
      this.#closeContext({
        kind: 'confirmationRequired', operation: 'confirmEmail', retryable: false,
        messageCode: 'confirmationUnavailable',
      });
      return Promise.resolve();
    }
    if (typeof code !== 'string' || code.trim() === '') {
      this.#publish({ phase: 'pendingEmail', challenge, error: publicError({
        kind: 'validation', operation: 'confirmEmail', field: 'code', retryable: false,
        messageCode: 'codeRequired',
      }) });
      return Promise.resolve();
    }
    const draft = { code };
    return this.#runOperation({
      operation: 'confirmEmail',
      pending: { phase: 'confirming', challenge },
      run: (adapter, signal) => adapter.confirmEmail(draft.code, signal),
      clearSensitive: () => { draft.code = ''; },
      errorSnapshot: (error) => this.#confirmationFailure(error, challenge),
    });
  };

  #confirmationFailure(error: AuthError, challenge: PendingEmailInfo): AuthSnapshot {
    if (this.#adapter?.canConfirmEmail) {
      return { phase: 'pendingEmail', challenge, error };
    }
    return { phase: 'signedOut', flow: 'login', error: publicError({
      ...error, messageCode: 'confirmationContextLost', causeCode: error.messageCode,
    }) };
  }

  initialize(): Promise<void> {
    if (!this.#canRun()) return Promise.resolve();
    this.#initialization ??= this.#beginRestore();
    return this.#initialization;
  }

  readonly retryRestore = (): Promise<void> => {
    if (!this.#canRun()) return Promise.resolve();
    if (this.#operation) return this.#operation.promise;
    if (this.#snapshot.phase !== 'restoreError') return Promise.resolve();
    this.#invalidate();
    return this.#beginRestore();
  };

  // Explicit recovery of an unsafe conversation Scope. Only this owner restores the token.
  readonly reconnectSession = (): Promise<void> => {
    if (!this.#canRun()) return Promise.resolve();
    if (this.#operation) return this.#operation.promise;
    if (this.#snapshot.phase === 'restoreError') return this.retryRestore();
    if (this.#snapshot.phase !== 'authenticated') return Promise.resolve();
    this.#invalidate();
    return this.#beginRestore();
  };

  #beginRestore(): Promise<void> {
    this.#startWatching();
    let stored = this.#store.read();
    let readError: AuthError | undefined;
    if (stored.kind === 'invalid') {
      const error = invalidSessionError(stored.reason);
      const discarded = this.#store.removeInvalid();
      if (discarded.kind === 'changed') {
        stored = this.#store.read();
      } else {
        readError = discarded.kind === 'unavailable'
          ? { ...discarded.error, messageCode: stored.reason === 'expired'
            ? 'expiredSessionRemovalFailed' : 'invalidSessionRemovalFailed' } : error;
      }
    }
    if (!readError) {
      readError = stored.kind === 'unavailable' ? stored.error
        : stored.kind === 'invalid' ? invalidSessionError(stored.reason) : undefined;
    }
    const session = stored.kind === 'session' ? stored.session : undefined;
    this.#session = session;
    this.#storageLinked = session !== undefined;
    if (!session) {
      this.#publish({ phase: 'signedOut', flow: 'login',
        ...(readError ? { error: publicError(readError) } : {}) });
      return this.#prepareConnection();
    }
    return this.#runOperation({
      operation: 'restore', storedAtStart: stored,
      pending: { phase: 'checkingSession' },
      run: (adapter, signal) => adapter.restore(session, signal),
      errorSnapshot: (error) => this.#restoreFailure(error, session),
    });
  }

  async #prepareConnection(): Promise<void> {
    const generation = this.#generation;
    let adapter: TinodeAuthAdapter | undefined;
    try {
      adapter = this.#getAdapter();
      await adapter.ready();
    } catch (reason: unknown) {
      // A background result cannot finish or replace a user-initiated operation.
      if (!this.#canRun() || this.#generation !== generation || this.#adapter !== adapter ||
        this.#operation || this.#snapshot.phase !== 'signedOut' || this.#snapshot.flow !== 'login') return;
      this.#dropAdapter();
      this.#publish({ phase: 'signedOut', flow: 'login',
        error: publicError(normalizeTinodeError(reason)) });
    }
  }

  readonly openChatListPort = async (): Promise<ChatListPort> => {
    const adapter = this.#adapter;
    const generation = this.#generation;
    const uid = this.#snapshot.phase === 'authenticated' ? this.#snapshot.identity.uid : undefined;
    const current = () => this.#canRun() && this.#adapter === adapter && this.#generation === generation &&
      this.#snapshot.phase === 'authenticated' && this.#snapshot.identity.uid === uid;
    if (!adapter || !uid || !current()) throw new DOMException('Chat list context closed.', 'AbortError');
    const port = await adapter.openChatListPort();
    if (!current()) {
      port.dispose();
      throw new DOMException('Chat list context closed.', 'AbortError');
    }
    return port;
  };

  readonly openGroupCreationPort: OpenGroupCreationPort = async () => {
    const adapter = this.#adapter, generation = this.#generation;
    const uid = this.#snapshot.phase === 'authenticated' ? this.#snapshot.identity.uid : undefined;
    const current = () => this.#canRun() && this.#adapter === adapter && this.#generation === generation &&
      this.#snapshot.phase === 'authenticated' && this.#snapshot.identity.uid === uid;
    if (!adapter || !uid || !current()) throw new DOMException('Group creation context closed.', 'AbortError');
    const port = await adapter.openGroupCreationPort();
    if (!current() || port.account.uid !== uid || port.account.serverId !== adapter.serverId) {
      throw new DOMException('Group creation context closed.', 'AbortError');
    }
    return port;
  };

  readonly openContactSearchPort: OpenContactSearchPort = async () => {
    const adapter = this.#adapter, generation = this.#generation;
    const uid = this.#snapshot.phase === 'authenticated' ? this.#snapshot.identity.uid : undefined;
    const current = () => this.#canRun() && this.#adapter === adapter && this.#generation === generation &&
      this.#snapshot.phase === 'authenticated' && this.#snapshot.identity.uid === uid;
    if (!adapter || !uid || !current()) throw new DOMException('Contact search context closed.', 'AbortError');
    const port = await adapter.openContactSearchPort();
    if (!current() || port.account.uid !== uid || port.account.serverId !== adapter.serverId) {
      port.dispose();
      throw new DOMException('Contact search context closed.', 'AbortError');
    }
    return port;
  };

  readonly openOwnProfilePort = async (): Promise<OwnProfilePort> => {
    const adapter = this.#adapter, generation = this.#generation;
    const uid = this.#snapshot.phase === 'authenticated' ? this.#snapshot.identity.uid : undefined;
    const current = () => this.#canRun() && this.#adapter === adapter && this.#generation === generation &&
      this.#snapshot.phase === 'authenticated' && this.#snapshot.identity.uid === uid;
    if (!adapter || !uid || !current()) throw new DOMException('Profile context closed.', 'AbortError');
    const port = await adapter.openOwnProfilePort();
    if (!current() || port.account.uid !== uid || port.account.serverId !== adapter.serverId) {
      throw new DOMException('Profile context closed.', 'AbortError');
    }
    return port;
  };

  readonly openConversationPort: OpenConversationPort = async (topicKey, handoff) => {
    const adapter = this.#adapter, generation = this.#generation;
    const uid = this.#snapshot.phase === 'authenticated' ? this.#snapshot.identity.uid : undefined;
    const current = () => this.#canRun() && this.#adapter === adapter && this.#generation === generation &&
      this.#snapshot.phase === 'authenticated' && this.#snapshot.identity.uid === uid && handoff.active;
    if (!adapter || !uid || !current() || handoff.account.uid !== uid || handoff.account.serverId !== adapter.serverId) {
      throw new DOMException('Conversation context closed.', 'AbortError');
    }
    const port = await adapter.openConversationPort(topicKey, handoff);
    if (!current() || port.topicKey !== topicKey || port.account.uid !== uid || port.account.serverId !== handoff.account.serverId ||
      port.account.generation !== handoff.account.generation) {
      await port.close(); throw new DOMException('Conversation context closed.', 'AbortError');
    }
    return port;
  };

  readonly logout = (): void => {
    if (!this.#canRun()) return;
    // Isolate the SDK and any late replies before removing this session's own storage key.
    this.#invalidate();
    const removed = this.#store.remove();
    this.#publish({
      phase: 'signedOut', flow: 'login',
      ...(removed.kind === 'unavailable' ? {
        error: publicError({ ...removed.error, operation: 'logout' }),
      } : {}),
    });
  };

  cancel(): void {
    if (this.#disposed) return;
    this.#invalidate();
    this.#publish({ phase: 'signedOut', flow: 'login' });
    // Keep initialize idempotent. Cancellation does not trigger an automatic retry.
  }

  returnToLogin(): void {
    this.cancel();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#stopWatching();
    this.#invalidate();
    this.#publish({ phase: 'signedOut', flow: 'login' });
    this.#listeners.clear();
    activeControllers.delete(this);
  }

  #runOperation(options: OperationOptions): Promise<void> {
    if (!this.#canRun()) return Promise.resolve();
    if (this.#operation) return this.#operation.promise;

    this.#startWatching();
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    const operation: Operation = {
      authOperation: options.operation,
      storedAtStart: options.storedAtStart ?? this.#store.read(),
      errorSnapshot: options.errorSnapshot,
      generation: this.#generation,
      abort: new AbortController(),
      promise,
      resolve,
      clearSensitive: options.clearSensitive,
    };
    // Reserve the operation slot and promise before publishing state or awaiting anything.
    this.#operation = operation;
    activeControllers.add(this);
    this.#publish(options.pending);
    if (this.#isCurrent(operation)) {
      void this.#execute(operation, options);
    }
    return promise;
  }

  async #execute(operation: Operation, options: OperationOptions): Promise<void> {
    try {
      const result = await options.run(this.#getAdapter(), operation.abort.signal);
      if (!this.#isCurrent(operation)) return;
      this.#clearSensitive(operation);
      if (!this.#isCurrent(operation)) return;

      const authResult = result.kind !== 'registrationReady';
      const current = authResult ? this.#readForCommit(operation) : undefined;
      if (authResult && current === undefined) return;
      // Keep the generation check, storage write, and new snapshot synchronous.
      const snapshot = this.#resultSnapshot(result, operation, current);
      if (this.#isCurrent(operation)) this.#finish(operation, snapshot);
    } catch (reason: unknown) {
      if (!this.#isCurrent(operation)) return;
      if (reason instanceof DOMException && reason.name === 'AbortError') {
        this.cancel();
        return;
      }
      const error = publicError(normalizeTinodeError(reason, options.operation));
      // A wrong code or a timeout on a live connection allows retrying the same challenge.
      if (operation.authOperation !== 'confirmEmail' || !this.#adapter?.canConfirmEmail) {
        this.#dropAdapter();
      }
      this.#clearSensitive(operation);
      if (this.#isCurrent(operation)) {
        this.#finish(operation, options.errorSnapshot(error));
      }
    } finally {
      this.#clearSensitive(operation);
      // An earlier finally block must not release a newer operation's slot.
      if (this.#operation === operation) this.#operation = undefined;
      operation.resolve();
    }
  }

  #resultSnapshot(result: OperationResult, operation: Operation, current?: SessionReadResult): AuthSnapshot {
    if (result.kind === 'registrationReady') {
      return {
        phase: 'signedOut', flow: 'registration',
        requirements: { emailRequired: result.requirements.emailRequired },
        ...(result.error ? { error: publicError(result.error) } : {}),
      };
    }
    if (result.kind === 'pendingEmail') {
      const previous = operation.storedAtStart;
      if (operation.authOperation === 'restore' && previous.kind === 'session') {
        const discarded = this.#store.removeIfCurrent(previous.session);
        if (discarded.kind === 'changed') {
          this.#dropAdapter();
          return this.#updatedRestoreSnapshot(previous.session);
        }
        if (discarded.kind === 'unavailable') {
          this.#dropAdapter();
          return { phase: 'restoreError', error: publicError({ ...discarded.error, operation: 'restore' }) };
        }
      }
      return {
        phase: 'pendingEmail',
        challenge: {
          flow: result.challenge.flow,
          ...(result.challenge.contactHint === undefined ? {} : { contactHint: result.challenge.contactHint }),
        },
        ...(result.error === undefined ? {} : { error: publicError(result.error) }),
      };
    }

    if (result.identity.uid !== result.session.uid) {
      throw new TinodeAuthFailure({
        kind: 'invalidResponse', messageCode: 'inconsistentAccount', retryable: false,
      });
    }
    const previous = operation.storedAtStart;
    const preserveRefresh = operation.authOperation === 'restore' && previous.kind === 'session' &&
      current?.kind === 'session' && (current.session.token !== previous.session.token ||
        current.session.expiresAt !== previous.session.expiresAt);
    const session = preserveRefresh && current?.kind === 'session' ? current.session : result.session;
    const saved = preserveRefresh ? { kind: 'saved' as const } : this.#store.write(session);
    if (saved.kind === 'invalid') throw new TinodeAuthFailure(saved.error);
    this.#session = session;
    this.#storageLinked = saved.kind === 'saved';
    return {
      phase: 'authenticated',
      identity: { uid: result.identity.uid },
      ...(saved.kind === 'unavailable' ? {
        warning: { ...publicError(saved.error), kind: 'storageUnavailable' as const },
      } : {}),
    };
  }

  #getAdapter(): TinodeAuthAdapter {
    if (!this.#adapter) {
      const adapter = new TinodeAuthAdapter(this.#config, (error) => {
        // A callback from an old instance cannot affect the new operation.
        if (!this.#canRun() || this.#adapter !== adapter) return;
        const operation = this.#operation;
        const safe = publicError({
          ...publicError(error),
          ...(operation?.authOperation === undefined ? {} : { operation: operation.authOperation }),
        });
        const snapshot = operation ? operation.errorSnapshot(safe)
          : this.#session
            ? this.#restoreFailure(safe, this.#session)
            : this.#snapshot.phase === 'pendingEmail'
              ? this.#confirmationFailure(safe, this.#snapshot.challenge)
              : this.#snapshot.phase === 'signedOut' && this.#snapshot.flow === 'registration'
                ? this.#registrationFailure(safe, this.#snapshot.requirements)
                : { phase: 'signedOut' as const, flow: 'login' as const, error: safe };
        this.#invalidate();
        this.#publish(snapshot);
      });
      this.#adapter = adapter;
    }
    return this.#adapter;
  }

  #restoreFailure(error: AuthError, expected: SessionRecord): AuthSnapshot {
    const current = this.#store.read();
    if (current.kind === 'empty' ||
      (current.kind === 'session' && current.session.uid !== expected.uid)) {
      return { phase: 'signedOut', flow: 'login', error: changedSessionError() };
    }
    if (current.kind === 'invalid') {
      const discarded = this.#store.removeInvalid();
      if (discarded.kind === 'changed') return this.#updatedRestoreSnapshot(expected);
      return { phase: 'signedOut', flow: 'login', error: discarded.kind === 'unavailable'
        ? discarded.error : invalidSessionError(current.reason) };
    }
    if (current.kind === 'unavailable') {
      return { phase: 'restoreError', error: current.error };
    }
    this.#session = current.session;
    this.#storageLinked = true;
    if (error.kind === 'restoreRejected' ||
      (error.serverCode !== undefined && [401, 403, 404, 410].includes(error.serverCode))) {
      if (current.session.token !== expected.token || current.session.expiresAt !== expected.expiresAt) {
        return this.#updatedRestoreSnapshot(expected);
      }
      const discarded = this.#store.removeIfCurrent(expected);
      if (discarded.kind === 'changed') return this.#updatedRestoreSnapshot(expected);
      return { phase: 'signedOut', flow: 'login', error: discarded.kind === 'unavailable'
        ? discarded.error : {
          kind: 'restoreRejected', operation: 'restore', retryable: false,
          messageCode: 'restoreRejected',
        } };
    }
    // Network errors, timeouts, and unexpected responses do not establish that the token is invalid.
    return { phase: 'restoreError', error };
  }

  #updatedRestoreSnapshot(expected: SessionRecord): AuthSnapshot {
    const current = this.#store.read();
    if (current.kind === 'session' && current.session.uid === expected.uid) {
      this.#session = current.session;
      this.#storageLinked = true;
      return { phase: 'restoreError', error: {
        kind: 'sessionChanged', operation: 'restore', retryable: true,
        messageCode: 'sessionRefreshed',
      } };
    }
    if (current.kind === 'unavailable') return { phase: 'restoreError', error: current.error };
    return { phase: 'signedOut', flow: 'login', error: changedSessionError() };
  }

  #readForCommit(operation: Operation): SessionReadResult | undefined {
    const current = this.#store.read();
    const previous = operation.storedAtStart;
    if (current.kind === 'unavailable') {
      // Allow manual sign-in without storage and show a warning that the session was not saved.
      if (previous.kind === 'unavailable' &&
        (operation.authOperation === 'login' || operation.authOperation === 'register' || operation.authOperation === 'confirmEmail')) return current;
      throw new TinodeAuthFailure(current.error);
    }
    const unchangedAccount = previous.kind === 'session'
      ? current.kind === 'session' && current.session.uid === previous.session.uid
      : current.kind !== 'session';
    if (unchangedAccount) return current;
    if (current.kind === 'invalid') {
      const discarded = this.#store.removeInvalid();
      if (discarded.kind === 'changed') {
        const latest = this.#store.read();
        if (latest.kind === 'session' && previous.kind === 'session' &&
          latest.session.uid === previous.session.uid) return latest;
        if (latest.kind === 'unavailable') throw new TinodeAuthFailure(latest.error);
      }
      this.#closeContext(discarded.kind === 'unavailable' ? discarded.error : invalidSessionError(current.reason));
      return undefined;
    }
    // Check storage again before committing because its event may not have arrived yet.
    this.#closeContext(changedSessionError());
    return undefined;
  }

  #closeContext(error: AuthError): void {
    this.#invalidate();
    this.#publish({ phase: 'signedOut', flow: 'login', error: publicError(error) });
  }

  #startWatching(): void {
    if (this.#watching) return;
    this.#watching = true;
    window.addEventListener('storage', this.#onStorage);
    window.addEventListener('focus', this.#onResume);
    window.addEventListener('pageshow', this.#onResume);
    document.addEventListener('visibilitychange', this.#onResume);
  }

  #stopWatching(): void {
    this.#watching = false;
    window.removeEventListener('storage', this.#onStorage);
    window.removeEventListener('focus', this.#onResume);
    window.removeEventListener('pageshow', this.#onResume);
    document.removeEventListener('visibilitychange', this.#onResume);
    clearTimeout(this.#expiryTimer);
    this.#expiryTimer = undefined;
  }

  #onStorage = (event: StorageEvent): void => {
    if (!this.#canRun() || (!this.#session && !this.#operation && this.#snapshot.phase !== 'pendingEmail' &&
      !(this.#snapshot.phase === 'signedOut' && this.#snapshot.flow === 'registration'))) return;
    const incoming = this.#store.readEvent(event);
    if (!incoming) return;
    const baseline = this.#operation?.storedAtStart;
    const uid = this.#session?.uid ?? (baseline?.kind === 'session' ? baseline.session.uid : undefined);
    if (incoming.kind === 'session' && incoming.session.uid === uid) {
      const latest = this.#store.read();
      if (latest.kind === 'unavailable') return;
      if (latest.kind === 'session' && latest.session.uid === uid) {
        if (this.#session) { this.#session = latest.session; this.#storageLinked = true; }
        this.#scheduleExpiry();
        return;
      }
    }
    this.#closeContext(changedSessionError());
  };

  #onResume = (): void => {
    if (document.visibilityState !== 'hidden') this.#checkSession();
  };

  #scheduleExpiry(): void {
    clearTimeout(this.#expiryTimer);
    this.#expiryTimer = undefined;
    if (!this.#canRun() || !this.#session) return;
    const delay = Math.max(0, Math.min(2_147_483_647, Date.parse(this.#session.expiresAt) - Date.now()));
    this.#expiryTimer = setTimeout(() => this.#checkSession(), delay);
  }

  #checkSession(): void {
    if (!this.#canRun() || !this.#session) return;
    // If persistence fails, keep the confirmed session in memory.
    // Storage events still close it when another account signs in.
    if (!this.#storageLinked) {
      if (Date.parse(this.#session.expiresAt) <= Date.now()) this.#closeContext(invalidSessionError('expired'));
      else this.#scheduleExpiry();
      return;
    }
    const current = this.#store.read();
    if (current.kind === 'session' && current.session.uid === this.#session.uid) {
      this.#session = current.session;
      this.#scheduleExpiry();
      return;
    }
    if (current.kind === 'unavailable') {
      if (Date.parse(this.#session.expiresAt) <= Date.now()) this.#closeContext(current.error);
      else this.#scheduleExpiry();
      return;
    }
    if (current.kind === 'invalid') {
      const discarded = this.#store.removeInvalid();
      if (discarded.kind === 'changed') {
        const latest = this.#store.read();
        if (latest.kind === 'session' && latest.session.uid === this.#session.uid) {
          this.#session = latest.session;
          this.#scheduleExpiry();
          return;
        }
      }
      this.#closeContext(discarded.kind === 'unavailable' ? discarded.error : invalidSessionError(current.reason));
      return;
    }
    this.#closeContext(changedSessionError());
  }

  #canRun(): boolean {
    return !this.#disposed && (!this.#managedOwnership || this.#owners > 0);
  }

  #isCurrent(operation: Operation): boolean {
    return this.#canRun() && this.#operation === operation &&
      operation.generation === this.#generation && !operation.abort.signal.aborted;
  }

  #finish(operation: Operation, snapshot: AuthSnapshot): void {
    if (!this.#isCurrent(operation)) return;
    this.#operation = undefined;
    operation.resolve();
    this.#publish(snapshot);
  }

  #clearSensitive(operation: Operation): void {
    const clear = operation.clearSensitive;
    operation.clearSensitive = undefined;
    try {
      clear?.();
    } catch {
      console.error('Authentication form cleanup failed.');
    }
  }

  #dropAdapter(): void {
    const adapter = this.#adapter;
    this.#adapter = undefined;
    adapter?.dispose();
  }

  #invalidate(): void {
    this.#generation += 1;
    const operation = this.#operation;
    this.#operation = undefined;
    // Detach the instance before stopping work associated with it.
    this.#dropAdapter();
    if (operation) {
      operation.abort.abort();
      this.#clearSensitive(operation);
      operation.resolve();
    }
  }

  #publish(snapshot: AuthSnapshot): void {
    this.#snapshot = freezeSnapshot(snapshot);
    if (!['checkingSession', 'authenticated', 'restoreError'].includes(snapshot.phase)) {
      this.#session = undefined;
      this.#storageLinked = false;
    }
    this.#scheduleExpiry();
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch {
        // A listener error must not leave the operation busy or expose raw data.
        console.error('Authentication subscriber notification failed.');
      }
    }
  }
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    for (const controller of activeControllers) controller.dispose();
  });
}
