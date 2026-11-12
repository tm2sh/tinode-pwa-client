import type { OpenConversationPort } from '../auth/auth-types';
import type { ChatPreviewPause } from '../chats/chat-list-types';
import type { ConversationDraftPort } from '../conversation/ConversationDraft';
import type { ConversationHeaderPreview, ConversationIdentity, ConversationPort } from '../conversation/conversation-types';

// Keep the navigation owner lightweight so the controller and screen stay in a lazy chunk.
export class ConversationNavigation {
  readonly identity: ConversationIdentity;
  readonly generation: number;
  readonly headerPreview: ConversationHeaderPreview | undefined;
  readonly draftPort?: ConversationDraftPort;
  readonly #handoff: ChatPreviewPause;
  readonly #factory: OpenConversationPort;
  readonly #previous: Promise<void>;
  #active = true;
  #ports = new Set<ConversationPort>();
  #pending = new Set<Promise<ConversationPort>>();
  #closePromise: Promise<void> | undefined;

  constructor(identity: ConversationIdentity, handoff: ChatPreviewPause, factory: OpenConversationPort, previous: Promise<void>, headerPreview?: ConversationHeaderPreview,
    draftPort?: ConversationDraftPort) {
    this.identity = Object.freeze({ topicKey: identity.topicKey, kind: identity.kind,
      account: Object.freeze({ serverId: identity.account.serverId, uid: identity.account.uid, generation: identity.account.generation }) });
    this.headerPreview = headerPreview && headerPreview.kind === identity.kind ? Object.freeze({
      ...(headerPreview.participantCount === undefined ? {} : { participantCount: Object.freeze({ ...headerPreview.participantCount }) }),
      ...(headerPreview.kind === 'group' && headerPreview.isChannel === true ? { isChannel: true as const } : {}),
      kind: headerPreview.kind, title: Object.freeze({ ...headerPreview.title }), avatar: Object.freeze({ ...headerPreview.avatar }),
    }) : undefined;
    this.generation = handoff.navigationGeneration;
    this.draftPort = draftPort;
    this.#handoff = handoff; this.#factory = factory; this.#previous = previous;
  }
  get active(): boolean { return this.#active && this.#handoff.active; }
  readonly openPort = (): Promise<ConversationPort> => {
    if (!this.active) return Promise.reject(this.#cancelled());
    const request = this.#open();
    this.#pending.add(request);
    void request.then(() => this.#pending.delete(request), () => this.#pending.delete(request));
    return request;
  };
  async #open(): Promise<ConversationPort> {
    await this.#previous;
    if (!this.active) throw this.#cancelled();
    const parent = this.#handoff;
    let port: ConversationPort | undefined, released = false;
    // The child lease ends with the port. The parent keeps previews paused through loading,
    // errors, and retries until the navigation closes safely.
    const child: ChatPreviewPause = Object.freeze({ account: parent.account, navigationGeneration: parent.navigationGeneration,
      get active() { return !released && parent.active; },
      waitTopicIdle: (topic: string, signal?: AbortSignal) => parent.waitTopicIdle(topic, signal),
      refreshPreview: (topic: string, change: 'message' | 'delete') => {
        if (!released) parent.refreshPreview(topic, change);
      },
      blockTopic: (topic: string) => parent.blockTopic(topic),
      release: () => { if (released) return; released = true; if (port) this.#ports.delete(port); },
    });
    try {
      port = await this.#factory(this.identity.topicKey, child);
      if (!released) this.#ports.add(port);
      if (!this.active || released) {
        await port.close(); throw this.#cancelled();
      }
      return port;
    } catch (reason: unknown) {
      // Before the factory creates a port, the child lease does not own a server stream.
      if (!port) child.release();
      throw reason;
    }
  }
  #cancelled(): DOMException { return new DOMException('Conversation navigation closed.', 'AbortError'); }
  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#active = false;
    this.#closePromise = Promise.resolve().then(async () => {
      try {
        // If the factory resolves late, it closes the port without exposing it to the screen.
        await Promise.allSettled([...this.#pending]);
        await Promise.all([...this.#ports].map(async port => {
          try { await port.close(); }
          catch { this.#handoff.blockTopic(this.identity.topicKey); }
        }));
      } finally {
        this.#ports.clear(); this.#handoff.release();
      }
    });
    return this.#closePromise;
  }
}
