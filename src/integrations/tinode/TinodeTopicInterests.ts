// Tracks logical ownership of topic attachment, independent of the SDK, packets, and history.
export type TinodeTopicRole = 'preview' | 'conversation' | 'muted' | 'notification' | 'departure';
export interface TinodeTopicInterest {
  readonly topic: string;
  readonly connected: boolean;
  // True means this interest must send and confirm the actual sub request.
  // False means an already confirmed attachment was reused.
  acquire(signal?: AbortSignal): Promise<boolean>;
  attached(): void;
  refused(): void;
  // True means the final owner must call leave(false) and complete cleanup.
  // Releasing the same token again always returns false.
  release(): boolean;
  detached(confirmed: boolean): void;
}
interface State {
  phase: 'idle' | 'attaching' | 'attached' | 'reconnecting' | 'leaving' | 'blocked';
  readonly owners: Map<object, TinodeTopicRole>;
  driver?: object;
  changed: Promise<void>;
  notify: () => void;
}
function wakeable(): Pick<State, 'changed' | 'notify'> {
  let notify!: () => void;
  const changed = new Promise<void>(resolve => { notify = resolve; });
  return { changed, notify };
}
export class TinodeTopicInterests {
  readonly #active: () => boolean;
  readonly #failure: (kind: 'closed' | 'invalidResponse') => Error;
  #closed = false;
  #states = new Map<string, State>();
  constructor(active: () => boolean, failure: (kind: 'closed' | 'invalidResponse') => Error) {
    this.#active = active; this.#failure = failure;
  }
  #wake(state: State): void {
    const previous = state.notify;
    Object.assign(state, wakeable());
    previous();
  }
  #assert(): void { if (this.#closed || !this.#active()) throw this.#failure('closed'); }
  create(topic: string, role: TinodeTopicRole): TinodeTopicInterest {
    this.#assert();
    if (!/^(?:usr|grp|chn)[A-Za-z0-9_-]+$/.test(topic) || !['preview', 'conversation', 'muted', 'notification', 'departure'].includes(role)) throw this.#failure('invalidResponse');
    let state = this.#states.get(topic);
    if (!state) { state = { phase: 'idle', owners: new Map(), ...wakeable() }; this.#states.set(topic, state); }
    const current = state, token = {};
    const active = () => !this.#closed && this.#active();
    let released = false, acquisition: Promise<boolean> | undefined;
    current.owners.set(token, role);
    const acquire = async (signal?: AbortSignal): Promise<boolean> => {
      while (true) {
        this.#assert();
        if (released || this.#states.get(topic) !== current || signal?.aborted) throw new DOMException('Topic interest cancelled.', 'AbortError');
        if (current.phase === 'blocked') throw this.#failure('invalidResponse');
        if (current.phase === 'attached') return false;
        if (current.phase === 'idle') { current.phase = 'attaching'; current.driver = token; return true; }
        let cancel!: () => void;
        const stopped = new Promise<never>((_, reject) => {
          cancel = () => reject(new DOMException('Topic interest cancelled.', 'AbortError'));
          signal?.addEventListener('abort', cancel, { once: true });
          if (signal?.aborted) cancel();
        });
        try { await Promise.race([current.changed, stopped]); }
        finally { signal?.removeEventListener('abort', cancel); }
      }
    };
    return Object.freeze({
      topic,
      get connected() { return active() && !released && current.owners.has(token) && current.phase === 'attached'; },
      acquire: (signal?: AbortSignal) => acquisition ??= acquire(signal),
      attached: () => {
        if (this.#closed || released || current.driver !== token || current.phase !== 'attaching') return;
        current.phase = 'attached'; current.driver = undefined; this.#wake(current);
      },
      refused: () => {
        if (this.#closed || current.driver !== token || current.phase !== 'attaching') return;
        current.phase = 'idle'; current.driver = undefined; this.#wake(current);
      },
      release: () => {
        if (released) return false;
        released = true; current.owners.delete(token); this.#wake(current);
        if (this.#closed || this.#states.get(topic) !== current) return false;
        if ((current.phase === 'attaching' && current.driver === token) ||
          (current.phase === 'attached' && current.owners.size === 0)) {
          current.phase = 'leaving'; current.driver = token; return true;
        }
        if (current.phase === 'idle' && current.owners.size === 0) this.#states.delete(topic);
        return false;
      },
      detached: (confirmed: boolean) => {
        if (this.#closed || current.phase !== 'leaving' || current.driver !== token) return;
        current.phase = confirmed ? 'idle' : 'blocked'; current.driver = undefined;
        this.#wake(current);
        if (confirmed && current.owners.size === 0) this.#states.delete(topic);
      },
    });
  }
  reconnect(topic: string, role: 'conversation' | 'notification' = 'conversation'): (connected: boolean) => void {
    this.#assert();
    const state = this.#states.get(topic);
    if (state?.phase !== 'attached' || ![...state.owners.values()].includes(role)) throw this.#failure('invalidResponse');
    state.phase = 'reconnecting';
    // The caller waits for the wire operation before releasing its interest.
    return connected => {
      if (this.#closed || state.phase !== 'reconnecting') return;
      state.phase = connected ? 'attached' : 'blocked';
      this.#wake(state);
    };
  }
  unsubscribed(topic: string): void {
    const state = this.#states.get(topic);
    if (!state) return;
    // Tinode already detached all interests for this subscription. Old releases must not send leave.
    this.#states.delete(topic);
    state.owners.clear();
    this.#wake(state);
  }
  isBlocked(topic: string): boolean { return this.#states.get(topic)?.phase === 'blocked'; }
  snapshot(): readonly { readonly topic: string; readonly phase: State['phase']; readonly roles: readonly TinodeTopicRole[] }[] {
    return Object.freeze([...this.#states].map(([topic, state]) => Object.freeze({ topic, phase: state.phase,
      roles: Object.freeze([...state.owners.values()]) })));
  }
  dispose(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const state of this.#states.values()) { state.owners.clear(); this.#wake(state); }
    this.#states.clear();
  }
}
