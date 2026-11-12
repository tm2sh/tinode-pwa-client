import type { GroupCreationPort } from '../../groups/group-creation-types';
import type { ContactSearchPort } from '../../contacts/contact-search-types';
import { Tinode } from 'tinode-sdk';
import type { AuthError, AuthFlow, AuthOperation, AuthOutcome, LoginCredentials, PendingEmailChallenge, RegistrationRequest, RegistrationRequirements, SessionRecord } from '../../auth/auth-types';
import type { ClientConfig } from '../../config/client-config';
import { tinodeServerId } from '../../config/server-id';
export { tinodeServerId } from '../../config/server-id';
import type { ErrorMessageCode } from '../../i18n/resources';
import { validateRegistration } from '../../auth/registration-validation';
import './sdk';
import type { TinodeSessionScope } from './TinodeSessionScope';
import type { OpenConversationPort } from '../../auth/auth-types';
import type { ChatListPort } from '../../chats/chat-list-types';
import type { OwnProfilePort } from '../../profile/own-profile-types';
import type { TinodeChatListAdapter } from './TinodeChatListAdapter';

type AuthenticationDraft =
  | { operation: 'login'; login: string; password: string }
  | { operation: 'register'; displayName: string; login: string; password: string; email?: string }
  | { operation: 'restore'; token: string; uid: string; expiresAt: string }
  | { operation: 'confirmEmail'; code: string };

// Expose a safe error without the original packet or cause.
export class TinodeAuthFailure extends Error {
  readonly authError: AuthError;

  constructor(error: AuthError) {
    super(error.messageCode);
    this.name = 'TinodeAuthFailure';
    this.authError = Object.freeze({ ...error });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function serverCode(value: unknown): number | undefined {
  return isRecord(value) && typeof value.code === 'number' &&
    Number.isInteger(value.code) && value.code >= 100 && value.code <= 599
    ? value.code : undefined;
}

function authError(
  kind: AuthError['kind'],
  messageCode: ErrorMessageCode,
  retryable: boolean,
  operation?: AuthOperation,
  code?: number,
): AuthError {
  return Object.freeze({
    kind, messageCode, retryable,
    ...(operation === undefined ? {} : { operation }),
    ...(code === undefined ? {} : { serverCode: code }),
  });
}

export function normalizeTinodeError(reason: unknown, operation?: AuthOperation): AuthError {
  if (reason instanceof TinodeAuthFailure) {
    return operation && reason.authError.operation === undefined
      ? { ...reason.authError, operation } : reason.authError;
  }

  const code = serverCode(reason);
  if (code === 504) {
    return authError('timeout', operation === 'register'
      ? 'registrationTimeout'
      : 'timeout', true, operation, code);
  }
  // The SDK also uses 503 for transport disconnects. Keep the session on that error.
  if (code === undefined || code === 503) {
    return authError('network', 'network', true, operation, code);
  }
  if (operation === 'restore' && [401, 403, 404, 410].includes(code)) {
    return authError('restoreRejected', 'restoreRejected', false, operation, code);
  }
  if (operation === 'confirmEmail' && code === 406) {
    return { ...authError('confirmationRequired',
      'confirmationRejected', false, operation, code), field: 'code' };
  }
  if (operation === 'login' && code === 401) {
    return authError('invalidCredentials', 'invalidCredentials', false, operation, code);
  }
  if (operation === 'register') {
    if (code === 409) return authError('serverDenied', 'registrationConflict', false, operation, code);
    if (code === 422) return authError('serverDenied', 'registrationPolicy', false, operation, code);
    if (code === 403 || code === 405) return authError('serverDenied', 'registrationDenied', false, operation, code);
    if (code === 400 || code === 406) return authError('serverDenied', 'invalidRegistrationData', false, operation, code);
  }
  return authError('serverDenied', 'serverDenied', code >= 500 || code === 429, operation, code);
}

function readRegistrationRequirements(info: unknown): RegistrationRequirements {
  const invalid = () => new TinodeAuthFailure(authError(
    'invalidResponse', 'invalidRegistrationRequirements', false, 'getRequirements',
  ));
  if (!isRecord(info) || !hasText(info.ver)) throw invalid();
  const credentials = info.reqCred;
  if (credentials !== undefined && !isRecord(credentials)) throw invalid();
  const required = credentials?.auth;
  if (required === undefined) return Object.freeze({ emailRequired: false });
  if (!Array.isArray(required) || required.some((method: unknown) => !hasText(method))) throw invalid();
  if (required.some((method: unknown) => method !== 'email')) {
    throw new TinodeAuthFailure(authError('unsupportedCredential', 'unsupportedCredential', false, 'getRequirements'));
  }
  return Object.freeze({ emailRequired: required.includes('email') });
}

// Read the token from the current ctrl 300 response to avoid using stale SDK state.
// If expiry is absent, let the server decide whether the token is still valid.
function readPendingEmailChallenge(
  response: unknown,
  sdk: Pick<Tinode, 'isAuthenticated' | 'getCurrentUserID'>,
  flow: AuthFlow,
  operation: AuthOperation,
  generation: number,
): PendingEmailChallenge {
  const code = serverCode(response);
  const params = isRecord(response) ? response.params : undefined;
  if (!isRecord(response) || code !== 300 || response.text !== 'validate credentials' ||
    !isRecord(params) || !Array.isArray(params.cred) || params.cred.length === 0 ||
    params.cred.some((method: unknown) => method !== 'email')) {
    throw new TinodeAuthFailure(authError(
      'unsupportedCredential', 'unsupportedCredential', false, operation, code,
    ));
  }
  const expires = params.expires;
  if (!hasText(params.user) || params.user !== sdk.getCurrentUserID() ||
    !hasText(params.token) || sdk.isAuthenticated() ||
    (expires !== undefined && (!(expires instanceof Date) ||
      !Number.isFinite(expires.getTime()) || expires.getTime() <= Date.now()))) {
    throw new TinodeAuthFailure(authError(
      'invalidResponse', 'invalidAuthResponse', false, operation, code,
    ));
  }
  return Object.freeze({
    flow, pendingToken: params.token,
    ...(expires instanceof Date ? { expiresAt: expires.toISOString() } : {}),
    methods: Object.freeze(['email'] as const), generation,
  });
}

// For integration use only. Parsing makes no SDK requests and returns only the public details
// of the pending verification.
export function normalizeTinodeAuthResponse(
  response: unknown,
  sdk: Pick<Tinode, 'isAuthenticated' | 'getCurrentUserID' | 'getAuthToken'>,
  context: { readonly serverId: string; readonly flow: AuthFlow; readonly operation: AuthOperation },
): AuthOutcome {
  const code = serverCode(response);
  const invalid = () => new TinodeAuthFailure(authError(
    'invalidResponse', 'invalidAuthResponse', false, context.operation, code,
  ));
  if (!isRecord(response) || code === undefined) {
    throw invalid();
  }
  if (code >= 400) {
    throw new TinodeAuthFailure(normalizeTinodeError(response, context.operation));
  }
  const params = response.params;
  if (code === 300) {
    const challenge = readPendingEmailChallenge(response, sdk, context.flow, context.operation, 0);
    return {
      kind: 'pendingEmail', challenge: { flow: challenge.flow },
      ...(context.operation === 'confirmEmail' ? { error: authError(
        'confirmationRequired', 'confirmationIncomplete', false, context.operation, code,
      ) } : {}),
    };
  }
  if (code < 200 || code >= 300) throw invalid();

  const uid = sdk.getCurrentUserID();
  const token = sdk.getAuthToken();
  // Check fields against the current reply because the SDK can retain values from a previous sign-in.
  if (!isRecord(params) || !hasText(uid) || params.user !== uid ||
    !token || !hasText(token.token) || params.token !== token.token ||
    !(token.expires instanceof Date) || !Number.isFinite(token.expires.getTime()) ||
    token.expires.getTime() <= Date.now() || !(params.expires instanceof Date) ||
    params.expires.getTime() !== token.expires.getTime()) {
    throw invalid();
  }

  if (!sdk.isAuthenticated()) {
    throw invalid();
  }
  return {
    kind: 'authenticated',
    identity: { uid },
    session: {
      schemaVersion: 1, serverId: context.serverId, uid,
      token: token.token, expiresAt: token.expires.toISOString(),
    },
  };
}

// In this release, hello.catch() can reconnect even after disconnect().
// Detach the application callbacks first. A temporary guard stops a late connection.
// Remove the guard after the close event and queued promise callbacks have run.
function retireSdk(sdk: Tinode): void {
  let detachTimer: ReturnType<typeof setTimeout> | undefined;
  const detach = () => {
    sdk.onConnect = undefined;
    sdk.onDisconnect = undefined;
    sdk.onLogin = undefined;
  };
  const stop = () => {
    sdk.disconnect();
    if (detachTimer === undefined) {
      detachTimer = setTimeout(detach, 0);
    }
  };
  sdk.onMessage = undefined;
  sdk.onLogin = undefined;
  sdk.onConnect = stop;
  sdk.onDisconnect = stop;
  sdk.disconnect();
}

const activeAdapters = new Set<TinodeAuthAdapter>();
let scopeGenerationSequence = 0;

export class TinodeAuthAdapter {
  readonly serverId: string;
  #config: Readonly<ClientConfig>;
  #sdk: Tinode | undefined;
  #generation = 0;
  #scopeGeneration = ++scopeGenerationSequence;
  #confirmedUid: string | undefined;
  #sessionScope: TinodeSessionScope | undefined;
  #sessionScopePromise: Promise<TinodeSessionScope> | undefined;
  #chatListPort: TinodeChatListAdapter | undefined;
  #chatListPortPromise: Promise<ChatListPort> | undefined;
  #authInFlight = false;
  #pendingEmail: PendingEmailChallenge | undefined;
  #pendingUserId: string | undefined;
  #challengeGeneration = 0;
  #disposed = false;
  #failure: Error | undefined;
  #readyPromise: Promise<void> | undefined;
  #resolveReady: (() => void) | undefined;
  #rejectReady: ((error: Error) => void) | undefined;
  #readyTimer: ReturnType<typeof setTimeout> | undefined;
  #serverVersion: string | undefined;
  #onDisconnect: ((error: AuthError) => void) | undefined;

  constructor(config: Readonly<ClientConfig>, onDisconnect?: (error: AuthError) => void) {
    this.#config = config;
    this.serverId = tinodeServerId(config);
    this.#onDisconnect = onDisconnect;
  }

  get serverVersion(): string | undefined {
    return this.#serverVersion;
  }

  // Load the scope module on first use after sign-in has been confirmed.
  openSessionScope(): Promise<TinodeSessionScope> {
    const sdk = this.#sdk;
    const uid = this.#confirmedUid;
    const generation = this.#scopeGeneration;
    const current = () => !this.#disposed && !this.#authInFlight &&
      this.#scopeGeneration === generation && this.#sdk === sdk && this.#confirmedUid === uid;
    if (!sdk || !uid || !current() || !sdk.isConnected() ||
      !sdk.isAuthenticated() || sdk.getCurrentUserID() !== uid) {
      return Promise.reject(this.#cancelled());
    }
    if (this.#sessionScope?.active) return Promise.resolve(this.#sessionScope);
    if (this.#sessionScopePromise) return this.#sessionScopePromise;
    this.#sessionScope?.dispose();
    this.#sessionScope = undefined;
    const pending = import('./TinodeSessionScope').then(({ TinodeSessionScope }) => {
      if (!current()) throw this.#cancelled();
      const scope = new TinodeSessionScope(sdk, { serverId: this.serverId, uid, generation }, current,
        import.meta.env?.DEV ? window.location.origin : undefined);
      this.#sessionScope = scope;
      return scope;
    }).finally(() => {
      if (this.#sessionScopePromise === pending) this.#sessionScopePromise = undefined;
    });
    this.#sessionScopePromise = pending;
    return pending;
  }

  // Create the port lazily on the existing authenticated SDK without opening another socket.
  openChatListPort(): Promise<ChatListPort> {
    const sdk = this.#sdk;
    const uid = this.#confirmedUid;
    const generation = this.#scopeGeneration;
    const current = () => !this.#disposed && !this.#authInFlight && this.#sdk === sdk &&
      this.#confirmedUid === uid && this.#scopeGeneration === generation;
    if (!sdk || !uid || !current() || !sdk.isConnected() || !sdk.isAuthenticated()) {
      return Promise.reject(this.#cancelled());
    }
    if (this.#chatListPort?.active) return Promise.resolve(this.#chatListPort);
    if (this.#chatListPortPromise) return this.#chatListPortPromise;
    const pending = Promise.all([this.openSessionScope(), import('./TinodeChatListAdapter')])
      .then(([scope, { TinodeChatListAdapter }]) => {
        if (!current() || !scope.active) throw this.#cancelled();
        const port = new TinodeChatListAdapter(scope);
        this.#chatListPort = port;
        return port;
      }).finally(() => {
        if (this.#chatListPortPromise === pending) this.#chatListPortPromise = undefined;
      });
    this.#chatListPortPromise = pending;
    return pending;
  }

  async openGroupCreationPort(): Promise<GroupCreationPort> {
    const [scope, { TinodeGroupCreationAdapter }] = await Promise.all([
      this.openSessionScope(), import('./TinodeGroupCreationAdapter'),
    ]);
    if (!scope.active) throw this.#cancelled();
    return new TinodeGroupCreationAdapter(scope);
  }

  async openContactSearchPort(): Promise<ContactSearchPort> {
    const [scope, { TinodeContactSearchAdapter }] = await Promise.all([
      this.openSessionScope(), import('./TinodeContactSearchAdapter'),
    ]);
    if (!scope.active) throw this.#cancelled();
    return new TinodeContactSearchAdapter(scope);
  }

  async openOwnProfilePort(): Promise<OwnProfilePort> {
    const [scope, { TinodeProfileAdapter }] = await Promise.all([
      this.openSessionScope(), import('./TinodeProfileAdapter'),
    ]);
    if (!scope.active) throw this.#cancelled();
    return new TinodeProfileAdapter(scope);
  }

  readonly openConversationPort: OpenConversationPort = async (topicKey, handoff) => {
    const sdk = this.#sdk, uid = this.#confirmedUid, generation = this.#scopeGeneration;
    const current = () => !this.#disposed && !this.#authInFlight && this.#sdk === sdk &&
      this.#confirmedUid === uid && this.#scopeGeneration === generation && handoff.active &&
      sdk?.isConnected() && sdk.isAuthenticated() && sdk.getCurrentUserID() === uid;
    if (!sdk || !uid || !current() || !/^(?:usr|grp|chn)[A-Za-z0-9_-]+$/.test(topicKey) ||
      handoff.account.uid !== uid || handoff.account.serverId !== this.serverId || handoff.account.generation !== generation) throw this.#cancelled();
    const [scope, { TinodeConversationAdapter }] = await Promise.all([
      this.openSessionScope(), import('./TinodeConversationAdapter'),
    ]);
    if (!current() || !scope.active || scope.account.uid !== uid || scope.account.generation !== generation) throw this.#cancelled();
    return new TinodeConversationAdapter(scope, topicKey, handoff);
  };

  // The controller receives only whether the context can be used. It receives neither the token nor the user ID.
  get canConfirmEmail(): boolean {
    const challenge = this.#pendingEmail;
    return !this.#disposed && challenge !== undefined &&
      challenge.generation === this.#challengeGeneration &&
      (challenge.expiresAt === undefined || Date.parse(challenge.expiresAt) > Date.now());
  }

  // Use one promise and one SDK instance per lifecycle. Create a new adapter after failure.
  ready(): Promise<void> {
    if (this.#disposed) {
      return Promise.reject(this.#failure ?? this.#cancelled());
    }
    if (this.#readyPromise) {
      return this.#readyPromise;
    }
    this.#readyPromise = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    activeAdapters.add(this);
    const generation = this.#generation;
    const current = () => !this.#disposed && this.#generation === generation;
    this.#readyTimer = setTimeout(() => {
      this.#fail({ ...authError('timeout', 'connectionTimeout', true),
        messageParams: { seconds: this.#config.connectionTimeoutMs / 1000 } });
    }, this.#config.connectionTimeoutMs);

    try {
      const sdk = new Tinode({
        appName: this.#config.appName,
        host: this.#config.host,
        apiKey: this.#config.apiKey,
        secure: this.#config.secure,
        transport: this.#config.transport,
        persist: false,
        platform: 'web',
      });
      this.#sdk = sdk;
      sdk.enableLogging(false);
      sdk.onConnect = () => {
        if (!current()) return;
        const info = sdk.getServerInfo();
        if (!info || !hasText(info.ver)) {
          this.#fail(authError('invalidResponse', 'missingServerVersion', false));
          return;
        }
        this.#serverVersion = info.ver;
        this.#clearReadyTimer();
        this.#resolveReady?.();
        this.#resolveReady = undefined;
        this.#rejectReady = undefined;
      };
      sdk.onDisconnect = (reason) => {
        if (current()) this.#fail(normalizeTinodeError(reason));
      };
      // Wait for onConnect after hello before reporting readiness. An open socket alone is insufficient.
      void sdk.connect().catch((reason: unknown) => {
        if (current()) this.#fail(normalizeTinodeError(reason));
      });
    } catch (reason: unknown) {
      this.#fail(normalizeTinodeError(reason));
    }
    return this.#readyPromise;
  }

  async getRequirements(signal?: AbortSignal): Promise<RegistrationRequirements> {
    const generation = this.#generation;
    const abort = () => this.dispose();
    if (signal?.aborted) throw this.#cancelled();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      await this.ready();
      this.#assertAuthCurrent(generation, signal);
      if (!this.#sdk?.isConnected()) {
        throw new TinodeAuthFailure(authError('network', 'connectionLost', true, 'getRequirements'));
      }
      return readRegistrationRequirements(this.#sdk.getServerInfo());
    } catch (reason: unknown) {
      this.#assertAuthCurrent(generation, signal);
      if (reason instanceof DOMException && reason.name === 'AbortError') throw reason;
      throw new TinodeAuthFailure(normalizeTinodeError(reason, 'getRequirements'));
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  register(credentials: RegistrationRequest, signal?: AbortSignal): Promise<AuthOutcome> {
    return this.#authenticate({
      operation: 'register', displayName: credentials.displayName,
      login: credentials.login, password: credentials.password,
      ...(credentials.email === undefined ? {} : { email: credentials.email }),
    }, signal);
  }

  login(credentials: LoginCredentials, signal?: AbortSignal): Promise<AuthOutcome> {
    return this.#authenticate({ operation: 'login', login: credentials.login, password: credentials.password }, signal);
  }

  restore(session: SessionRecord, signal?: AbortSignal): Promise<AuthOutcome> {
    if (session.serverId !== this.serverId) {
      return Promise.reject(new TinodeAuthFailure(authError(
        'invalidResponse', 'wrongServerSession', false, 'restore',
      )));
    }
    return this.#authenticate({
      operation: 'restore', token: session.token, uid: session.uid, expiresAt: session.expiresAt,
    }, signal);
  }

  confirmEmail(code: string, signal?: AbortSignal): Promise<AuthOutcome> {
    return this.#authenticate({ operation: 'confirmEmail', code }, signal);
  }

  #clearPendingEmail(): void {
    this.#pendingEmail = undefined;
    this.#pendingUserId = undefined;
    this.#challengeGeneration += 1;
  }

  #assertPendingEmail(challenge: PendingEmailChallenge | undefined): asserts challenge is PendingEmailChallenge {
    if (!challenge || challenge !== this.#pendingEmail ||
      challenge.generation !== this.#challengeGeneration ||
      (challenge.expiresAt !== undefined && !(Date.parse(challenge.expiresAt) > Date.now()))) {
      this.#clearPendingEmail();
      throw new TinodeAuthFailure(authError(
        'confirmationRequired', 'confirmationUnavailable', false, 'confirmEmail',
      ));
    }
  }

  async #authenticate(draft: AuthenticationDraft, signal?: AbortSignal): Promise<AuthOutcome> {
    const clear = () => {
      if (draft.operation === 'login') { draft.login = ''; draft.password = ''; }
      else if (draft.operation === 'register') { draft.displayName = ''; draft.login = ''; draft.password = ''; draft.email = ''; }
      else if (draft.operation === 'restore') draft.token = '';
      else draft.code = '';
    };
    if (this.#disposed || signal?.aborted) {
      clear();
      throw signal?.aborted ? this.#cancelled() : this.#failure ?? this.#cancelled();
    }
    if (this.#authInFlight) {
      clear();
      throw new TinodeAuthFailure(authError(
        'validation', 'operationInProgress', false, draft.operation,
      ));
    }
    let challenge: PendingEmailChallenge | undefined;
    const expectedUid = draft.operation === 'confirmEmail' ? this.#pendingUserId : undefined;
    if (draft.operation === 'confirmEmail') {
      challenge = this.#pendingEmail;
      try {
        this.#assertPendingEmail(challenge);
        if (typeof draft.code !== 'string' || draft.code.trim() === '') {
          throw new TinodeAuthFailure({
            ...authError('validation', 'codeRequired', false, 'confirmEmail'), field: 'code',
          });
        }
      } catch (reason: unknown) {
        clear();
        throw reason;
      }
    } else {
      this.#clearPendingEmail();
    }
    this.#authInFlight = true;
    this.#dropSessionScope();
    const generation = this.#generation;
    const abort = () => { clear(); this.dispose(); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      await this.ready();
      this.#assertAuthCurrent(generation, signal);
      const sdk = this.#sdk;
      if (!sdk || !sdk.isConnected()) {
        throw new TinodeAuthFailure(authError(
          'network', 'connectionLost', true, draft.operation,
        ));
      }
      if (draft.operation === 'restore' && !(Date.parse(draft.expiresAt) > Date.now())) {
        throw new TinodeAuthFailure(authError(
          'restoreRejected', 'restoreRejected', false, 'restore',
        ));
      }
      let reply;
      if (draft.operation === 'login') {
        reply = sdk.loginBasic(draft.login, draft.password);
      } else if (draft.operation === 'register') {
        if (sdk.isAuthenticated()) {
          throw new TinodeAuthFailure(authError('validation', 'registrationUnavailable', false, 'register'));
        }
        const requirements = readRegistrationRequirements(sdk.getServerInfo());
        const error = validateRegistration(draft, requirements);
        if (error) throw new TinodeAuthFailure(error);
        const credentials = requirements.emailRequired ? Tinode.credential({ meth: 'email', val: draft.email }) : undefined;
        if (requirements.emailRequired && !credentials) {
          throw new TinodeAuthFailure(authError('invalidResponse', 'invalidRegistrationRequirements', false, 'register'));
        }
        reply = sdk.createAccountBasic(draft.login, draft.password, {
          public: { fn: draft.displayName },
          ...(requirements.emailRequired ? { cred: credentials } : {}),
        });
        // The SDK has already serialized acc. The contact value is no longer needed while awaiting the reply.
        for (const credential of credentials ?? []) credential.val = '';
      } else if (draft.operation === 'restore') {
        reply = sdk.loginToken(draft.token);
      } else {
        this.#assertPendingEmail(challenge);
        const credentials = Tinode.credential({ meth: 'email', resp: draft.code });
        reply = sdk.loginToken(challenge.pendingToken, credentials);
        // The SDK serializes credential synchronously, so the code can be cleared before waiting.
        for (const credential of credentials ?? []) credential.resp = '';
      }
      // The SDK has already serialized secret. Clear the temporary copy before awaiting the reply.
      clear();
      const response = await reply;
      this.#assertAuthCurrent(generation, signal);
      if (this.#sdk !== sdk) throw this.#cancelled();
      const outcome = normalizeTinodeAuthResponse(response, sdk, {
        serverId: this.serverId, flow: challenge?.flow ?? (draft.operation === 'register' ? 'registration' : 'login'), operation: draft.operation,
      });
      if ((draft.operation === 'restore' && sdk.getCurrentUserID() !== draft.uid) ||
        (draft.operation === 'confirmEmail' && sdk.getCurrentUserID() !== expectedUid)) {
        throw new TinodeAuthFailure(authError(
          'invalidResponse', 'differentAccount', false, draft.operation,
        ));
      }
      if (outcome.kind === 'pendingEmail') {
        this.#pendingEmail = readPendingEmailChallenge(
          response, sdk, outcome.challenge.flow, draft.operation, this.#challengeGeneration,
        );
        this.#pendingUserId = sdk.getCurrentUserID() ?? undefined;
      } else {
        this.#clearPendingEmail();
        this.#confirmedUid = outcome.identity.uid;
      }
      return outcome;
    } catch (reason: unknown) {
      this.#assertAuthCurrent(generation, signal);
      if (reason instanceof DOMException && reason.name === 'AbortError') throw reason;
      const error = normalizeTinodeError(reason, draft.operation);
      if (['invalidResponse', 'unsupportedCredential'].includes(error.kind)) {
        this.#clearPendingEmail();
      }
      throw new TinodeAuthFailure(error);
    } finally {
      clear();
      signal?.removeEventListener('abort', abort);
      this.#authInFlight = false;
    }
  }

  #assertAuthCurrent(generation: number, signal?: AbortSignal): void {
    if (signal?.aborted) throw this.#cancelled();
    if (this.#disposed || generation !== this.#generation) {
      throw this.#failure ?? this.#cancelled();
    }
  }

  dispose(): void {
    if (!this.#disposed) this.#close(this.#cancelled());
  }

  #cancelled(): DOMException {
    return new DOMException('Authentication operation cancelled.', 'AbortError');
  }

  #clearReadyTimer(): void {
    clearTimeout(this.#readyTimer);
    this.#readyTimer = undefined;
  }

  #fail(error: AuthError): void {
    if (this.#disposed) return;
    const wasReady = this.#serverVersion !== undefined;
    const onDisconnect = this.#onDisconnect;
    this.#close(new TinodeAuthFailure(error));
    if (wasReady) onDisconnect?.(error);
  }

  #dropSessionScope(): void {
    this.#scopeGeneration = ++scopeGenerationSequence;
    const port = this.#chatListPort;
    this.#chatListPort = undefined;
    this.#chatListPortPromise = undefined;
    port?.dispose();
    this.#confirmedUid = undefined;
    this.#sessionScopePromise = undefined;
    const scope = this.#sessionScope;
    this.#sessionScope = undefined;
    scope?.dispose();
  }

  #close(error: Error): void {
    this.#disposed = true;
    this.#generation += 1;
    this.#dropSessionScope();
    this.#clearPendingEmail();
    this.#failure = error;
    this.#clearReadyTimer();
    this.#rejectReady?.(error);
    this.#resolveReady = undefined;
    this.#rejectReady = undefined;
    this.#serverVersion = undefined;
    this.#onDisconnect = undefined;
    const sdk = this.#sdk;
    this.#sdk = undefined;
    activeAdapters.delete(this);
    if (sdk) retireSdk(sdk);
  }
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    for (const adapter of activeAdapters) adapter.dispose();
  });
}
