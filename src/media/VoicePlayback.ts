import type { ErrorMessageCode } from '../i18n/resources';
import { MediaFailure } from './MediaResources';
import type { MediaLease } from './MediaResources';
import { canPlayVoiceMimeType } from './media-capabilities';

export interface VoicePlaybackSource {
  readonly resourceId: string;
  readonly mime?: string;
  readonly durationMs?: number;
  readonly acquire: (signal: AbortSignal) => Promise<MediaLease>;
}
export interface VoicePlaybackError {
  readonly kind: 'unsupported' | 'unavailable';
  readonly messageCode: ErrorMessageCode;
}
interface Position {
  readonly resourceId: string;
  readonly currentTimeMs: number;
  readonly durationMs?: number;
}
export type PlayerState = Position & (
  | { readonly phase: 'idle' | 'loading' | 'playing' | 'paused' | 'ended' }
  | { readonly phase: 'error'; readonly error: VoicePlaybackError }
);
type FailureStage = 'download' | 'playback';
interface PlayRequest {
  readonly epoch: number;
  readonly abort: AbortController;
  readonly promise: Promise<boolean>;
  readonly resolve: (playing: boolean) => void;
  timer?: ReturnType<typeof setTimeout>;
}
let activePlayer: VoicePlayback | undefined;
const pageHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
function releaseLease(lease?: MediaLease): void {
  try { lease?.release({ discard: true }); } catch { /* Complete cleanup even if a provider fails. */ }
}
const validTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= Number.MAX_SAFE_INTEGER;

// A source owns only an opaque ID and a loader. It never contains a Tinode URL,
// token or Blob. Native audio and MediaLease exist only after an explicit play().
export class VoicePlayback {
  readonly #source: VoicePlaybackSource;
  readonly #signal?: AbortSignal;
  readonly #listeners = new Set<() => void>();
  #snapshot: PlayerState;
  #duration?: number;
  #epoch = 0;
  #pending?: PlayRequest;
  #audio?: HTMLAudioElement;
  #lease?: MediaLease;
  #removeEvents?: () => void;
  #removeLifecycle?: () => void;
  #disposed = false;

  constructor(source: VoicePlaybackSource, options: { readonly signal?: AbortSignal } = {}) {
    this.#source = Object.freeze({ ...source }); this.#signal = options.signal;
    this.#duration = validTime(source.durationMs) ? source.durationMs : undefined;
    this.#snapshot = Object.freeze({ phase: 'idle', resourceId: source.resourceId, currentTimeMs: 0,
      ...(this.#duration === undefined ? {} : { durationMs: this.#duration }) });
  }
  readonly getSnapshot = (): PlayerState => this.#snapshot;
  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.#disposed) return () => {};
    this.#listeners.add(listener); return () => { this.#listeners.delete(listener); };
  };
  // Keep this call in the Play gesture handler. load() primes the native element
  // there, before the asynchronous authorized file acquisition (not before Play).
  readonly play = (): Promise<boolean> => {
    if (this.#disposed || this.#signal?.aborted || typeof document === 'undefined' || pageHidden()) return Promise.resolve(false);
    if (this.#pending) return this.#pending.promise;
    if (this.#snapshot.phase === 'playing') return Promise.resolve(true);
    let resolve!: PlayRequest['resolve'];
    const work: PlayRequest = { epoch: ++this.#epoch, abort: new AbortController(),
      promise: new Promise(done => { resolve = done; }), resolve: value => resolve(value) };
    this.#pending = work;
    const previous = activePlayer; activePlayer = this;
    if (previous && previous !== this) previous.stop();
    if (!this.#current(work)) return work.promise;
    try {
      this.#listen();
      if (this.#signal?.aborted || pageHidden()) { this.stop(); return work.promise; }
      if (!this.#source.resourceId || this.#source.resourceId.length > 8192 ||
        (this.#source.mime !== undefined && !canPlayVoiceMimeType(this.#source.mime))) throw new MediaFailure('unsupported');
      if (!this.#audio) {
        this.#audio = this.#createAudio();
        this.#audio.load();
      }
      this.#watch(work, this.#lease ? 10_000 : 30_000, this.#lease ? 'playback' : 'download');
      this.#publish('loading', this.#position());
      if (this.#current(work)) void this.#start(work);
    } catch (reason) { if (this.#current(work)) this.#error(reason); }
    return work.promise;
  };
  readonly pause = (): void => {
    if (this.#snapshot.phase === 'loading' && !this.#lease) { this.stop(); return; }
    if (!this.#audio || !this.#lease || !['playing', 'loading'].includes(this.#snapshot.phase)) return;
    const audio = this.#audio;
    this.#cancelPending(); const epoch = this.#epoch;
    audio.pause();
    if (this.#audio === audio && activePlayer === this && this.#epoch === epoch) this.#publish('paused', this.#position());
  };
  readonly stop = (): void => {
    this.#release(); this.#publish('idle', 0);
  };
  readonly dispose = (): void => {
    if (this.#disposed) return;
    this.#disposed = true; this.stop(); this.#listeners.clear();
  };
  #current(work: PlayRequest): boolean {
    return !this.#disposed && !work.abort.signal.aborted && this.#pending === work && work.epoch === this.#epoch && activePlayer === this;
  }
  #listen(): void {
    if (this.#removeLifecycle) return;
    const hidden = () => { if (pageHidden()) this.stop(); };
    this.#signal?.addEventListener('abort', this.stop, { once: true });
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', this.stop);
    this.#removeLifecycle = () => {
      this.#signal?.removeEventListener('abort', this.stop);
      document.removeEventListener('visibilitychange', hidden); window.removeEventListener('pagehide', this.stop);
      this.#removeLifecycle = undefined;
    };
  }
  #createAudio(): HTMLAudioElement {
    const audio = document.createElement('audio'); audio.preload = 'none';
    const current = () => this.#audio === audio && !!this.#lease && activePlayer === this && !this.#disposed;
    const update = () => {
      if (!current()) return;
      this.#readDuration(audio);
      const phase = this.#snapshot.phase;
      if (phase === 'playing' || phase === 'paused' || phase === 'loading') this.#publish(phase, this.#position());
    };
    const playing = () => { if (current()) { this.#readDuration(audio); this.#publish('playing', this.#position()); } };
    const paused = () => {
      if (current() && !audio.ended && this.#snapshot.phase === 'playing') {
        this.#cancelPending(); this.#publish('paused', this.#position());
      }
    };
    const ended = () => {
      if (!current()) return;
      this.#readDuration(audio);
      if (!validTime(audio.duration * 1000) && validTime(audio.currentTime * 1000)) this.#duration = audio.currentTime * 1000;
      this.#release(); this.#publish('ended', 0);
    };
    const error = () => { if (current()) this.#error(new MediaFailure(audio.error?.code === 4 ? 'unsupported' : 'unavailable')); };
    const handlers = { timeupdate: update, loadedmetadata: update, durationchange: update, playing, pause: paused, ended, error };
    for (const [name, handler] of Object.entries(handlers)) audio.addEventListener(name, handler);
    this.#removeEvents = () => { for (const [name, handler] of Object.entries(handlers)) audio.removeEventListener(name, handler); };
    return audio;
  }
  async #start(work: PlayRequest): Promise<void> {
    let received: MediaLease | undefined;
    let stage: FailureStage = this.#lease ? 'playback' : 'download';
    const audio = this.#audio!;
    try {
      if (!this.#lease) {
        received = await this.#source.acquire(work.abort.signal);
        if (!this.#current(work)) { releaseLease(received); return; }
        const url = new URL(received.url);
        if (received.resourceId !== this.#source.resourceId || url.protocol !== 'blob:' || url.hash || url.search ||
          (typeof location !== 'undefined' && url.origin !== location.origin) ||
          !Number.isSafeInteger(received.size) || received.size <= 0) throw new MediaFailure('invalidResponse');
        if (!canPlayVoiceMimeType(received.mime)) throw new MediaFailure('unsupported');
        this.#lease = received; received = undefined; stage = 'playback';
        audio.src = this.#lease.url;
        this.#watch(work, 10_000, 'playback');
      }
      if (!this.#current(work)) return;
      await audio.play();
      if (!this.#current(work)) {
        // Never pause a legitimate newer resume of this same element.
        if (this.#audio !== audio || this.#snapshot.phase === 'paused') audio.pause();
        return;
      }
      clearTimeout(work.timer); this.#pending = undefined;
      this.#readDuration(audio); this.#publish('playing', this.#position()); work.resolve(true);
    } catch (reason) {
      releaseLease(received);
      if (this.#current(work)) this.#error(reason, stage);
    }
  }
  #watch(work: PlayRequest, duration: number, stage: FailureStage): void {
    clearTimeout(work.timer);
    work.timer = setTimeout(() => { if (this.#current(work)) this.#error(new MediaFailure('timeout'), stage); }, duration);
  }
  #cancelPending(): void {
    this.#epoch++;
    const work = this.#pending; this.#pending = undefined;
    if (work) { clearTimeout(work.timer); work.abort.abort(); work.resolve(false); }
  }
  #release(): void {
    this.#cancelPending();
    const audio = this.#audio; this.#audio = undefined;
    this.#removeEvents?.(); this.#removeEvents = undefined; this.#removeLifecycle?.();
    if (audio) { try { audio.pause(); audio.removeAttribute('src'); audio.load(); } catch { /* Still release the lease. */ } }
    releaseLease(this.#lease); this.#lease = undefined;
    if (activePlayer === this) activePlayer = undefined;
  }
  #error(reason: unknown, stage: FailureStage = 'playback'): void {
    const unsupported = reason instanceof MediaFailure && reason.reason === 'unsupported';
    const messageCode: ErrorMessageCode = unsupported ? 'conversationPlaybackUnsupported'
      : reason instanceof MediaFailure && reason.reason === 'tooLarge' ? 'conversationMediaTooLarge'
        : stage === 'download' ? 'conversationVoiceLoadFailed' : 'conversationPlaybackUnavailable';
    this.#release();
    this.#snapshot = Object.freeze({ ...this.#base(0), phase: 'error', error: Object.freeze({ kind: unsupported ? 'unsupported' : 'unavailable', messageCode }) });
    this.#notify();
  }
  #position(): number {
    const time = this.#audio?.currentTime;
    return typeof time === 'number' && Number.isFinite(time) && time >= 0 ? Math.round(time * 1000) : this.#snapshot.currentTimeMs;
  }
  #readDuration(audio: HTMLAudioElement): void {
    const duration = audio.duration * 1000;
    if (validTime(duration)) this.#duration = duration;
  }
  #base(currentTimeMs: number): Position {
    return { resourceId: this.#source.resourceId, currentTimeMs,
      ...(this.#duration === undefined ? {} : { durationMs: this.#duration }) };
  }
  #publish(phase: Exclude<PlayerState['phase'], 'error'>, current: number): void {
    this.#snapshot = Object.freeze({ ...this.#base(current), phase }); this.#notify();
  }
  #notify(): void { for (const listener of this.#listeners) { try { listener(); } catch { /* UI cannot retain a media lease. */ } } }
}
