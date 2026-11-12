import type { AuthSnapshot } from '../auth/auth-types';
import type { ConversationController } from './ConversationController';
import type { ConversationCheckpoint, ConversationIdentity } from './conversation-types';

const active = new Set<ConversationContinuation>();
// Loaded with ConversationRoute, owned above the authenticated branch. No SDK/storage/history.
export class ConversationContinuation {
  #state: ConversationCheckpoint | undefined;
  #pendingResume = false;
  #authorized = false;
  #binding: { readonly controller: ConversationController; readonly detach: () => void } | undefined;

  constructor(identity: ConversationIdentity) {
    this.#state = Object.freeze({ identity, draft: '', atEnd: true, outgoing: Object.freeze([]) });
  }
  matches(identity: ConversationIdentity): boolean {
    const old = this.#state?.identity;
    return !!old && old.account.serverId === identity.account.serverId && old.account.uid === identity.account.uid &&
      old.topicKey === identity.topicKey && old.kind === identity.kind;
  }
  get resumeTarget(): ConversationIdentity | undefined {
    return this.#pendingResume && this.#authorized ? this.#state?.identity : undefined;
  }
  readFor(identity: ConversationIdentity): ConversationCheckpoint | undefined {
    if (!this.#pendingResume || !this.#authorized || !this.matches(identity)) return;
    if (this.#state!.identity.account.generation === identity.account.generation) throw new Error('A fresh authenticated Scope is required.');
    return this.#state;
  }
  bind(controller: ConversationController): () => void {
    if (!this.matches(controller.identity)) throw new Error('Conversation account changed.');
    this.#binding?.detach();
    const capture = () => {
      if (this.#binding !== binding) return;
      const state = controller.getContinuationState();
      if (state) this.#state = state;
    };
    const binding = { controller, detach: controller.subscribeContinuation(capture) };
    this.#binding = binding;
    this.#pendingResume = false; this.#authorized = true;
    active.add(this); capture();
    return () => {
      if (this.#binding !== binding) return;
      capture(); binding.detach(); this.#binding = undefined;
    };
  }
  synchronizeAuth(snapshot: AuthSnapshot, serverId: string): void {
    const identity = this.#state?.identity;
    if (!identity) return;
    if (identity.account.serverId !== serverId ||
      (snapshot.phase === 'authenticated' && snapshot.identity.uid !== identity.account.uid)) { this.clear(); return; }
    if (snapshot.phase === 'restoreError' || snapshot.phase === 'checkingSession') {
      const binding = this.#binding, latest = binding?.controller.getContinuationState();
      if (latest) this.#state = latest;
      binding?.detach(); this.#binding = undefined;
      this.#pendingResume = true; this.#authorized = false;
      // No offline queue: work not yet published stays visibly unsent; in-flight work stays uncertain.
      // A fresh Scope restarts verification at the new server head, without a retired history cursor.
      const state = this.#state!;
      this.#state = Object.freeze({ ...state, outgoing: Object.freeze(state.outgoing.flatMap(row =>
        row.operation.phase === 'cancelled' || row.operation.phase === 'confirmed' ? []
          : [Object.freeze({ ...(row.text === undefined ? {} : { text: row.text }),
              ...(row.submittedDraftIds === undefined ? {} : { submittedDraftIds: row.submittedDraftIds }), ...(row.photo === undefined ? {} : { photo: { filename: row.photo.filename } }),
              // The controller checkpoint has already removed the local audio capability.
              ...(row.voice === undefined ? {} : { voice: row.voice }), operation: Object.freeze(row.operation.phase === 'preparing'
            ? { ...row.operation, phase: 'rejected' as const, error: Object.freeze({ area: 'send' as const,
              kind: 'network' as const, messageCode: row.operation.kind === 'edit' ? 'conversationEditRejected' as const : 'conversationSendRejected' as const, retryable: true }) }
            : row.operation.phase === 'publishing' ? { ...row.operation, phase: 'unknown' as const,
              messageCode: 'conversationSendUnknown' as const } : row.operation) })])) });
      void binding?.controller.suspend();
    } else if (snapshot.phase === 'authenticated') {
      this.#authorized = true;
    } else this.clear();
  }
  clear(): void {
    const binding = this.#binding;
    this.#binding = undefined; binding?.detach();
    this.#state = undefined; this.#pendingResume = false; this.#authorized = false;
    active.delete(this); void binding?.controller.close();
  }
}
if (import.meta.hot) import.meta.hot.dispose(() => { for (const continuation of active) continuation.clear(); active.clear(); });
