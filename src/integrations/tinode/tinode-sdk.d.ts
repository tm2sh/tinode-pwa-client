// Local declarations for the tinode-sdk v0.26.0-alpha3 API used by the client.
// Verified against commit 7f2960efd816847d932c513c3b138174722034bf.
// These declarations neither change the SDK nor validate server data at runtime.
declare module 'tinode-sdk' {
  export interface TinodeConfig {
    appName: string;
    host: string;
    apiKey: string;
    secure: boolean;
    transport: 'ws';
    persist: boolean;
    platform?: 'web' | 'ios' | 'android';
  }

  export interface TinodeCredential {
    meth: string;
    val?: string;
    resp?: string;
    params?: Record<string, unknown>;
  }

  export interface TinodeAccountParams {
    public?: { fn: string };
    cred?: TinodeCredential[] | null;
  }

  // Read queries used by the chat list and conversation scope.
  export interface TinodeGetQuery {
    // getMeta merges the supplied fields, including id, into the get packet.
    readonly id?: string;
    readonly what: 'desc' | 'sub' | 'data' | 'del' | 'sub data';
    readonly desc?: { readonly ims?: Date };
    readonly sub?: {
      // Send the epoch as a string. The SDK omits Date(0) during serialization.
      readonly ims?: Date | '1970-01-01T00:00:00.000Z';
      readonly limit?: number;
      readonly topic?: string;
      readonly user?: string;
    };
    readonly data?: { readonly since?: number; readonly before?: number; readonly limit?: number };
    // For public MetaGetBuilder.withLaterDel, since is a deletion transaction ID.
    readonly del?: { readonly since?: number; readonly limit?: number };
  }

  export interface TinodeControlMessage {
    readonly id?: string;
    readonly topic?: string;
    readonly code: number;
    readonly text?: string;
    readonly ts?: Date;
    // The adapter validates fields before creating internal models.
    readonly params?: Readonly<Record<string, unknown>>;
  }

  // Public Tinode.createMessage/publishMessage; raw drafts stay inside SessionScope.
  export interface TinodeTextContent { readonly txt: string }
  export interface TinodeDraftyMediaContent extends TinodeTextContent {
    readonly fmt: readonly { readonly at: number; readonly len: 1; readonly key: number }[];
    readonly ent: readonly { readonly tp: 'IM' | 'AU'; readonly data: Readonly<Record<string, string | number>> }[];
  }
  export interface TinodeLargeFileHelper {
    uploadWithBaseUrl(baseUrl: string, data: Blob, avatarFor: undefined,
      onProgress: (fraction: number) => void, onSuccess: (ctrl: unknown) => void,
      onFailure: (ctrl: unknown) => void): Promise<unknown>;
    cancel(): void;
  }
  export interface TinodePublishMessage {
    readonly id?: string;
    readonly topic: string;
    readonly content: TinodeTextContent;
    readonly noecho?: boolean;
    head?: { readonly mime: 'text/x-drafty'; readonly 'x-tinode-pwa-id': string; readonly replace?: string; readonly reply?: string; readonly thread?: string; readonly forwarded?: string };
  }

  export interface TinodeGroupCreationParams {
    readonly desc: {
      readonly public: { readonly fn: string; readonly photo?: { readonly type: 'jpeg' | 'png'; readonly data: string } };
      readonly private: Readonly<Record<string, string>>;
    };
  }

  export interface TinodeDiscoveryQuery {
    readonly desc: { readonly public: string };
  }

  export interface TinodeAuthToken {
    readonly token: string;
    readonly expires: Date;
  }

  export type TinodeServerInfo = Readonly<Record<string, unknown>>;

  export class Tinode {
    constructor(
      config: TinodeConfig,
      onComplete?: (error?: unknown) => void,
    );

    static getVersion(): string;

    static credential(credential: TinodeCredential): TinodeCredential[] | null;
    static credential(
      method: string,
      value?: string,
      params?: Record<string, unknown>,
      response?: string,
    ): TinodeCredential[] | null;

    // In this release, the SDK calls onConnect without arguments after hello.
    onConnect: (() => void) | undefined;
    onDisconnect: ((error: unknown) => void) | undefined;
    onLogin: ((code: number, text?: string) => void) | undefined;
    // Called synchronously before internal routing. Validate the payload at runtime.
    onMessage: ((packet: unknown) => void) | undefined;

    // The promise resolves when the socket opens. Wait for onConnect to confirm server readiness.
    connect(host?: string): Promise<void>;
    disconnect(): void;
    isConnected(): boolean;
    isAuthenticated(): boolean;
    getServerInfo(): TinodeServerInfo | null;
    getServerParam(name: string, defaultValue?: unknown): unknown;

    // A resolved promise can carry ctrl 300 while sign-in is still incomplete.
    loginBasic(
      login: string,
      password: string,
      credentials?: TinodeCredential[] | null,
    ): Promise<TinodeControlMessage>;

    createAccountBasic(
      login: string,
      password: string,
      params?: TinodeAccountParams,
    ): Promise<TinodeControlMessage>;

    loginToken(
      token: string,
      credentials?: TinodeCredential[] | null,
    ): Promise<TinodeControlMessage>;

    // A sub.get promise can resolve on metadata before the separate attach ACK.
    subscribe(topic: string, query?: TinodeGetQuery | null, params?: { readonly sub: { readonly mode: string } } | TinodeGroupCreationParams): Promise<unknown>;
    // The reply can be metadata or a control packet for an empty or complete result. Validate it before use.
    getMeta(topic: string, query: TinodeGetQuery): Promise<unknown>;
    // Public setMeta generates its own ID. Callers cannot supply one.
    setMeta(topic: string, params: { readonly sub: { readonly mode: string } | { readonly user: string } } | {
      readonly desc: { readonly public: {
        readonly fn?: string;
        readonly photo?: { readonly type: 'jpeg' | 'png'; readonly data: string; readonly ref: '␡' } | '␡';
      } };
    } | { readonly desc: { readonly private: Readonly<Record<string, string>> } } | TinodeDiscoveryQuery): Promise<unknown>;
    delMessages(topic: string, ranges: readonly { readonly low: number; readonly hi?: number }[], hard: boolean): Promise<unknown>;
    delTopic(topic: string, hard: boolean): Promise<TinodeControlMessage>;
    delSubscription(topic: string, user: string): Promise<TinodeControlMessage>;
    leave(topic: string, unsub: boolean): Promise<TinodeControlMessage>;
    // Fire-and-forget. Returning from this call does not confirm server receipt.
    note(topic: string, what: 'read' | 'recv', seq: number): void;

    createMessage(topic: string, content: TinodeTextContent, noEcho?: boolean): TinodePublishMessage;
    publishMessage(message: TinodePublishMessage, attachments?: string[]): Promise<unknown>;
    getLargeFileHelper(): TinodeLargeFileHelper;

    // The public SDK adds authorization only to relative URLs.
    authorizeURL(url: string): string;

    getAuthToken(): TinodeAuthToken | null;
    // A user ID may be available during verification. Check isAuthenticated() for sign-in status.
    getCurrentUserID(): string | null | undefined;
    newGroupTopicName(isChannel: boolean): string;
    getNextUniqueId(): string | undefined;
    enableLogging(enabled: boolean, trimLongStrings?: boolean): void;
  }
}
