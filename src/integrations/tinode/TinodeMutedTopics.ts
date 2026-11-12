import { TinodeSessionFailure } from './TinodeSessionScope';
import type { TinodeSessionObject, TinodeSessionScope } from './TinodeSessionScope';
import type { TinodeTopicInterest } from './TinodeTopicInterests';

const flags = 'JRWPASDO';
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function bits(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 255) return value;
  if (typeof value !== 'string' || (value !== 'N' && !/^[JRWPASDO]+$/.test(value))) return;
  return [...(value === 'N' ? '' : value)].reduce((n, flag) => n | (1 << flags.indexOf(flag)), 0);
}
export function isMutedSubscription(value: unknown): value is Record<string, unknown> & { topic: string } {
  if (!record(value) || typeof value.topic !== 'string' || !/^(?:usr|grp|chn)[A-Za-z0-9_-]+$/.test(value.topic) || (value.deleted !== undefined && value.deleted !== null && value.deleted !== false) || !record(value.acs)) return false;
  const want = bits(value.acs.want), given = bits(value.acs.given), supplied = bits(value.acs.mode);
  const mode = want !== undefined && given !== undefined ? want & given : supplied;
  if (value.acs.mode !== undefined && (supplied === undefined || supplied !== mode)) return false;
  return mode !== undefined && (mode & 3) === 3 && (mode & 8) === 0;
}
interface Entry {
  readonly topic: string;
  readonly interest: TinodeTopicInterest;
  readonly abort: AbortController;
  state: 'queued' | 'attaching' | 'ready' | 'failed' | 'closing';
  stopped: boolean;
}

// Does not create an SDK, Topic, or ConversationPort, read history, or retain data or media.
export class TinodeMutedTopics {
  readonly #scope: TinodeSessionScope;
  readonly #onReady: (topic: string) => void;
  #disposed = false;
  #entries = new Map<string, Entry>();
  #queue: Entry[] = [];
  #pending = new Set<Promise<void>>();
  #running = 0;
  #detachScope: () => void = () => {};
  constructor(scope: TinodeSessionScope, onReady: (topic: string) => void = () => {}) {
    this.#scope = scope;
    this.#onReady = onReady;
    this.#detachScope = scope.onClose(() => this.dispose());
  }
  replace(rows: readonly unknown[], retain: (topic: string) => boolean = () => false): void {
    if (this.#disposed || !this.#scope.active) return;
    const wanted = new Set(rows.filter(isMutedSubscription).map(row => row.topic));
    for (const topic of this.#entries.keys()) if (!wanted.has(topic) && !retain(topic)) this.remove(topic);
    for (const row of rows) {
      if (record(row) && typeof row.topic === 'string' && !retain(row.topic)) this.update(row);
    }
  }
  update(row: unknown): void {
    if (this.#disposed || !this.#scope.active || !record(row) || typeof row.topic !== 'string') return;
    if (!isMutedSubscription(row)) { this.remove(row.topic); return; }
    const previous = this.#entries.get(row.topic);
    if (previous && previous.state !== 'failed') return;
    if (previous) this.remove(row.topic);
    const entry: Entry = { topic: row.topic, interest: this.#scope.topicInterest(row.topic, 'muted'),
      abort: new AbortController(), state: 'queued', stopped: false };
    this.#entries.set(row.topic, entry); this.#queue.push(entry); this.#pump();
  }
  remove(topic: string): void {
    const entry = this.#entries.get(topic);
    if (!entry) return;
    this.#entries.delete(topic); entry.stopped = true; entry.abort.abort();
    this.#queue = this.#queue.filter(queued => queued !== entry);
    if (entry.state === 'queued' || entry.state === 'ready' || entry.state === 'failed') this.#track(this.#release(entry, true));
    // Wait for the in-flight sub to finish. Its task releases the interest in finally.
  }
  has(topic: string): boolean { return this.#entries.has(topic); }
  clear(): void { for (const topic of [...this.#entries.keys()]) this.remove(topic); }
  snapshot(): readonly { readonly topic: string; readonly state: Entry['state']; readonly connected: boolean }[] {
    return Object.freeze([...this.#entries.values()].map(entry => Object.freeze({ topic: entry.topic, state: entry.state,
      connected: entry.interest.connected })));
  }
  async settled(): Promise<void> {
    while (this.#pending.size) await Promise.allSettled([...this.#pending]);
  }
  #track(task: Promise<void>): void {
    this.#pending.add(task);
    void task.then(() => this.#pending.delete(task), () => this.#pending.delete(task));
  }
  #pump(): void {
    if (this.#disposed || !this.#scope.active) return;
    // Allow two initial sub requests at once. This does not cap the number of retained topics.
    // This queue does not use either of the two temporary preview slots.
    while (this.#running < 2 && this.#queue.length) {
      const entry = this.#queue.shift()!;
      if (entry.stopped || this.#entries.get(entry.topic) !== entry) continue;
      entry.state = 'attaching'; this.#running++;
      const task = this.#attach(entry).finally(() => { this.#running--; this.#pump(); });
      this.#track(task);
    }
  }
  async #attach(entry: Entry): Promise<void> {
    let confirmed = false;
    try {
      const physical = await entry.interest.acquire(entry.abort.signal);
      if (entry.stopped || this.#disposed) {
        if (physical) entry.interest.refused();
        confirmed = true; return;
      }
      if (physical) {
        try { await this.#command(entry.topic, 'attach'); entry.interest.attached(); }
        catch (reason: unknown) {
          if (reason instanceof TinodeSessionFailure && reason.code !== undefined && reason.code >= 400 && reason.code < 500 && reason.code !== 408) entry.interest.refused();
          throw reason;
        }
      }
      confirmed = true;
      if (!entry.stopped && !this.#disposed && this.#scope.active) {
        entry.state = 'ready';
        this.#onReady(entry.topic);
      }
    } catch { if (!entry.stopped) entry.state = 'failed'; }
    finally { if (!confirmed || entry.stopped || this.#disposed) await this.#release(entry, confirmed); }
  }
  async #release(entry: Entry, confirmed: boolean): Promise<void> {
    if (entry.stopped) entry.state = 'closing';
    if (!entry.interest.release()) return;
    let detached = false;
    try {
      if (this.#scope.active) { await this.#command(entry.topic, 'leave'); detached = true; }
    } catch { /* The registry isolates an uncertain attachment until a new session starts. */ }
    finally { entry.interest.detached(detached && confirmed); }
  }
  #command(topic: string, kind: 'attach' | 'leave'): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let done = false, localTimeout = false, ambiguous = false, detach: () => void = () => {}, close: () => void = () => {};
      const positiveIds = new Set<string>();
      const finish = (problem?: unknown) => {
        if (done) return;
        done = true; clearTimeout(timer); detach(); close();
        if (problem) reject(problem); else resolve();
      };
      const ack = (value: TinodeSessionObject) => value.topic === topic && typeof value.id === 'string' && value.id !== '' &&
        (value.code === 200 || value.code === 304) && (!record(value.params) || value.params.what === undefined);
      const timer = setTimeout(() => finish(new TinodeSessionFailure('rejected', 504)), 30_000);
      // acquire guarantees a single owner for the actual server attachment.
      // The initial sub has no get. A successful topic ACK does not mark the end of a data stream.
      detach = this.#scope.subscribePackets(packet => {
        if (packet.kind !== 'ctrl' || !ack(packet.payload)) return;
        positiveIds.add(String(packet.payload.id));
        if (positiveIds.size > 1) { ambiguous = true; positiveIds.clear(); }
        if (localTimeout && !ambiguous && positiveIds.size === 1) finish();
      });
      close = this.#scope.onClose(() => finish(new TinodeSessionFailure('closed')));
      if (done) { detach(); close(); return; }
      const request = kind === 'attach' ? this.#scope.subscribe(topic, null) : this.#scope.leave(topic);
      void request.then(response => finish(ack(response) ? undefined : new TinodeSessionFailure('invalidResponse')), (reason: unknown) => {
        // Keep waiting for a late server ACK after the local five-second SDK timeout.
        if (reason instanceof TinodeSessionFailure && reason.code === 504) {
          localTimeout = true;
          if (!ambiguous && positiveIds.size === 1) finish();
        } else finish(reason);
      });
    });
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true; this.clear(); this.#queue.length = 0;
    this.#detachScope(); this.#detachScope = () => {};
  }
}
