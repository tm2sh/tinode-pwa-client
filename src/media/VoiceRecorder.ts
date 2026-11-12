import type { ErrorMessageCode } from '../i18n/resources';
import type { PreparedMediaInput } from './PreparedMedia';
import type { ServerLimit } from './MediaResources';
import { canPlayVoiceMimeType, getVoiceRecordingCapabilities } from './media-capabilities';
import type { VoiceRecordingFormat, VoiceRecordingUnavailableReason } from './media-capabilities';

const captureBudget = 16 * 1024 * 1024;
const finalizeTimeoutMs = 10_000;
type PreparedVoice = Extract<PreparedMediaInput, { kind: 'voice' }>;
type StopReason = 'manual' | 'sizeLimit' | 'deviceEnded';
type FailureReason = VoiceRecordingUnavailableReason | 'busy' | 'limitsUnavailable' |
  'permissionDenied' | 'deviceMissing' | 'deviceUnavailable' | 'recordingFailed' | 'emptyRecording' | 'tooLarge';

export interface VoiceRecorderError {
  readonly reason: FailureReason;
  readonly messageCode: ErrorMessageCode;
}
interface Progress {
  readonly durationMs: number;
  readonly bytes: number;
  readonly maxBytes: number;
  readonly mime: string;
}
export type RecorderState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'requesting'; readonly maxBytes: number }
  | ({ readonly phase: 'recording' } & Progress)
  | ({ readonly phase: 'finalizing'; readonly stoppedBy: StopReason } & Progress)
  | ({ readonly phase: 'ready'; readonly stoppedBy: StopReason; readonly filename: string } & Progress)
  | { readonly phase: 'error'; readonly error: VoiceRecorderError };

export interface VoiceRecorderOptions {
  readonly maxFileUploadSize: ServerLimit;
  // The conversation owner aborts this signal on logout, access loss or navigation.
  readonly signal?: AbortSignal;
}
interface Capture {
  readonly maxBytes: number;
  readonly reserve: number;
  readonly abort: AbortController;
  readonly started: Promise<boolean>;
  readonly resolveStarted: (started: boolean) => void;
  readonly finished: Promise<void>;
  readonly resolveFinished: () => void;
  pendingPermission: boolean;
  cancelled: boolean;
  finalizationStarted: boolean;
  chunks: Blob[];
  bytes: number;
  startedAt: number;
  stoppedAt?: number;
  stoppedBy: StopReason;
  format?: VoiceRecordingFormat;
  recorder?: MediaRecorder;
  stream?: MediaStream;
  tick?: ReturnType<typeof setInterval>;
  watchdog?: ReturnType<typeof setTimeout>;
  removeTracks?: () => void;
}
// One capture/reservation, including an unresolved permission prompt and a ready
// recording awaiting send/cancel. No second stream can race a cancelled prompt.
let activeCapture: Capture | undefined;

function failure(reason: FailureReason): VoiceRecorderError {
  const messageCode: ErrorMessageCode = reason === 'permissionDenied' ? 'conversationCapturePermission'
    : reason === 'deviceMissing' ? 'conversationCaptureDeviceMissing'
    : reason === 'busy' ? 'conversationCaptureBusy'
    : reason === 'limitsUnavailable' ? 'conversationLimitsUnavailable'
      : ['insecureContext', 'microphoneUnavailable', 'recorderUnavailable', 'formatUnavailable'].includes(reason)
        ? 'conversationCaptureUnsupported' : 'conversationCaptureFailed';
  return Object.freeze({ reason, messageCode });
}
function permissionFailure(reason: unknown): FailureReason {
  const name = reason instanceof DOMException ? reason.name : '';
  return name === 'NotAllowedError' || name === 'SecurityError' ? 'permissionDenied'
    : name === 'NotFoundError' ? 'deviceMissing'
    : ['NotReadableError', 'OverconstrainedError', 'AbortError'].includes(name) ? 'deviceUnavailable' : 'recordingFailed';
}
function stopTracks(stream?: MediaStream): void {
  for (const track of stream?.getTracks() ?? []) {
    try { track.stop(); } catch { /* Continue releasing the other tracks. */ }
  }
}
function canonicalMime(value: string): string {
  return value.trim().toLowerCase().replace(/\s|"/g, '');
}
function recordedMime(run: Capture): string | undefined {
  const expected = run.format!.mimeType;
  const reported = [run.recorder?.mimeType ?? '', ...run.chunks.map(chunk => chunk.type)]
    .filter(Boolean).map(canonicalMime);
  // A container-only label is accepted only with another explicit native label.
  // In particular, MP4 by itself does not prove AAC.
  if (!reported.includes(expected) || reported.some(mime => mime !== expected && mime !== 'audio/' + run.format!.container)) return;
  return expected;
}
async function validateRecording(blob: Blob, mime: string, signal: AbortSignal): Promise<void> {
  const bytes = new Uint8Array(await blob.slice(0, 32).arrayBuffer());
  if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
  const header = mime.startsWith('audio/webm')
    ? [0x1a, 0x45, 0xdf, 0xa3].every((value, index) => bytes[index] === value)
    : bytes.length >= 12 && String.fromCharCode(...bytes.slice(4, 8)) === 'ftyp';
  if (!header || !canPlayVoiceMimeType(mime)) throw new Error('Invalid recording');
  const audio = document.createElement('audio');
  const url = URL.createObjectURL(blob);
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer); signal.removeEventListener('abort', abort);
        audio.removeEventListener('loadeddata', loaded); audio.removeEventListener('canplay', loaded);
        audio.removeEventListener('error', failed);
      };
      const abort = () => { cleanup(); reject(new DOMException('Cancelled', 'AbortError')); };
      const loaded = () => { if (audio.readyState >= 2) { cleanup(); resolve(); } };
      const failed = () => { cleanup(); reject(new Error('Recording decode failed')); };
      const timer = setTimeout(failed, finalizeTimeoutMs);
      audio.addEventListener('loadeddata', loaded); audio.addEventListener('canplay', loaded);
      audio.addEventListener('error', failed); signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      audio.preload = 'auto'; audio.src = url;
      try { audio.load(); } catch { failed(); }
    });
  } finally {
    try { audio.pause(); audio.removeAttribute('src'); audio.load(); }
    finally { URL.revokeObjectURL(url); }
  }
}

export class VoiceRecorder {
  readonly #limit: ServerLimit;
  readonly #signal?: AbortSignal;
  readonly #page: Document | undefined;
  readonly #window: Window | undefined;
  readonly #listeners = new Set<() => void>();
  #snapshot: RecorderState = Object.freeze({ phase: 'idle' });
  #capture?: Capture;
  #file?: PreparedVoice;
  #disposed = false;
  #listening = false;

  constructor(options: VoiceRecorderOptions) {
    this.#limit = Object.freeze({ ...options.maxFileUploadSize });
    this.#signal = options.signal;
    this.#page = typeof document === 'undefined' ? undefined : document;
    this.#window = typeof window === 'undefined' ? undefined : window;
    if (options.signal?.aborted) { this.#disposed = true; return; }

  }
  readonly getSnapshot = (): RecorderState => this.#snapshot;
  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.#disposed) return () => {};
    this.#listeners.add(listener); return () => { this.#listeners.delete(listener); };
  };
  // Call only from an explicit record action. Construction/detection never captures.
  readonly start = (): Promise<boolean> => {
    if (this.#disposed || this.#signal?.aborted || this.#page?.visibilityState === 'hidden') return Promise.resolve(false);
    if (this.#capture) return this.#capture.started;
    if (activeCapture) { this.#publish({ phase: 'error', error: failure('busy') }); return Promise.resolve(false); }
    if (this.#limit.state !== 'known' || !Number.isSafeInteger(this.#limit.value) || this.#limit.value <= 0) {
      this.#publish({ phase: 'error', error: failure('limitsUnavailable') }); return Promise.resolve(false);
    }
    const support = getVoiceRecordingCapabilities();
    if (support.state !== 'available') {
      this.#publish({ phase: 'error', error: failure(support.reason) }); return Promise.resolve(false);
    }
    const maxBytes = Math.min(this.#limit.value, captureBudget);
    let resolveStarted!: Capture['resolveStarted'], resolveFinished!: Capture['resolveFinished'];
    const run: Capture = { maxBytes, reserve: Math.min(Math.floor(maxBytes / 2), Math.max(64 * 1024, Math.floor(maxBytes / 8))),
      abort: new AbortController(), started: new Promise(resolve => { resolveStarted = resolve; }), resolveStarted: value => resolveStarted(value),
      finished: new Promise(resolve => { resolveFinished = resolve; }), resolveFinished: () => resolveFinished(),
      pendingPermission: true, cancelled: false, finalizationStarted: false, chunks: [], bytes: 0, startedAt: 0, stoppedBy: 'manual' };
    this.#capture = run; activeCapture = run;
    this.#listen();
    this.#publish({ phase: 'requesting', maxBytes });
    void this.#open(run, support.formats);
    return run.started;
  };
  readonly stop = (): Promise<void> => {
    const run = this.#capture;
    if (!run) return Promise.resolve();
    if (this.#snapshot.phase === 'requesting') { this.cancel(); return run.finished; }
    if (this.#snapshot.phase === 'recording') this.#finish(run, 'manual');
    return run.finished;
  };
  readonly cancel = (): void => {
    this.#file = undefined;
    const run = this.#capture; this.#capture = undefined;
    if (run) this.#release(run);
    this.#unlisten();
    this.#publish({ phase: 'idle' });
  };
  readonly takeRecording = (): PreparedVoice | undefined => {
    if (this.#snapshot.phase !== 'ready' || !this.#file) return;
    const file = this.#file; this.cancel(); return file;
  };
  readonly dispose = (): void => {
    if (this.#disposed) return;
    this.#disposed = true; this.cancel();
    this.#unlisten();
    this.#listeners.clear();
  };
  #listen(): void {
    if (this.#listening) return;
    this.#listening = true;
    this.#signal?.addEventListener('abort', this.dispose, { once: true });
    this.#page?.addEventListener('visibilitychange', this.#visibilityChanged);
    this.#window?.addEventListener('pagehide', this.cancel);
  }
  #unlisten(): void {
    if (!this.#listening) return;
    this.#listening = false;
    this.#signal?.removeEventListener('abort', this.dispose);
    this.#page?.removeEventListener('visibilitychange', this.#visibilityChanged);
    this.#window?.removeEventListener('pagehide', this.cancel);
  }
  readonly #visibilityChanged = (): void => { if (this.#page?.visibilityState === 'hidden') this.cancel(); };
  #current(run: Capture): boolean { return this.#capture === run && !run.cancelled && !this.#disposed; }
  #publish(snapshot: RecorderState): void {
    this.#snapshot = Object.freeze(snapshot);
    for (const listener of this.#listeners) { try { listener(); } catch { /* A UI listener cannot retain capture. */ } }
  }
  #progress(run: Capture): Progress {
    return { durationMs: Math.max(0, Math.round((run.stoppedAt ?? performance.now()) - run.startedAt)),
      bytes: run.bytes, maxBytes: run.maxBytes, mime: run.format!.mimeType };
  }
  async #open(run: Capture, formats: readonly VoiceRecordingFormat[]): Promise<void> {
    try {
      if (!this.#current(run)) { run.pendingPermission = false; return; }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      run.pendingPermission = false;
      if (!this.#current(run)) { stopTracks(stream); return; }
      run.stream = stream;
      const tracks = stream.getAudioTracks();
      if (tracks.length === 0) { this.#fail(run, 'deviceMissing'); return; }
      if (tracks.some(track => track.readyState !== 'live')) { this.cancel(); return; }
      const ended = () => { if (this.#current(run) && this.#snapshot.phase === 'recording') this.#finish(run, 'deviceEnded'); };
      for (const track of tracks) track.addEventListener('ended', ended);
      run.removeTracks = () => { for (const track of tracks) track.removeEventListener('ended', ended); };
      let started = false;
      for (const format of formats) {
        try {
          run.format = format;
          const recorder = new MediaRecorder(stream, { mimeType: format.mimeType, audioBitsPerSecond: 32_000 });
          run.recorder = recorder;
          recorder.ondataavailable = event => this.#chunk(run, event.data);
          recorder.onstop = () => { void this.#finalize(run); };
          recorder.onerror = () => this.#fail(run, 'recordingFailed');
          run.startedAt = performance.now(); recorder.start(1000);
          if (!this.#current(run)) return;
          started = true; break;
        } catch (reason) {
          if (run.recorder?.state !== undefined && run.recorder.state !== 'inactive') throw reason;
          this.#detachRecorder(run);
          if (!(reason instanceof DOMException) || reason.name !== 'NotSupportedError') throw reason;
        }
      }
      if (!started) { this.#fail(run, 'formatUnavailable'); return; }
      run.tick = setInterval(() => {
        if (!this.#current(run) || this.#snapshot.phase !== 'recording') return;
        const rate = run.recorder?.audioBitsPerSecond;
        const estimated = typeof rate === 'number' && Number.isFinite(rate) && rate > 0
          ? (performance.now() - run.startedAt) * rate / 8000 * 1.15 : 0;
        if (Math.max(run.bytes, estimated) + run.reserve >= run.maxBytes) this.#finish(run, 'sizeLimit');
        else this.#publish({ phase: 'recording', ...this.#progress(run) });
      }, 250);
      this.#publish({ phase: 'recording', ...this.#progress(run) });
      run.resolveStarted(this.#current(run));
    } catch (reason) {
      run.pendingPermission = false;
      if (this.#current(run)) {
        const failure = permissionFailure(reason);
        if (failure === 'deviceUnavailable') this.cancel();
        else this.#fail(run, failure);
      }
    } finally {
      if (!this.#current(run) && activeCapture === run) activeCapture = undefined;
    }
  }
  #chunk(run: Capture, chunk: Blob): void {
    if (!this.#current(run) || run.finalizationStarted || !chunk.size ||
      (this.#snapshot.phase !== 'recording' && this.#snapshot.phase !== 'finalizing')) return;
    if (chunk.size > run.maxBytes - run.bytes) { this.#fail(run, 'tooLarge'); return; }
    run.chunks.push(chunk); run.bytes += chunk.size;
    if (this.#snapshot.phase === 'recording') {
      if (run.bytes + Math.max(run.reserve, chunk.size * 2) >= run.maxBytes) this.#finish(run, 'sizeLimit');
      else this.#publish({ phase: 'recording', ...this.#progress(run) });
    } else if (this.#snapshot.phase === 'finalizing') this.#publish({ phase: 'finalizing', ...this.#progress(run), stoppedBy: run.stoppedBy });
  }
  #finish(run: Capture, stoppedBy: StopReason): void {
    if (!this.#current(run) || this.#snapshot.phase === 'finalizing') return;
    run.stoppedAt = performance.now(); run.stoppedBy = stoppedBy;
    clearInterval(run.tick);
    run.watchdog = setTimeout(() => this.#fail(run, 'recordingFailed'), finalizeTimeoutMs);
    this.#publish({ phase: 'finalizing', ...this.#progress(run), stoppedBy });
    if (!this.#current(run)) return;
    try { if (run.recorder?.state !== 'inactive') run.recorder?.stop(); }
    catch { this.#fail(run, 'recordingFailed'); }
    finally { run.removeTracks?.(); run.removeTracks = undefined; stopTracks(run.stream); run.stream = undefined; }
  }
  async #finalize(run: Capture): Promise<void> {
    if (!this.#current(run) || run.finalizationStarted) return;
    run.finalizationStarted = true;
    if (this.#snapshot.phase === 'recording') {
      // A native/device stop may arrive without our stop() call.
      run.stoppedAt = performance.now(); run.stoppedBy = 'deviceEnded'; clearInterval(run.tick);
      this.#publish({ phase: 'finalizing', ...this.#progress(run), stoppedBy: run.stoppedBy });
      if (!this.#current(run)) return;
      run.removeTracks?.(); run.removeTracks = undefined; stopTracks(run.stream); run.stream = undefined;
    }
    clearTimeout(run.watchdog);
    try {
      if (!run.bytes || !this.#progress(run).durationMs) { this.#fail(run, 'emptyRecording'); return; }
      if (run.bytes > run.maxBytes) { this.#fail(run, 'tooLarge'); return; }
      const mime = recordedMime(run);
      if (!mime) { this.#fail(run, 'formatUnavailable'); return; }
      const blob = new Blob(run.chunks, { type: mime }); run.chunks = [];
      await validateRecording(blob, mime, run.abort.signal);
      if (!this.#current(run)) return;
      const durationMs = this.#progress(run).durationMs;
      const filename = 'voice-' + crypto.randomUUID() + '.' + run.format!.extension;
      this.#file = Object.freeze({ kind: 'voice', blob, filename, durationMs });
      this.#detachRecorder(run);
      this.#publish({ phase: 'ready', ...this.#progress(run), mime, filename, stoppedBy: run.stoppedBy });
      run.resolveFinished();
    } catch { if (this.#current(run)) this.#fail(run, 'recordingFailed'); }
  }
  #detachRecorder(run: Capture): void {
    if (run.recorder) { run.recorder.ondataavailable = null; run.recorder.onstop = null; run.recorder.onerror = null; run.recorder = undefined; }
  }
  #release(run: Capture): void {
    run.cancelled = true; run.abort.abort(); clearInterval(run.tick); clearTimeout(run.watchdog);
    run.removeTracks?.(); run.removeTracks = undefined;
    const recorder = run.recorder; this.#detachRecorder(run);
    try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch { /* Tracks must still be stopped. */ }
    stopTracks(run.stream); run.stream = undefined; run.chunks = [];
    run.resolveStarted(false); run.resolveFinished();
    if (!run.pendingPermission && activeCapture === run) activeCapture = undefined;
  }
  #fail(run: Capture, reason: FailureReason): void {
    if (!this.#current(run)) return;
    this.#capture = undefined; this.#file = undefined; this.#release(run); this.#unlisten();
    this.#publish({ phase: 'error', error: failure(reason) });
  }
}
