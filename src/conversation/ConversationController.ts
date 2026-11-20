import type { ChatInfoNavigation } from '../chat-info/chat-info-types';
import { MediaFailure, MediaResources } from '../media/MediaResources';
import type { MediaLease, ServerLimit } from '../media/MediaResources';
import type { PreparedMediaInput } from '../media/PreparedMedia';
import { createPreparedMedia } from '../media/PreparedMedia';
import type { AvatarImageSource, AvatarResource, ChatSequence, ChatTitle } from '../chats/chat-list-types';
import type {
  ConversationAttachment, ConversationCloseResult, ConversationError, ConversationHeader,
  ConversationDeletionState, ConversationDeleteScope, ConversationDeleteResult, ConversationOpeningTarget, ConversationHistoryGap,
  ConversationHistoryRange, ConversationIdentity, ConversationMessage, ConversationOpenResult,
  ConversationPageCursor, ConversationPageQuery, ConversationPageResult,
  ConversationPermissions, ConversationPort, ConversationReadEvent, ConversationReadingPosition, ConversationReceipt,
  ConversationReadySnapshot, ConversationSnapshot, ConversationOutgoingOperation, ConversationOutgoing, ConversationEditDraft,
  PhotoAttachment, VoiceAttachment, ConversationMediaReference, ConversationCheckpoint, ConversationScrollAnchor, ConversationReconcileCursor, ConversationVerification, ConversationSearchState,
} from './conversation-types';
import { normalizeServerTimestamp } from '../chats/chat-list-normalize';
import { createConversationSearchIndex } from './conversation-search';
import { normalizeConversationDraft } from './ConversationDraft';
import { canEditConversationMessage } from './conversation-edit';
import type { ConversationDraftPort } from './ConversationDraft';
import { ConversationFailure, normalizeConversationIdentity, sortConversationMessages,
  mergeConversationDeletionRanges, conversationSeqDeleted, materializeConversationMessages } from './conversation-normalize';

type Listener = () => void;
type PreparedVoice = Extract<PreparedMediaInput, { kind: 'voice' }>;
type VoiceMedia = Extract<ConversationMediaReference, { state: 'available' }>;
type PortFactory = () => Promise<ConversationPort>;
interface Operation {
  readonly kind: 'initial' | 'older' | 'latest' | 'read' | 'gap';
  readonly scrollRevision: number;
  readonly query?: ConversationPageQuery;
  readonly abort: AbortController;
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly messages: Map<number, Extract<ConversationReadEvent, { kind: 'messageUpsert' }>>;
  permissions?: Extract<ConversationReadEvent, { kind: 'permissionsChanged' }>;
  header?: Extract<ConversationReadEvent, { kind: 'metadataUpdated' }>;
}
interface Submission {
  readonly operationId: string;
  text?: string;
  submittedDraftIds?: readonly string[];
  photo?: ConversationOutgoing['photo'];
  voice?: ConversationOutgoing['voice'];
  operation: ConversationOutgoingOperation;
  cursor?: ConversationReconcileCursor;
}
interface ReconcileWork { readonly operationId: string; readonly port: ConversationPort; readonly abort: AbortController; readonly promise: Promise<void>; readonly resolve: () => void }
interface SubmissionWork {
  readonly operationId: string;
  readonly port: ConversationPort;
  readonly abort: AbortController;
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}
const idle = Object.freeze({ state: 'idle' } as const);
const closedSearch = Object.freeze({ state: 'closed' } as const);
const activeControllers = new Set<ConversationController>();
function integer(value: number, minimum = 0): boolean { return Number.isSafeInteger(value) && value >= minimum; }
function sameIdentity(a: ConversationIdentity, b: ConversationIdentity): boolean {
  return a.topicKey === b.topicKey && a.kind === b.kind && a.account.serverId === b.account.serverId &&
    a.account.uid === b.account.uid && a.account.generation === b.account.generation;
}
function invalid(): ConversationFailure {
  return new ConversationFailure({ area: 'history', kind: 'invalidResponse', messageCode: 'conversationInvalidResponse', retryable: true });
}
function sessionError(): ConversationError {
  return Object.freeze({ area: 'history', kind: 'sessionClosed', messageCode: 'conversationSessionClosed', retryable: false });
}
function copyError(value: ConversationError): ConversationError {
  return Object.freeze({ area: value.area, kind: value.kind, messageCode: value.messageCode, retryable: value.retryable,
    ...(value.serverCode !== undefined && integer(value.serverCode) ? { serverCode: value.serverCode } : {}),
    ...(value.messageParams === undefined ? {} : { messageParams: Object.freeze({
      ...(value.messageParams.seconds !== undefined && Number.isFinite(value.messageParams.seconds) && value.messageParams.seconds >= 0 ? { seconds: value.messageParams.seconds } : {}),
      ...(value.messageParams.maxBytes !== undefined && integer(value.messageParams.maxBytes) ? { maxBytes: value.messageParams.maxBytes } : {}),
    }) }) });
}
function requestError(reason: unknown): ConversationError {
  return reason instanceof ConversationFailure ? copyError(reason.conversationError)
    : reason instanceof DOMException && reason.name === 'AbortError' ? sessionError()
      : Object.freeze({ area: 'history', kind: 'network', messageCode: 'conversationHistoryUnavailable', retryable: true });
}
function copyTitle(value: ChatTitle): ChatTitle {
  return Object.freeze(value.state === 'known' ? { state: 'known', text: value.text } : { state: 'unknown' });
}
function copyAvatar(value: AvatarResource): AvatarResource {
  return Object.freeze(value.state === 'ready' ? { state: 'ready', imageSource: value.imageSource } : { state: value.state });
}
function copySeq(value: ChatSequence): ChatSequence {
  return Object.freeze(value.state === 'known' ? { state: 'known', value: value.value } : { state: 'unknown' });
}
function copyHeader(value: ConversationHeader): ConversationHeader {
  const base = { title: copyTitle(value.title), avatar: copyAvatar(value.avatar) };
  return Object.freeze(value.kind === 'personal' ? { ...base, kind: 'personal', peerUid: value.peerUid,
    presence: Object.freeze(value.presence.state === 'offline' ? { state: 'offline',
      ...(value.presence.lastSeenAt === undefined ? {} : { lastSeenAt: value.presence.lastSeenAt }) } : { state: value.presence.state }) }
    : { ...base, kind: 'group', ...(value.isChannel ? { isChannel: true as const } : {}), participantCount: copySeq(value.participantCount), onlineCount: copySeq(value.onlineCount) });
}
function copyPermissions(value: ConversationPermissions): ConversationPermissions {
  const access = (v: ConversationPermissions['canRead']) => Object.freeze(v.state === 'denied'
    ? { state: v.state, reason: v.reason } : { state: v.state });
  return Object.freeze({ canRead: access(value.canRead), canWrite: access(value.canWrite), canDelete: access(value.canDelete) });
}
function copyAttachment(value: ConversationAttachment): ConversationAttachment {
  if (value.kind === 'unsupported') return Object.freeze({ kind: value.kind, contentType: value.contentType,
    ...(value.filename === undefined ? {} : { filename: value.filename }) });
  const base = { media: Object.freeze(value.media.state === 'available'
    ? { state: 'available' as const, resourceId: value.media.resourceId } : { state: 'missing' as const }),
    size: copySeq(value.size), ...(value.mime === undefined ? {} : { mime: value.mime }),
    ...(value.filename === undefined ? {} : { filename: value.filename }) };
  return value.kind === 'photo' ? Object.freeze({ ...base, kind: 'photo',
    dimensions: Object.freeze(value.dimensions.state === 'known'
      ? { state: 'known', width: value.dimensions.width, height: value.dimensions.height } : { state: 'unknown' }),
    media: value.media,
    ...(value.preview === undefined ? {} : { preview: value.preview }) })
    : Object.freeze({ ...base, kind: 'voice', media: value.media, durationMs: copySeq(value.durationMs),
      ...(value.waveform === undefined ? {} : { waveform: Object.freeze([...value.waveform]) }) });
}
function copyMessage(value: ConversationMessage): ConversationMessage {
  if (!integer(value.serverSeq, 1)) throw invalid();
  const sender = value.sender;
  return Object.freeze({ serverSeq: value.serverSeq, delivery: 'serverConfirmed',
    timestamp: Object.freeze(value.timestamp.state === 'known' ? { state: 'known', at: value.timestamp.at } : { state: 'unknown' }),
    sender: Object.freeze(sender.state === 'self' ? { state: sender.state, uid: sender.uid }
      : sender.state === 'other' ? { state: sender.state, uid: sender.uid, displayName: copyTitle(sender.displayName), avatar: copyAvatar(sender.avatar) }
        : { state: sender.state, ...(sender.uid === undefined ? {} : { uid: sender.uid }) }),
    content: Object.freeze({ text: Object.freeze({ text: value.content.text.text,
      spans: Object.freeze(value.content.text.spans.map(span => Object.freeze(span.kind === 'link'
        ? { kind: 'link' as const, start: span.start, length: span.length, url: span.url }
        : { kind: span.kind, start: span.start, length: span.length }))) }), attachments: Object.freeze(value.content.attachments.map(copyAttachment)) }),
    ...(value.originalSeq === undefined ? {} : { originalSeq: value.originalSeq }),
    ...(value.versionSeq === undefined ? {} : { versionSeq: value.versionSeq }),
    ...(value.editedAt === undefined ? {} : { editedAt: value.editedAt }),
    ...(value.operationId === undefined ? {} : { operationId: value.operationId }) });
}
function copyQuery(query: ConversationPageQuery): ConversationPageQuery {
  if (!integer(query.limit, 1) || (query.since !== undefined && !integer(query.since, 1)) ||
    (query.before !== undefined && !integer(query.before, 1)) ||
    (query.since !== undefined && query.before !== undefined && query.since >= query.before)) throw invalid();
  return Object.freeze({ limit: query.limit, ...(query.since === undefined ? {} : { since: query.since }),
    ...(query.before === undefined ? {} : { before: query.before }) });
}
function copyCursor(value: ConversationPageCursor): ConversationPageCursor {
  return Object.freeze(value.state === 'more' ? { state: 'more', query: copyQuery(value.query) } : { state: value.state });
}
function copyRange(value: ConversationHistoryRange): ConversationHistoryRange {
  return Object.freeze({ query: copyQuery(value.query), snapshotUpperSeq: copySeq(value.snapshotUpperSeq),
    receivedSeq: Object.freeze([...value.receivedSeq]), coverage: value.coverage,
    older: copyCursor(value.older), newer: copyCursor(value.newer) });
}
function copyReading(value: ConversationReadingPosition): ConversationReadingPosition {
  return Object.freeze({ confirmedReadSeq: copySeq(value.confirmedReadSeq), highestReceivedSeq: copySeq(value.highestReceivedSeq),
    ...(value.pendingReadSeq === undefined ? {} : { pendingReadSeq: value.pendingReadSeq }),
    ...(value.firstUnreadTarget === undefined ? {} : { firstUnreadTarget: value.firstUnreadTarget }) });
}
function sameQuery(a: ConversationPageQuery, b: ConversationPageQuery): boolean {
  return a.limit === b.limit && a.since === b.since && a.before === b.before;
}

// Owns one topic and generation. Authentication and session recovery belong to the parent.
export class ConversationController {
  readonly identity: ConversationIdentity;
  readonly #openPort: PortFactory;
  #snapshot: ConversationSnapshot;
  #port: ConversationPort | undefined;
  #detachPort: () => void = () => {};
  #operation: Operation | undefined;
  #works = new Set<Promise<void>>();
  #cleanup: Promise<void> = Promise.resolve();
  #retired = new WeakSet<ConversationPort>();
  #closeResult: ConversationCloseResult | undefined;
  #closePromise: Promise<ConversationCloseResult | undefined> | undefined;
  #suspendPromise: Promise<void> | undefined;
  #blockedError: ConversationError | undefined;
  #messages = new Map<number, ConversationMessage>();
  #rawMessages = new Map<number, ConversationMessage>();
  #deletion: ConversationDeletionState = { transactionId: 0, ranges: [] };
  #permissionsRevision = -1;
  #highestReceived = 0;
  #snapshotUpper: number | undefined;
  #openingUpper = 0;
  #latestKnown = 0;
  #coverage: { low: number; high: number }[] = [];
  #atLatest = false;
  #atEnd = false;
  #scrollRevision = 0;
  #scrollTarget: 'latest' | number = 'latest';
  #confirmedRead: ChatSequence = { state: 'unknown' };
  #pendingRead = 0;
  #viewportActive = false;
  #infoGeneration = 0;
  #receipts = new Map<string, ConversationReceipt>();
  #messageRevisions = new Map<number, number>();
  #headerRevision = -1;
  #ready: ConversationReadySnapshot | undefined;
  #managed = false;
  #owners = 0;
  #ownershipVersion = 0;
  #listeners = new Set<Listener>();
  #continuationListeners = new Set<Listener>();
  #resume: ConversationCheckpoint | undefined;
  #scrollAnchor: ConversationScrollAnchor | undefined;
  #draft = '';
  #edit: ConversationEditDraft | undefined;
  #editOperationId: string | undefined;
  #draftRevision = 0;
  readonly #draftPort?: ConversationDraftPort;
  #storedDraftId?: string;
  #draftDirty = false;
  #draftReadStarted = false;
  #draftSave?: { readonly id?: string; readonly revision: number; readonly promise: Promise<void> };
  #searchIndex: ReturnType<typeof createConversationSearchIndex> | undefined;
  #composerError: ConversationError | undefined;
  #submissions = new Map<string, Submission>();
  #outgoing: readonly ConversationOutgoing[] = Object.freeze([]);
  #submission: SubmissionWork | undefined;
  #deleting: AbortController | undefined;
  #photoBatch: AbortController | undefined;
  #voiceLifetime = new AbortController();
  #localVoiceResources = new MediaResources();
  readonly #voiceFiles = new Map<string, PreparedVoice>();
  readonly #localVoiceSources = new WeakMap<VoiceMedia, PreparedVoice>();
  readonly #localPhotoPreviews = new Map<string, Set<AvatarImageSource>>();
  readonly #photoReads = new Set<AbortController>();
  #previewQueue: Promise<unknown> = Promise.resolve();
  #reconcile: ReconcileWork | undefined;
  #verification: ConversationVerification | undefined;

  constructor(identity: ConversationIdentity, openPort: PortFactory, resume?: ConversationCheckpoint,
    draftPort?: ConversationDraftPort) {
    this.identity = normalizeConversationIdentity(identity.account, identity.topicKey);
    if (!sameIdentity(identity, this.identity)) throw invalid();
    if (resume && (resume.identity.account.serverId !== identity.account.serverId || resume.identity.account.uid !== identity.account.uid ||
      resume.identity.topicKey !== identity.topicKey || resume.identity.kind !== identity.kind)) throw invalid();
    this.#resume = resume;
    this.#draftPort = draftPort;
    this.#storedDraftId = draftPort?.initial?.id;
    if (!resume) this.#draft = draftPort?.initial?.text ?? '';
    this.#openPort = openPort;
    this.#snapshot = Object.freeze({ phase: 'idle', identity: this.identity });
  }
  readonly getSnapshot = (): ConversationSnapshot => this.#snapshot;
  readonly verifyDeleteForAll = async (serverSeq: number, signal: AbortSignal): Promise<boolean> => {
    const port = this.#port;
    if (!port || this.#snapshot.phase !== 'ready' || !this.#canRun() || signal.aborted) return false;
    const allowed = await port.verifyDeleteForAll(serverSeq, signal);
    return allowed && !signal.aborted && this.#canRun() && this.#port === port && this.#snapshot.phase === 'ready';
  };
  readonly deleteMessage = (serverSeq: number, scope: ConversationDeleteScope): Promise<ConversationDeleteResult | undefined> =>
    this.#runDelete(serverSeq, scope);

  readonly checkMessageDeletion = (serverSeq: number): Promise<ConversationDeleteResult | undefined> =>
    this.#runDelete(serverSeq);

  async #runDelete(serverSeq: number, scope?: ConversationDeleteScope): Promise<ConversationDeleteResult | undefined> {
    const port = this.#port;
    if (!port || this.#deleting || this.#snapshot.phase !== 'ready' || !this.#canRun()) return undefined;
    const abort = new AbortController();
    this.#deleting = abort;
    const current = () => !abort.signal.aborted && this.#canRun() && this.#port === port && this.#snapshot.phase === 'ready';
    try {
      const result = await (scope === undefined ? port.checkMessageDeletion(serverSeq, abort.signal)
        : port.deleteMessage(serverSeq, scope, abort.signal));
      return current() ? result : undefined;
    } catch {
      return current() ? 'unknown' : undefined;
    } finally {
      if (this.#deleting === abort) this.#deleting = undefined;
    }
  }
  readonly subscribe = (listener: Listener): (() => void) => {
    if (this.#snapshot.phase === 'closed') return () => {};
    const wrapped = () => listener(); this.#listeners.add(wrapped);
    return () => { this.#listeners.delete(wrapped); };
  };
  readonly getContinuationState = (): ConversationCheckpoint | undefined => this.#ready ? Object.freeze({
    identity: this.identity, draft: this.#draft, draftDirty: this.#draftDirty, atEnd: this.#atEnd,
    ...(this.#edit ? { edit: this.#edit } : {}),
    ...(this.#scrollAnchor ? { anchor: this.#scrollAnchor } : {}),
    outgoing: Object.freeze(this.#outgoing.filter(row => row.operation.phase !== 'confirmed' && row.operation.phase !== 'cancelled' &&
      (row.operation.kind === 'text' || row.operation.operationId === this.#editOperationId ||
        row.operation.phase === 'unknown' || row.operation.phase === 'publishing')).map(row =>
        row.photo ? Object.freeze({ ...row, photo: Object.freeze({ filename: row.photo.filename }) })
          : row.voice ? Object.freeze({ ...row, voice: Object.freeze({ ...row.voice, canRetry: false, attachment: Object.freeze({ ...row.voice.attachment, media: Object.freeze({ state: 'missing' as const }) }) }) }) : row)),
  }) : undefined;
  readonly subscribeContinuation = (listener: Listener): (() => void) => {
    this.#continuationListeners.add(listener);
    return () => { this.#continuationListeners.delete(listener); };
  };
  readonly reportScrollAnchor = (anchor: ConversationScrollAnchor): void => {
    if (this.#snapshot.phase !== 'ready' || !integer(anchor.serverSeq, 1) || !Number.isFinite(anchor.offsetPx)) return;
    this.#scrollAnchor = Object.freeze({ serverSeq: anchor.serverSeq, offsetPx: anchor.offsetPx });
    this.#notifyContinuation();
  };
  #notifyContinuation(): void {
    for (const listener of [...this.#continuationListeners]) {
      try { listener(); } catch { console.error('Conversation continuation notification failed.'); }
    }
  }
  get busy(): boolean { return this.#operation !== undefined || this.#reconcile !== undefined; }
  attach(): () => void {
    if (this.#snapshot.phase === 'closed') return () => {};
    activeControllers.add(this); this.#managed = true; this.#owners++; this.#ownershipVersion++;
    let attached = true;
    return () => {
      if (!attached) return;
      attached = false; this.#owners--; if (this.#owners === 0) this.#viewportActive = false;
      const version = ++this.#ownershipVersion;
      queueMicrotask(() => { if (this.#owners === 0 && this.#ownershipVersion === version) this.dispose(); });
    };
  }
  readonly openSearch = (): void => {
    if (!this.#canRun() || this.#ready?.search.state !== 'closed') return;
    this.#publishReady({ search: Object.freeze({ state: 'no-query', query: '' }) });
  };
  readonly setSearchQuery = (query: string): void => {
    const ready = this.#ready;
    if (!this.#canRun() || !ready || ready.search.state === 'closed' || query === ready.search.query) return;
    const term = query.trim();
    const sameTerm = term === ready.search.query.trim();
    if (!sameTerm) this.#searchIndex = term ? createConversationSearchIndex(term) : undefined;
    this.#publishReady({ search: this.#searchFor(query, ready.messages, sameTerm ? ready.search : undefined) });
  };
  readonly moveSearchMatch = (direction: 'next' | 'previous'): void => {
    const search = this.#ready?.search;
    if (!this.#canRun() || search?.state !== 'matches' || search.matches.length < 2) return;
    const count = search.matches.length;
    const step = direction === 'next' ? 1 : -1;
    this.#publishReady({ search: Object.freeze({ ...search, activeIndex: (search.activeIndex + count + step) % count }) });
  };
  readonly closeSearch = (): void => {
    if (!this.#canRun() || !this.#ready || this.#ready.search.state === 'closed') return;
    this.#searchIndex = undefined;
    this.#publishReady({ search: closedSearch });
  };
  #searchFor(query: string, messages: readonly ConversationMessage[], previous?: ConversationSearchState): ConversationSearchState {
    if (!this.#searchIndex) return Object.freeze({ state: 'no-query', query });
    const matches = this.#searchIndex(messages);
    if (matches.length === 0) return Object.freeze({ state: 'no-matches', query });

    const activeSeq = previous?.state === 'matches' ? previous.matches[previous.activeIndex]!.serverSeq : undefined;
    // When history changes, keep the selected sequence or select the next one in order.
    const index = activeSeq === undefined ? 0 : matches.findIndex(match => match.serverSeq >= activeSeq);
    return Object.freeze({ state: 'matches', query, matches, activeIndex: Math.max(0, index) });
  }
  readonly restoreServerDraft = (): void => {
    const port = this.#draftPort;
    if (!port || this.#draftReadStarted) return;
    this.#draftReadStarted = true;
    const restoreText = !this.#resume;
    const revision = this.#draftRevision;
    void port.load().then(draft => {
      if (!this.#canRun() || this.#draftSave) return;
      // An editor that has already changed must not claim a late server draft.
      if (this.#draftRevision === revision) this.#storedDraftId = draft?.id;
      if (!restoreText || this.#draftRevision !== revision) return;
      const text = draft?.text ?? '';
      if (text !== this.#draft) {
        this.#draft = text; this.#draftRevision++;
        if (this.#ready) this.#publishReady({});
      }
    }).catch(() => { /* The list's last known draft remains available. */ });
  };

  readonly saveServerDraft = (): Promise<void> => {
    const port = this.#draftPort;
    if (!port || !this.#canRun() || !this.#draftDirty || this.#snapshot.phase !== 'ready' ||
      this.#snapshot.permissions.canWrite.state !== 'allowed') return Promise.resolve();
    const revision = this.#draftRevision;
    if (this.#draftSave?.revision === revision) return this.#draftSave.promise;
    let draft;
    try {
      draft = this.#draft.trim() ? normalizeConversationDraft({ id: crypto.randomUUID(), text: this.#draft }) : undefined;
    } catch { return Promise.resolve(); }
    if (this.#draft.trim() && !draft) return Promise.resolve();
    const promise = port.save(draft).then(() => {
      if (this.#draftSave?.promise !== promise) return;
      this.#storedDraftId = draft?.id;
      if (this.#draftRevision === revision) this.#draftDirty = false;
    }).catch(() => { /* Keep the editor and the server's last confirmed version. */ }).finally(() => {
      if (this.#draftSave?.promise === promise) this.#draftSave = undefined;
    });
    this.#draftSave = { id: draft?.id, revision, promise };
    return promise;
  };

  readonly setDraft = (text: string): void => {
    if (!this.#canRun() || this.#snapshot.phase !== 'ready' || this.#edit || typeof text !== 'string' || text === this.#draft) return;
    this.#draft = text; this.#draftRevision++; this.#draftDirty = true; this.#composerError = undefined;
    this.#publishReady({});
  };
  #canEdit(): boolean {
    return this.#canRun() && this.#snapshot.phase === 'ready' &&
      this.#snapshot.permissions.canRead.state === 'allowed' && this.#snapshot.permissions.canWrite.state === 'allowed';
  }
  #matchesEdit(edit: ConversationEditDraft, message: ConversationMessage): boolean {
    return canEditConversationMessage(message) && (message.versionSeq ?? message.serverSeq) === edit.versionSeq &&
      message.content.text.text === edit.originalText;
  }
  #editOperation(): ConversationOutgoingOperation | undefined {
    return this.#editOperationId ? this.#submissions.get(this.#editOperationId)?.operation : undefined;
  }
  #editLocked(): boolean {
    const phase = this.#editOperation()?.phase;
    return phase === 'preparing' || phase === 'publishing' || phase === 'unknown';
  }
  #clearEdit(): void {
    if (this.#editOperationId) this.#submissions.delete(this.#editOperationId);
    this.#editOperationId = undefined;
    this.#edit = undefined;
    this.#syncOutgoing();
  }
  readonly beginMessageEdit = (serverSeq: number): boolean => {
    if (!this.#canEdit() || this.#editLocked()) return false;
    const message = this.#messages.get(serverSeq);
    if (!message || !canEditConversationMessage(message)) return false;
    if (this.#edit?.serverSeq === serverSeq && !this.#edit.stale) return true;
    const text = message.content.text.text;
    this.#clearEdit();
    this.#edit = Object.freeze({ serverSeq, versionSeq: message.versionSeq ?? serverSeq, originalText: text, text, stale: false });
    this.#publishReady({});
    return true;
  };
  readonly setMessageEdit = (text: string): void => {
    if (!this.#canEdit() || !this.#edit || this.#editLocked() || text === this.#edit.text) return;
    if (this.#editOperationId) {
      this.#submissions.delete(this.#editOperationId); this.#editOperationId = undefined; this.#syncOutgoing();
    }
    this.#edit = Object.freeze({ ...this.#edit, text });
    this.#publishReady({});
  };
  readonly cancelMessageEdit = (): void => {
    if (!this.#edit || this.#editLocked()) return;
    this.#clearEdit();
    this.#publishReady({});
  };
  #prepareMessageEdit(): ConversationEditDraft | undefined {
    const edit = this.#edit;
    if (!edit || edit.stale || !this.#canEdit() || this.#snapshot.phase !== 'ready' ||
      this.#snapshot.composer.pending || this.#snapshot.composer.uncertain ||
      !edit.text.trim() || edit.text === edit.originalText) return;
    const current = this.#messages.get(edit.serverSeq);
    if (current && this.#matchesEdit(edit, current)) return edit;
  }
  readonly submitMessageEdit = (): Promise<void> => {
    if (this.#submission) return this.#submission.promise;
    const edit = this.#prepareMessageEdit(), port = this.#port;
    if (!edit || !port) return Promise.resolve();
    let operationId: string;
    try { operationId = crypto.randomUUID(); }
    catch {
      this.#composerError = Object.freeze({ area: 'send', kind: 'unsupported', messageCode: 'conversationUnavailable', retryable: false });
      this.#publishReady({}); return Promise.resolve();
    }
    if (this.#editOperationId) this.#submissions.delete(this.#editOperationId);
    this.#editOperationId = operationId;
    let resolve!: () => void;
    const work: SubmissionWork = { operationId, port, abort: new AbortController(), promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() };
    this.#submission = work;
    this.#submissions.set(operationId, { operationId, operation: Object.freeze({
      identity: this.identity, revision: 0, operationId, kind: 'edit', targetSeq: edit.serverSeq, phase: 'preparing',
    }) });
    this.#syncOutgoing(); this.#publishReady({});
    const task = Promise.resolve().then(async () => {
      try {
        if (!this.#currentSubmission(work) || this.#editOperationId !== operationId) return;
        const result = await port.sendEdit(operationId, edit, work.abort.signal);
        if (this.#currentSubmission(work)) this.#acceptOutgoing(result);
      } catch (reason: unknown) {
        if (!this.#currentSubmission(work)) return;
        const row = this.#submissions.get(operationId);
        if (!row) return;
        const state = row.operation;
        const failure: ConversationError = reason instanceof ConversationFailure ? copyError(reason.conversationError)
          : { area: 'send', kind: 'network', messageCode: 'conversationEditRejected', retryable: true };
        this.#acceptOutgoing(Object.freeze({ ...state, revision: state.revision + 1, ...(state.phase === 'preparing'
          ? { phase: 'rejected', error: failure } as const : { phase: 'unknown', messageCode: 'conversationSendUnknown' } as const) }));
      } finally {
        if (this.#submission === work) {
          this.#submission = undefined;
          if (this.#canRun() && this.#ready) {
            this.#publishReady({});
            if (this.#editOperation()?.operationId === operationId && this.#editOperation()?.phase === 'unknown') void this.reconcileText();
          }
        }
        work.resolve();
      }
    });
    this.#works.add(task); void task.then(() => this.#works.delete(task), () => this.#works.delete(task));
    return work.promise;
  };
  readonly submitText = (): Promise<void> => this.#edit ? Promise.resolve() : this.#submitText(this.#draft, true);
  readonly retryText = (operationId: string): Promise<void> => {
    if (this.#submission) return this.#submission.promise;
    const row = this.#submissions.get(operationId);
    if (!row || row.operation.phase !== 'rejected' || row.text === undefined) return Promise.resolve();
    // Retry the failed bubble's exact text; an independent draft is not submitted or cleared.
    return this.#submitText(row.text, false, row.submittedDraftIds);
  };
  #submitText(text: string, clearDraft: boolean, retryDraftIds?: readonly string[]): Promise<void> {
    if (this.#reconcile) return this.#reconcile.promise;
    if (this.#submission) return this.#submission.promise;
    if (this.#photoBatch) return Promise.resolve();
    if (!this.#canRun() || this.#snapshot.phase !== 'ready' || !this.#port || !this.#ready || !text.trim() ||
      this.#ready.permissions.canWrite.state !== 'allowed' || this.#ready.permissions.canRead.state !== 'allowed' ||
      this.#outgoing.some(row => row.operation.phase === 'unknown')) return Promise.resolve();
    let operationId: string;
    try { operationId = crypto.randomUUID(); }
    catch {
      this.#composerError = Object.freeze({ area: 'send', kind: 'unsupported', messageCode: 'conversationUnavailable', retryable: false });
      this.#publishReady({}); return Promise.resolve();
    }
    const port = this.#port;
    let resolve!: () => void;
    const work: SubmissionWork = { operationId, port, abort: new AbortController(), promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() };
    this.#submission = work;
    for (const [id, row] of this.#submissions) if (row.operation.kind === 'text' && (row.operation.phase === 'rejected' || row.operation.phase === 'cancelled')) this.#submissions.delete(id);
    const submittedDraftIds = clearDraft
      ? [...new Set([this.#storedDraftId, this.#draftSave?.id].filter(id => id !== undefined))]
      : retryDraftIds;
    this.#submissions.set(operationId, { operationId, text, submittedDraftIds,
      operation: Object.freeze({ identity: this.identity, revision: 0, operationId, kind: 'text', phase: 'preparing' }) });
    if (clearDraft) {
      this.#draft = ''; this.#draftRevision++; this.#draftDirty = false;
      this.#storedDraftId = undefined; this.#draftSave = undefined;
    }
    this.#syncOutgoing(); this.#composerError = undefined;
    this.#scrollRevision++; this.#scrollTarget = 'latest';
    this.#publishReady({});
    const task = Promise.resolve().then(async () => {
      try {
        if (!this.#currentSubmission(work)) return;
        const result = await port.sendText(operationId, text, work.abort.signal);
        if (this.#currentSubmission(work)) this.#acceptOutgoing(result);
      } catch (reason: unknown) {
        if (!this.#currentSubmission(work)) return;
        const row = this.#submissions.get(operationId)!;
        // Raw local failure cannot prove that a publication was rejected by Tinode.
        if (reason instanceof ConversationFailure && row.operation.phase === 'preparing') {
          row.operation = Object.freeze({ identity: this.identity, revision: row.operation.revision + 1, operationId,
            kind: 'text', phase: 'rejected', error: Object.freeze({ ...copyError(reason.conversationError), area: 'send' }) });
        } else if (row.operation.phase !== 'confirmed' && row.operation.phase !== 'rejected' && row.operation.phase !== 'cancelled') {
          row.operation = Object.freeze({ ...row.operation, phase: 'unknown', messageCode: 'conversationSendUnknown' });
        }
        this.#syncOutgoing(); this.#publishReady({});
      } finally {
        if (this.#submission === work) { this.#submission = undefined; if (this.#canRun() && this.#ready) this.#publishReady({}); }
        work.resolve();
      }
    });
    this.#works.add(task); void task.then(() => this.#works.delete(task), () => this.#works.delete(task));
    return work.promise;
  }
  // Opening the panel keeps the existing topic owner and conversation.
  readonly createInfoNavigation = (): ChatInfoNavigation | undefined => {
    const port = this.#port, snapshot = this.#snapshot;
    if (!port || !this.#canRun() || snapshot.phase !== 'ready' || snapshot.permissions.canRead.state !== 'allowed') return;
    const identity = Object.freeze({ ...this.identity, panelGeneration: ++this.#infoGeneration });
    const header = snapshot.header;
    const seed = Object.freeze(header.kind === 'personal'
      ? { kind: header.kind, title: header.title, avatar: header.avatar, presence: header.presence }
      : { kind: header.kind, title: header.title, avatar: header.avatar, participantCount: header.participantCount, ...(header.isChannel ? { isChannel: true as const } : {}) });
    // Suspend read receipts, recording, and playback before rendering the hidden message list.
    // An outgoing operation already handed to the controller continues independently.
    this.#viewportActive = false;
    this.#voiceLifetime.abort(); this.#voiceLifetime = new AbortController();
    this.#publishReady({});
    let maxMessageSize: ServerLimit | undefined;
    if (header.kind === 'group') {
      try { maxMessageSize = port.mediaLimits?.().maxMessageSize; } catch { /* A closing session cannot supply limits. */ }
    }
    return Object.freeze({ identity, seed, maxMessageSize, openPort: () => {
      if (this.#port !== port || !this.#canRun() || this.#snapshot.phase !== 'ready' ||
        this.#snapshot.permissions.canRead.state !== 'allowed') return Promise.reject(new ConversationFailure({
          area: 'history', kind: 'sessionClosed', messageCode: 'conversationUnavailable', retryable: false,
        }));
      return port.openInfoPort(identity.panelGeneration);
    } });
  };
  get voiceSignal(): AbortSignal { return this.#voiceLifetime.signal; }
  readonly voiceLimit = (): ServerLimit => {
    try {
      const limits = this.#port?.mediaLimits?.();
      return limits?.maxInlineMediaSize ?? limits?.maxFileUploadSize ?? { state: 'unknown' };
    }
    catch { return { state: 'unknown' }; }
  };
  readonly submitVoice = (file: PreparedVoice): Promise<void> => {
    if (this.#submission) return this.#submission.promise;
    const port = this.#port;
    if (!port || this.#photoBatch || this.#reconcile || !this.#canSendPhotos(port) || this.#outgoing.some(row => row.operation.phase === 'unknown')) return Promise.resolve();
    const limit = this.voiceLimit();
    if (limit.state !== 'known' || !integer(limit.value, 1) || !(file.blob instanceof Blob) || !file.blob.size ||
      file.blob.size > Math.min(limit.value, 16 * 1024 * 1024) || !integer(file.durationMs, 1)) {
      this.#composerError = Object.freeze({ area: 'send', kind: 'invalidResponse', messageCode: 'conversationVoiceSendFailed', retryable: true });
      this.#publishReady({}); return Promise.resolve();
    }
    const operationId = crypto.randomUUID();
    let resolve!: () => void;
    const work: SubmissionWork = { operationId, port, abort: new AbortController(), promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() };
    this.#submission = work;
    for (const [id, row] of this.#submissions) if (row.operation.kind === 'voice' && ['rejected', 'cancelled'].includes(row.operation.phase)) {
      this.#dropVoice(id); this.#submissions.delete(id);
    }
    const retained = Object.freeze({ ...file });
    const media: VoiceMedia = Object.freeze({ state: 'available', resourceId: this.identity.topicKey + ':local-voice:' + operationId });
    this.#voiceFiles.set(operationId, retained); this.#localVoiceSources.set(media, retained);
    const attachment: VoiceAttachment = Object.freeze({ kind: 'voice', media, mime: file.blob.type, filename: file.filename,
      durationMs: Object.freeze({ state: 'known', value: file.durationMs }), size: Object.freeze({ state: 'known', value: file.blob.size }) });
    const row: Submission = { operationId, voice: Object.freeze({ attachment, canRetry: false, uploadProgress: 0 }),
      operation: Object.freeze({ identity: this.identity, revision: 0, operationId, kind: 'voice', phase: 'preparing' }) };
    this.#submissions.set(operationId, row); this.#composerError = undefined;
    this.#scrollRevision++; this.#scrollTarget = 'latest'; this.#syncOutgoing(); this.#publishReady({});
    const task = Promise.resolve().then(async () => {
      try {
        if (!this.#currentSubmission(work)) return;
        const result = await port.sendPreparedMedia(operationId, createPreparedMedia(this.identity, retained), work.abort.signal, fraction => {
          if (!this.#currentSubmission(work) || row.operation.phase !== 'preparing') return;
          row.voice = Object.freeze({ ...row.voice!, uploadProgress: fraction }); this.#syncOutgoing(); this.#publishReady({});
        });
        if (this.#currentSubmission(work)) this.#acceptOutgoing(result);
      } catch (reason: unknown) {
        if (!this.#currentSubmission(work)) return;
        if (row.operation.phase === 'preparing') this.#acceptOutgoing(Object.freeze({ ...row.operation, revision: row.operation.revision + 1,
          phase: 'rejected', error: Object.freeze({ area: 'send', kind: 'network', messageCode: 'conversationVoiceSendFailed', retryable: true }) }));
        else if (row.operation.phase === 'publishing') this.#acceptOutgoing(Object.freeze({ ...row.operation, phase: 'unknown', messageCode: 'conversationSendUnknown' }));
      } finally {
        if (this.#submission === work) { this.#submission = undefined; if (this.#canRun() && this.#ready) this.#publishReady({}); }
        work.resolve();
      }
    });
    this.#works.add(task); void task.then(() => this.#works.delete(task), () => this.#works.delete(task));
    return work.promise;
  };
  readonly retryVoice = (operationId: string): Promise<void> => {
    const row = this.#submissions.get(operationId), file = this.#voiceFiles.get(operationId);
    return row?.operation.phase === 'rejected' && file ? this.submitVoice(file) : Promise.resolve();
  };
  #dropVoice(operationId: string): void {
    const media = this.#submissions.get(operationId)?.voice?.attachment.media;
    if (media?.state === 'available') this.#localVoiceSources.delete(media);
    this.#voiceFiles.delete(operationId);
  }
  readonly acquireVoice = async (media: VoiceMedia, signal: AbortSignal): Promise<MediaLease> => {
    const port = this.#port;
    if (!port || !this.#canRun() || this.#ready?.permissions.canRead.state !== 'allowed') throw new MediaFailure('unavailable');
    const abort = new AbortController(), cancel = () => abort.abort();
    signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel(); this.#photoReads.add(abort);
    try {
      const local = this.#localVoiceSources.get(media);
      const lease = local ? await this.#localVoiceResources.acquire(media.resourceId, async (lifetime, reserve) => {
        if (lifetime.aborted) throw new MediaFailure('aborted'); reserve(local.blob.size); return local.blob;
      }, abort.signal) : await port.acquireVoice(media, abort.signal);
      if (abort.signal.aborted || !this.#canRun() || this.#port !== port || this.#ready?.permissions.canRead.state !== 'allowed') {
        lease.release({ discard: true }); throw new MediaFailure('aborted');
      }
      return lease;
    } finally { signal.removeEventListener('abort', cancel); this.#photoReads.delete(abort); }
  };
  readonly submitPhotos = (files: readonly File[]): Promise<void> => {
    const port = this.#port;
    if (!port || this.#photoBatch || this.#submission || this.#reconcile || files.length === 0 ||
      this.#outgoing.some(row => row.operation.phase === 'unknown') || !this.#canSendPhotos(port)) return Promise.resolve();
    const batch = new AbortController();
    this.#photoBatch = batch;
    const selected = [...files];
    this.#composerError = undefined;
    this.#publishReady({});
    const task = this.#sendPhotoBatch(selected, port, batch);
    this.#works.add(task);
    void task.then(() => this.#works.delete(task), () => this.#works.delete(task));
    return task;
  };
  #canSendPhotos(port: ConversationPort, batch?: AbortController): boolean {
    return this.#canRun() && this.#port === port && this.#snapshot.phase === 'ready' &&
      (batch === undefined || (this.#photoBatch === batch && !batch.signal.aborted)) &&
      this.#ready?.permissions.canWrite.state === 'allowed' && this.#ready.permissions.canRead.state === 'allowed';
  }
  async #sendPhotoBatch(files: File[], port: ConversationPort, batch: AbortController): Promise<void> {
    const operationId = crypto.randomUUID();
    const photos: { filename: string; preview?: AvatarImageSource; width?: number; height?: number }[] = files.map(file => ({ filename: file.name }));
    const row: Submission = { operationId, photo: Object.freeze({ filename: files[0]!.name,
      ...(files.length > 1 ? { photos: Object.freeze(photos.map(photo => Object.freeze({ ...photo }))) } : {}) }),
      operation: Object.freeze({ identity: this.identity, revision: 0, operationId, kind: 'photo', phase: 'preparing' }) };
    this.#submissions.set(operationId, row);
    this.#scrollRevision++; this.#scrollTarget = 'latest';
    this.#syncOutgoing(); this.#publishReady({});
    try {
      const { preparePhotoAlbum } = await import('../media/PhotoAlbumPreparation');
      const prepared = await preparePhotoAlbum(files, port.mediaLimits(), batch.signal, (index, photo) => {
        if (!this.#canSendPhotos(port, batch)) return;
        let preview: AvatarImageSource | undefined;
        if (photo.preview && index < 4) {
          const bytes = Uint8Array.from(atob(photo.preview), char => char.charCodeAt(0));
          preview = URL.createObjectURL(new Blob([bytes], { type: photo.blob.type })) as AvatarImageSource;
          let owned = this.#localPhotoPreviews.get(operationId);
          if (!owned) this.#localPhotoPreviews.set(operationId, owned = new Set());
          owned.add(preview);
        }
        photos[index] = { filename: photo.filename, width: photo.width, height: photo.height, ...(preview ? { preview } : {}) };
        row.photo = Object.freeze({ filename: photos[0]!.filename,
          ...(files.length === 1 ? (preview ? { preview } : {})
            : { photos: Object.freeze(photos.map(item => Object.freeze({ ...item }))) }) });
        this.#syncOutgoing(); this.#publishReady({});
      });
      if (!this.#canSendPhotos(port, batch)) return;
      const result = await port.sendPreparedMedia(operationId, createPreparedMedia(this.identity, prepared), batch.signal, fraction => {
        if (!this.#canSendPhotos(port, batch) || row.operation.phase !== 'preparing') return;
        row.photo = Object.freeze({ ...row.photo!, uploadProgress: fraction });
        this.#syncOutgoing(); this.#publishReady({});
      });
      if (this.#photoBatch === batch && this.#port === port && this.#canRun() && this.#snapshot.phase === 'ready') this.#acceptOutgoing(result);
    } catch (reason: unknown) {
      if (this.#photoBatch !== batch || this.#port !== port || !this.#canRun() || this.#snapshot.phase !== 'ready' || batch.signal.aborted) return;
      const error: ConversationError = reason instanceof ConversationFailure
        ? Object.freeze({ ...copyError(reason.conversationError), area: 'send' })
        : Object.freeze({ area: 'send', kind: reason instanceof MediaFailure && reason.reason === 'tooLarge' ? 'tooLarge' : 'unsupported',
          messageCode: reason instanceof MediaFailure && reason.reason === 'tooLarge' ? 'conversationMediaTooLarge'
            : reason instanceof MediaFailure && reason.reason === 'unsupported' ? 'conversationMediaUnsupported' : 'conversationPhotoPreparationFailed', retryable: false });
      this.#acceptOutgoing(row.operation.phase === 'publishing'
        ? Object.freeze({ ...row.operation, phase: 'unknown', messageCode: 'conversationSendUnknown' })
        : Object.freeze({ ...row.operation, phase: 'rejected', error }));
    } finally {
      if (this.#photoBatch === batch) {
        this.#photoBatch = undefined;
        for (const [id, item] of this.#submissions) if (item.operation.kind === 'photo' && item.operation.phase === 'preparing') this.#submissions.delete(id);
        this.#syncOutgoing();
        if (this.#canRun() && this.#ready) this.#publishReady({});
      }
    }
  }
  readonly releaseLocalPhotoPreview = (operationId: string, preview: string): void => {
    const owned = this.#localPhotoPreviews.get(operationId);
    if (!owned?.has(preview as AvatarImageSource)) return;
    owned.delete(preview as AvatarImageSource);
    if (!owned.size) this.#localPhotoPreviews.delete(operationId);
    URL.revokeObjectURL(preview);
  };
  readonly acquirePhoto = async (photo: PhotoAttachment, signal: AbortSignal): Promise<MediaLease> => {
    const port = this.#port;
    if (!port || !this.#canRun() || this.#ready?.permissions.canRead.state !== 'allowed' || photo.media.state !== 'available') {
      throw new MediaFailure('unavailable');
    }
    const abort = new AbortController();
    const cancel = () => abort.abort();
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    this.#photoReads.add(abort);
    try {
      const lease = await port.acquirePhoto(photo.media, abort.signal);
      if (abort.signal.aborted || this.#port !== port || !this.#canRun() || this.#ready?.permissions.canRead.state !== 'allowed') {
        lease.release({ discard: true });
        throw new MediaFailure('aborted');
      }
      return lease;
    } finally {
      signal.removeEventListener('abort', cancel);
      this.#photoReads.delete(abort);
    }
  };
  readonly acquirePhotoPreview = (preview: NonNullable<PhotoAttachment['preview']>, signal: AbortSignal): Promise<MediaLease> => {
    const port = this.#port;
    const load = this.#previewQueue.then(async () => {
      if (signal.aborted || !port || this.#port !== port || !this.#canRun() || this.#ready?.permissions.canRead.state !== 'allowed') {
        throw new MediaFailure('aborted');
      }
      const lease = await port.acquirePhotoPreview(preview, signal);
      if (signal.aborted || this.#port !== port || !this.#canRun()) { lease.release(); throw new MediaFailure('aborted'); }
      return lease;
    });
    this.#previewQueue = load.then(() => {}, () => {});
    return load;
  };
  readonly reconcileText = (): Promise<void> => {
    if (this.#reconcile) return this.#reconcile.promise;
    if (!this.#canRun() || this.#snapshot.phase !== 'ready' || !this.#port || this.#operation || this.#submission || this.#photoBatch ||
      this.#ready?.permissions.canRead.state !== 'allowed') return Promise.resolve();
    this.#confirmKnownOutgoing();
    const edit = this.#editOperationId ? this.#submissions.get(this.#editOperationId) : undefined;
    const row = edit?.operation.phase === 'unknown' ? edit : [...this.#submissions.values()].find(row => row.operation.phase === 'unknown');
    if (!row) { this.#publishReady({}); return Promise.resolve(); }
    const port = this.#port; let resolve!: () => void;
    const work: ReconcileWork = { operationId: row.operationId, port, abort: new AbortController(), promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() };
    this.#reconcile = work;
    this.#verification = Object.freeze({ operationId: row.operationId, state: 'checking' }); this.#publishReady({});
    const task = Promise.resolve().then(async () => {
      try {
        if (!this.#currentReconcile(work)) return;
        const result = await port.reconcile({ operationId: row.operationId, targetSeq: row.operation.targetSeq,
          ...(row.operation.afterSeq === undefined ? {} : { afterSeq: row.operation.afterSeq }),
          ...(row.cursor === undefined ? {} : { cursor: row.cursor }) }, work.abort.signal);
        if (!this.#currentReconcile(work)) return;
        this.#checkContext(result);
        if (result.operationId !== row.operationId || !Array.isArray(result.pages) || result.pages.length > 1) throw invalid();
        const cursor = result.cursor;
        if (cursor && (!integer(cursor.before, 1) || !integer(cursor.upperSeq) || cursor.before > cursor.upperSeq ||
          cursor.before <= (row.operation.afterSeq ?? 0) + 1)) throw invalid();
        const merge: Operation = { kind: 'gap', scrollRevision: this.#scrollRevision, abort: work.abort,
          promise: work.promise, resolve: () => {}, messages: new Map() };
        const ranges: ConversationHistoryRange[] = [];
        for (const page of result.pages) {
          this.#checkPage(page, true, true); this.#mergeMessages(page, merge);
          this.#snapshotUpper = page.range.snapshotUpperSeq.state === 'known' ? page.range.snapshotUpperSeq.value : this.#snapshotUpper;
          ranges.push(...this.#pages(page).map(part => copyRange(part.range)));
        }
        if (result.match) {
          const match = copyMessage(result.match);
          if (!this.#matchesOutgoing(match, row)) throw invalid();
          this.#acceptRaw(match, result.revision); this.#rebuild();
        }
        row.cursor = row.operation.phase === 'unknown' && cursor ? Object.freeze({ before: cursor.before, upperSeq: cursor.upperSeq }) : undefined;
        this.#syncOutgoing(); this.#confirmKnownOutgoing();
        this.#verification = row.operation.phase === 'unknown' ? Object.freeze({ operationId: row.operationId, state: 'unconfirmed' }) : undefined;
        this.#publishReady({ messages: sortConversationMessages([...this.#messages.values()]),
          history: Object.freeze({ ...this.#ready!.history, ranges: Object.freeze([...this.#ready!.history.ranges, ...ranges]) }),
          reading: this.#reading(this.#ready!.reading) });
      } catch (reason: unknown) {
        if (!this.#currentReconcile(work)) return;
        this.#verification = Object.freeze({ operationId: row.operationId, state: 'failed', error: requestError(reason) });
        this.#publishReady({});
      } finally {
        if (this.#reconcile === work) { this.#reconcile = undefined; if (this.#canRun() && this.#ready) this.#publishReady({}); }
        work.resolve();
      }
    });
    this.#works.add(task); void task.then(() => this.#works.delete(task), () => this.#works.delete(task));
    return work.promise;
  };
  #currentReconcile(work: ReconcileWork): boolean {
    return this.#canRun() && this.#snapshot.phase === 'ready' && this.#reconcile === work && this.#port === work.port && !work.abort.signal.aborted;
  }
  #matchesOutgoing(message: ConversationMessage, row: Submission): boolean {
    return message.sender.state === 'self' && message.sender.uid === this.identity.account.uid && message.operationId === row.operationId &&
      message.originalSeq === row.operation.targetSeq && message.timestamp.state === 'known' && message.serverSeq > (row.operation.afterSeq ?? 0);
  }
  #confirmKnownOutgoing(): void {
    for (const row of this.#submissions.values()) {
      if (row.operation.phase !== 'unknown') continue;
      for (const message of this.#rawMessages.values()) {
        if (!this.#matchesOutgoing(message, row) || conversationSeqDeleted(message.serverSeq, this.#deletion.ranges) ||
          message.timestamp.state !== 'known') continue;
        this.#acceptOutgoing(Object.freeze({ ...row.operation, revision: row.operation.revision + 1,
          phase: 'confirmed', serverSeq: message.serverSeq, timestamp: message.timestamp.at }), message);
        break;
      }
    }
  }
  #currentSubmission(work: SubmissionWork): boolean {
    return this.#canRun() && this.#snapshot.phase === 'ready' && this.#submission === work && this.#port === work.port && !work.abort.signal.aborted;
  }
  #acceptOutgoing(value: ConversationOutgoingOperation, proof?: ConversationMessage): void {
    this.#checkContext(value);
    const row = this.#submissions.get(value.operationId);
    if (!row || value.kind !== row.operation.kind || value.targetSeq !== row.operation.targetSeq || ((value.kind === 'photo' || value.kind === 'voice') && value.phase === 'preparing') ||
      value.revision < row.operation.revision ||
      (value.afterSeq !== undefined && (!integer(value.afterSeq) || (row.operation.afterSeq !== undefined && value.afterSeq !== row.operation.afterSeq))) ||
      (value.requestId !== undefined && (typeof value.requestId !== 'string' || !value.requestId)) ||
      (row.operation.requestId !== undefined && value.requestId !== row.operation.requestId)) return;
    if (row.operation.phase === 'confirmed' || row.operation.phase === 'rejected' || row.operation.phase === 'cancelled') return;
    if (row.operation.phase === 'unknown' && value.phase !== 'confirmed' && value.phase !== 'rejected') return;
    const base = { identity: this.identity, revision: value.revision, kind: row.operation.kind, operationId: row.operationId,
      targetSeq: row.operation.targetSeq,
      ...(value.requestId === undefined ? {} : { requestId: value.requestId }),
      ...((value.afterSeq ?? row.operation.afterSeq) === undefined ? {} : { afterSeq: value.afterSeq ?? row.operation.afterSeq }) };
    let copied: ConversationOutgoingOperation;
    if (value.phase === 'confirmed') {
      const at = normalizeServerTimestamp(value.timestamp);
      if (!integer(value.serverSeq, 1) || at === undefined || (!value.requestId && (!proof || !this.#matchesOutgoing(proof, row) ||
        proof.serverSeq !== value.serverSeq || proof.timestamp.state !== 'known' || proof.timestamp.at !== at))) return;
      if (value.kind === 'edit') {
        const confirmed = this.#rawMessages.get(value.serverSeq);
        if (!confirmed || !this.#matchesOutgoing(confirmed, row) || this.#editOperationId !== row.operationId) return;
        row.operation = Object.freeze({ ...base, phase: 'confirmed', serverSeq: value.serverSeq, timestamp: at });
        this.#clearEdit(); this.#verification = undefined;
        this.#publishReady({});
        return;
      }
      copied = Object.freeze({ ...base, phase: 'confirmed', serverSeq: value.serverSeq, timestamp: at });
      row.text = undefined;
      if (row.submittedDraftIds?.length) void this.#draftPort?.clear(row.submittedDraftIds).catch(() => {});
      row.submittedDraftIds = undefined;
      if (row.voice) { this.#dropVoice(row.operationId); row.voice = undefined; }
      if (this.#atEnd) { this.#scrollRevision++; this.#scrollTarget = 'latest'; }
    } else if (value.phase === 'rejected') copied = Object.freeze({ ...base, phase: 'rejected', error: row.operation.kind === 'voice'
      ? Object.freeze({ ...copyError(value.error), messageCode: 'conversationVoiceSendFailed', retryable: true }) : copyError(value.error) });
    else if (value.phase === 'unknown') copied = Object.freeze({ ...base, phase: 'unknown', messageCode: 'conversationSendUnknown' });
    else if (value.phase === 'preparing' || value.phase === 'publishing' || value.phase === 'cancelled') copied = Object.freeze({ ...base, phase: value.phase });
    else return;
    row.operation = copied;
    if (copied.kind === 'edit' && this.#editOperationId === row.operationId && copied.phase === 'rejected' &&
      copied.error.messageCode === 'conversationEditStale' && this.#edit) this.#edit = Object.freeze({ ...this.#edit, stale: true });
    if (copied.phase === 'cancelled' && row.voice) { this.#dropVoice(row.operationId); row.voice = undefined; }
    if (copied.phase === 'confirmed' || copied.phase === 'rejected' || copied.phase === 'cancelled') row.cursor = undefined;
    this.#syncOutgoing(); this.#publishReady({});
  }
  #syncOutgoing(): void {
    this.#outgoing = Object.freeze([...this.#submissions.values()].map(row => Object.freeze({ operation: row.operation,
      ...(row.text === undefined ? {} : { text: row.text }),
      ...(row.submittedDraftIds?.length ? { submittedDraftIds: row.submittedDraftIds } : {}), ...(row.photo === undefined ? {} : { photo: row.photo }),
      ...(row.voice === undefined ? {} : { voice: Object.freeze({ ...row.voice, canRetry: row.operation.phase === 'rejected' && this.#voiceFiles.has(row.operationId) }) }),
      ...(row.cursor === undefined ? {} : { reconcileCursor: row.cursor }) })));
  }
  #composer(): ConversationReadySnapshot['composer'] {
    const verification: ConversationVerification | undefined = this.#reconcile
      ? Object.freeze({ operationId: this.#reconcile.operationId, state: 'checking' })
      : this.#outgoing.some(row => row.operation.operationId === this.#verification?.operationId && row.operation.phase === 'unknown') ? this.#verification : undefined;
    const editOperation = this.#editOperation();
    return Object.freeze({ text: this.#draft, revision: this.#draftRevision, ...(this.#edit ? { edit: this.#edit } : {}),
      ...(editOperation ? { editOperation } : {}), pending: this.#submission !== undefined || this.#reconcile !== undefined || this.#photoBatch !== undefined,
      canVerify: !this.#operation && !this.#submission && !this.#photoBatch && !this.#reconcile && this.#ready?.permissions.canRead.state === 'allowed',
      ...(verification === undefined ? {} : { verification }),
      uncertain: this.#outgoing.some(row => row.operation.phase === 'unknown'),
      ...(this.#composerError === undefined ? {} : { error: this.#composerError }) });
  }

  readonly reportEndPosition = (atEnd: boolean): void => {
    if (this.#snapshot.phase !== 'ready' || !this.#ready) return;
    this.#atEnd = atEnd;
    const atLatest = atEnd && this.#coversLatestVisibleSeq();
    if (atLatest === this.#atLatest) return;
    this.#atLatest = atLatest;
    this.#publishReady({});
  };
  #coversLatestVisibleSeq(): boolean {
    let latest = this.#latestKnown;
    // Server seq stays at the last assigned number even if the tail was deleted.
    const deleted = this.#deletion.ranges;
    for (let index = deleted.length - 1; index >= 0; index--) {
      const { low, hi } = deleted[index];
      if (low > latest) continue;
      if (latest > (hi === undefined ? low : hi - 1)) break;
      latest = low - 1;
    }
    return latest === 0 || this.#coverage.some(range => range.low <= latest && latest <= range.high);
  }
  readonly goToLatest = (): Promise<void> => {
    if (!this.#canRun() || this.#snapshot.phase !== 'ready' || !this.#ready || !this.#port || this.#blockedError) return Promise.resolve();
    return this.#reconcile?.promise ?? this.#operation?.promise ?? this.#begin('latest');
  };
  readonly goToReadPosition = (): Promise<void> => {
    if (!this.#canRun() || this.#snapshot.phase !== 'ready' || !this.#ready || !this.#port || this.#blockedError) return Promise.resolve();
    if (this.#reconcile) return this.#reconcile.promise;
    if (this.#operation) return this.#operation.promise;
    const read = Math.max(this.#confirmedRead.state === 'known' ? this.#confirmedRead.value : 0, this.#pendingRead);
    const raw = this.#rawMessages.get(read);
    if (raw && this.#messages.has(raw.originalSeq ?? read) &&
      !(this.#ready.newer.state === 'failed' && !this.#ready.newer.error.retryable)) {
      const target = this.#projectTarget({ kind: 'message', serverSeq: read, reason: 'lastRead' });
      if (target.kind === 'message' && target.serverSeq === (raw.originalSeq ?? read)) {
        this.#scrollRevision++; this.#scrollTarget = target.serverSeq; this.#atLatest = false;
        this.#publishReady({ newer: idle }); return Promise.resolve();
      }
    }
    return this.#begin('read');
  };
  readonly loadGap = (query: ConversationPageQuery): Promise<void> => {
    if (!this.#canRun() || this.#snapshot.phase !== 'ready' || !this.#ready || !this.#port || this.#blockedError ||
      !this.#gaps().some(gap => sameQuery(gap.query, query))) return Promise.resolve();
    return this.#reconcile?.promise ?? this.#operation?.promise ?? this.#begin('gap', query);
  };
  readonly setViewportActive = (active: boolean): void => { this.#viewportActive = active === true && this.#canRun(); };
  readonly reportVisibleMessages = (seqs: readonly number[]): void => {
    const ready = this.#ready;
    if (!this.#viewportActive || !this.#canRun() || this.#snapshot.phase !== 'ready' || !ready ||
      ready.permissions.canRead.state !== 'allowed' || !this.#port || !Array.isArray(seqs)) return;
    let viewed = 0;
    // The UI reports visible original message IDs. Look up their server versions in the model.
    for (const seq of seqs.slice(0, 80)) {
      if (!integer(seq, 1)) continue;
      const message = this.#messages.get(seq);
      if (message) viewed = Math.max(viewed, message.versionSeq ?? message.serverSeq);
    }
    if (!viewed || viewed <= Math.max(this.#confirmedRead.state === 'known' ? this.#confirmedRead.value : 0, this.#pendingRead)) return;
    try {
      this.#port.markRead(viewed);
      // Sending a note is fire-and-forget. A server update may arrive before the call returns.
      if (viewed > (this.#confirmedRead.state === 'known' ? this.#confirmedRead.value : 0)) this.#pendingRead = Math.max(this.#pendingRead, viewed);
      this.#publishReady({ reading: this.#reading(ready.reading) });
    } catch { /* A local failure does not lower the counter. Another visibility event can retry the note. */ }
  };
  readonly start = (): Promise<void> => {
    if (!this.#canRun()) return Promise.resolve();
    return this.#operation?.promise ?? (this.#snapshot.phase === 'idle' ? this.#begin('initial') : Promise.resolve());
  };
  readonly retry = (): Promise<void> => {
    if (!this.#canRun()) return Promise.resolve();
    if (this.#reconcile) return this.#reconcile.promise;
    if (this.#operation) return this.#operation.promise;
    if (this.#snapshot.phase === 'idle') return this.start();
    if (this.#snapshot.phase === 'error' && this.#snapshot.error.retryable) return this.#begin('initial');
    if (this.#ready?.older.state === 'failed' && this.#ready.older.error.retryable) return this.loadOlder();
    return Promise.resolve();
  };
  readonly loadOlder = (): Promise<void> => {
    if (!this.#canRun()) return Promise.resolve();
    if (this.#reconcile) return this.#reconcile.promise;
    if (this.#operation) return this.#operation.promise;
    const ready = this.#ready;
    if (this.#snapshot.phase !== 'ready' || !ready || !this.#port || ready.history.older.state !== 'more' ||
      this.#blockedError || (ready.older.state === 'failed' && !ready.older.error.retryable)) return Promise.resolve();
    return this.#begin('older', { ...ready.history.older.query, limit: 32 });
  };
  #begin(kind: Operation['kind'], query?: ConversationPageQuery): Promise<void> {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    const operation: Operation = { kind, query, promise, resolve, scrollRevision: this.#scrollRevision, abort: new AbortController(), messages: new Map() };
    this.#operation = operation; activeControllers.add(this);
    if (kind === 'initial') { this.#clear(); this.#publish(Object.freeze({ phase: 'opening', identity: this.identity })); }
    else if (this.#ready) this.#publishReady(kind === 'older' ? { older: Object.freeze({ state: 'pending' }) }
      : { newer: Object.freeze({ state: 'pending', target: kind === 'latest' || kind === 'read' ? kind : query!.since! }) });
    const work = Promise.resolve().then(() => this.#run(operation));
    this.#works.add(work);
    void work.then(() => this.#works.delete(work), () => this.#works.delete(work));
    return promise;
  }
  async #run(operation: Operation): Promise<void> {
    try {
      if (!this.#current(operation)) return;
      if (operation.kind === 'initial') {
        await this.#cleanup;
        if (!this.#current(operation)) return;
        if (this.#blockedError) throw new ConversationFailure(this.#blockedError);
        const port = await this.#openPort();
        if (!this.#current(operation)) { this.#retire(port); return; }
        if (port.topicKey !== this.identity.topicKey || !sameIdentity(this.identity,
          normalizeConversationIdentity(port.account, port.topicKey))) { this.#retire(port); throw invalid(); }
        this.#port = port;
        const detach = port.subscribe(event => this.#onEvent(port, event));
        if (!this.#current(operation) || this.#port !== port) { detach(); return; }
        this.#detachPort = detach;
        const resume = this.#resume;
        const position = resume?.atEnd ? { kind: 'latest' as const } : resume?.anchor
          ? { kind: 'anchor' as const, serverSeq: resume.anchor.serverSeq } : undefined;
        const result = await port.open(operation.abort.signal, position);
        if (!this.#current(operation)) return;
        this.#acceptOpen(result, operation);
      } else {
        const port = this.#port!;
        const readPosition = operation.kind === 'read' ? await port.loadReadPosition(operation.abort.signal) : undefined;
        const result = readPosition?.history ?? (operation.kind === 'latest' ? await port.loadLatest(operation.abort.signal)
          : await port.loadPage(operation.query!, operation.abort.signal));
        if (!this.#current(operation)) return;
        this.#checkContext(result); this.#checkPage(result, true, operation.kind === 'latest' || operation.kind === 'read' || operation.kind === 'gap');
        if (operation.kind !== 'latest' && operation.kind !== 'read' && (!sameQuery(result.range.query, operation.query!) ||
          (result.range.older.state === 'more' && sameQuery(result.range.older.query, operation.query!)))) throw invalid();
        if (operation.kind === 'latest' || operation.kind === 'read' || operation.kind === 'gap') this.#snapshotUpper = result.range.snapshotUpperSeq.state === 'known' ? result.range.snapshotUpperSeq.value : undefined;
        const context = readPosition?.contextPages ?? [];
        if (readPosition) {
          this.#checkContext(readPosition);
          const readTarget = readPosition.target;
          if (!Array.isArray(context) || context.length > 31 ||
            (readTarget.kind === 'message' && !result.messages.some(message => message.serverSeq === readTarget.serverSeq))) throw invalid();
          for (const page of context) {
            this.#checkPage(page, true, true);
            if (page.range.snapshotUpperSeq.state !== 'known' || result.range.snapshotUpperSeq.state !== 'known' ||
              page.range.snapshotUpperSeq.value !== result.range.snapshotUpperSeq.value) throw invalid();
          }
        }
        const range = copyRange(result.range);
        this.#mergeMessages(result, operation);
        for (const page of context) this.#mergeMessages(page, operation);
        const previous = this.#ready!;
        this.#finish(operation);
        if ((operation.kind === 'latest' || readPosition) && this.#scrollRevision === operation.scrollRevision) {
          this.#scrollRevision++; this.#atLatest = false;
          const target = readPosition ? this.#projectTarget(readPosition.target) : undefined;
          this.#scrollTarget = target?.kind === 'message' ? target.serverSeq : 'latest';
        }
        this.#publishReady({ messages: sortConversationMessages([...this.#messages.values()]),
          ...(operation.kind === 'older' ? { older: idle } : { newer: idle }),
          history: Object.freeze({ ranges: Object.freeze([...previous.history.ranges, ...[result, ...context].flatMap(page => this.#pages(page)).map(part => copyRange(part.range))]),
            older: operation.kind === 'older' ? range.older : previous.history.older,
            newer: operation.kind === 'latest' || readPosition ? context.at(-1)?.range.newer ?? range.newer : previous.history.newer }) });
      }
    } catch (reason: unknown) {
      if (!this.#current(operation)) return;
      const error = requestError(reason);
      this.#finish(operation);
      if (error.kind === 'sessionClosed') { void this.suspend(error); return; }
      if (operation.kind === 'older') this.#publishReady({ older: Object.freeze({ state: 'failed', error }) });
      else if (operation.kind !== 'initial') this.#publishReady({ newer: Object.freeze({ state: 'failed', error, target: operation.kind === 'latest' || operation.kind === 'read' ? operation.kind : operation.query!.since! }) });
      else {
        this.#detachCurrent(); this.#clear();
        this.#publish(Object.freeze({ phase: 'error', identity: this.identity, error }));
      }
    } finally { operation.resolve(); }
  }
  #checkContext(value: { readonly identity: ConversationIdentity; readonly revision: number }): void {
    if (!sameIdentity(value.identity, this.identity) || !integer(value.revision)) throw invalid();
  }
  #checkPage(value: ConversationPageResult, related = true, latest = false): void {
    this.#checkContext(value);
    if (!integer(value.receivedCount) || value.receivedCount > value.range.query.limit ||
      value.messages.length > value.receivedCount || value.range.snapshotUpperSeq.state !== 'known' ||
      !integer(value.range.snapshotUpperSeq.value) ||
      (this.#snapshotUpper !== undefined && (latest ? value.range.snapshotUpperSeq.value < this.#snapshotUpper
        : value.range.snapshotUpperSeq.value !== this.#snapshotUpper))) throw invalid();
    copyRange(value.range);
    const seen = new Set<number>();
    for (const message of value.messages) {
      if (!integer(message.serverSeq, 1) || seen.has(message.serverSeq) ||
        message.serverSeq > value.range.snapshotUpperSeq.value || message.serverSeq < (value.range.query.since ?? 1) ||
        (value.range.query.before !== undefined && message.serverSeq >= value.range.query.before)) throw invalid();
      seen.add(message.serverSeq);
    }
    const pages = value.relatedPages;
    if (pages !== undefined) {
      if (!related || !Array.isArray(pages) || pages.length > 32) throw invalid();
      for (const page of pages) {
        this.#checkPage(page, false, latest);
        if (page.range.query.limit !== 1 || page.range.query.since === undefined ||
          page.range.snapshotUpperSeq.state !== 'known' || value.range.snapshotUpperSeq.state !== 'known' ||
          page.range.snapshotUpperSeq.value !== value.range.snapshotUpperSeq.value) throw invalid();
      }
    }
  }
  #acceptOpen(value: ConversationOpenResult, operation: Operation): void {
    this.#checkContext(value); this.#checkPage(value.history);
    this.#snapshotUpper = value.history.range.snapshotUpperSeq.state === 'known' ? value.history.range.snapshotUpperSeq.value : undefined;
    this.#openingUpper = this.#snapshotUpper ?? 0; this.#latestKnown = Math.max(this.#latestKnown, this.#openingUpper);
    const target = value.target;
    if (value.header.kind !== this.identity.kind || value.permissions.canRead.state !== 'allowed' ||
      (target.kind === 'message' && !value.history.messages.some(message => message.serverSeq === target.serverSeq)) ||
      (value.target.kind === 'empty' && value.history.messages.length !== 0)) throw invalid();
    if (value.contextPages !== undefined && !Array.isArray(value.contextPages)) throw invalid();
    const context: readonly ConversationPageResult[] = value.contextPages ?? [];
    if (context.length > 31) throw invalid();
    const firstUnread = target.kind === 'message' && target.reason === 'firstUnread';
    if (firstUnread && (value.reading.confirmedReadSeq.state !== 'known' ||
      target.serverSeq <= value.reading.confirmedReadSeq.value || value.reading.firstUnreadTarget !== target.serverSeq)) throw invalid();
    const resumeUnknown = this.#resume?.outgoing.some(row => row.operation.phase === 'unknown') === true;
    const resuming = target.kind === 'message' && target.reason === 'resume' && this.#resume?.anchor !== undefined;
    if (context.length && !firstUnread && !resuming) throw invalid();
    const pages = [value.history, ...context];
    for (const page of context) {
      this.#checkPage(page);
      if (page.range.snapshotUpperSeq.state !== 'known' || value.history.range.snapshotUpperSeq.state !== 'known' ||
        page.range.snapshotUpperSeq.value !== value.history.range.snapshotUpperSeq.value || target.kind !== 'message') throw invalid();
      const previous = page.range.query.before !== undefined && page.range.query.before <= target.serverSeq &&
        page.messages.every(message => message.serverSeq < target.serverSeq);
      const following = page.range.query.since !== undefined && page.range.query.since > target.serverSeq &&
        page.messages.every(message => message.serverSeq <= target.serverSeq + Math.min(31, Number.MAX_SAFE_INTEGER - target.serverSeq));
      if (!previous && !following) throw invalid();
    }
    const earliestPage = pages.reduce((earliest, page) =>
      (page.range.query.before ?? Infinity) < (earliest.range.query.before ?? Infinity) ? page : earliest);
    if ((firstUnread || resuming) && new Set(pages.flatMap(page => page.messages.map(message => message.serverSeq))).size > 32) throw invalid();
    const ranges = Object.freeze(pages.flatMap(page => this.#pages(page)).map(page => copyRange(page.range)));
    for (const page of pages) this.#mergeMessages(page, operation);
    for (const event of operation.messages.values()) this.#acceptRaw(event.message, event.revision);
    this.#rebuild();
    const headerEvent = operation.header;
    const header = headerEvent && headerEvent.revision > value.revision ? copyHeader(headerEvent.header) : copyHeader(value.header);
    this.#headerRevision = Math.max(value.revision, headerEvent?.revision ?? -1);
    this.#restoreContinuation(); this.#confirmKnownOutgoing();
    const openingTarget = resuming ? Object.freeze({ ...value.target, offsetPx: value.target.kind === 'message' &&
      value.target.serverSeq === this.#scrollAnchor?.serverSeq ? this.#scrollAnchor.offsetPx : 0 }) : value.target;
    const ready: ConversationReadySnapshot = Object.freeze({ phase: 'ready', identity: this.identity, composer: this.#composer(), outgoing: this.#outgoing,
      search: closedSearch, maxDeleteAgeSeconds: value.maxDeleteAgeSeconds,
      header, permissions: copyPermissions(operation.permissions && operation.permissions.revision > value.revision ? operation.permissions.permissions : value.permissions), messages: sortConversationMessages([...this.#messages.values()]),
      history: Object.freeze({ ranges, older: earliestPage.range.older, newer: ranges[1]?.newer ?? ranges[0].newer }), older: idle, newer: idle, gaps: this.#gaps(), position: this.#position(),
      reading: this.#reading(value.reading), receipts: Object.freeze([...this.#receipts.values()]), target: this.#projectTarget(openingTarget) });
    this.#finish(operation); this.#ready = ready; this.#publishReady({});
    if (resumeUnknown && this.#composer().uncertain) queueMicrotask(() => { if (this.#snapshot.phase === 'ready') void this.reconcileText(); });
  }
  #restoreContinuation(): void {
    const resume = this.#resume;
    if (!resume) return;
    this.#resume = undefined;
    this.#draft = resume.draft; this.#draftRevision++; this.#draftDirty = resume.draftDirty === true;
    this.#scrollAnchor = resume.anchor;
    this.#edit = resume.edit;
    for (const row of resume.outgoing) {
      const previous = row.operation;
      if (previous.phase === 'confirmed' || previous.phase === 'cancelled' ||
        (previous.kind === 'edit' && (!this.#edit || previous.targetSeq !== this.#edit.serverSeq))) continue;
      const base = { identity: this.identity, revision: 0, operationId: previous.operationId, kind: previous.kind, targetSeq: previous.targetSeq,
        ...(previous.afterSeq === undefined ? {} : { afterSeq: previous.afterSeq }) };
      // Old wire request IDs/revisions never become pending requests in a new SDK.
      const operation: ConversationOutgoingOperation = Object.freeze(previous.phase === 'rejected'
        ? { ...base, phase: 'rejected', error: copyError(previous.error) }
        : previous.phase === 'preparing' ? { ...base, phase: 'rejected', error: Object.freeze({ area: 'send', kind: 'network',
            messageCode: previous.kind === 'edit' ? 'conversationEditRejected' : 'conversationSendRejected', retryable: true }) }
          : { ...base, phase: 'unknown', messageCode: 'conversationSendUnknown' });
      if (previous.kind === 'edit') this.#editOperationId = previous.operationId;
      this.#submissions.set(previous.operationId, { operationId: previous.operationId, operation,
        ...(row.text === undefined ? {} : { text: row.text }),
        ...(row.submittedDraftIds === undefined ? {} : { submittedDraftIds: row.submittedDraftIds }), ...(row.photo === undefined ? {} : { photo: row.photo }), ...(row.voice === undefined ? {} : { voice: row.voice }) });
    }
    this.#syncOutgoing(); this.#refreshEditTarget();
  }
  #pages(page: ConversationPageResult): readonly ConversationPageResult[] { return [page, ...(page.relatedPages ?? [])]; }
  #acceptRaw(message: ConversationMessage, revision: number): void {
    this.#highestReceived = Math.max(this.#highestReceived, message.serverSeq);
    this.#cover(message.serverSeq, message.serverSeq);
    if (conversationSeqDeleted(message.serverSeq, this.#deletion.ranges) ||
      (message.originalSeq !== undefined && conversationSeqDeleted(message.originalSeq, this.#deletion.ranges))) return;
    if (revision >= (this.#messageRevisions.get(message.serverSeq) ?? -1)) {
      this.#rawMessages.set(message.serverSeq, message); this.#messageRevisions.set(message.serverSeq, revision);
    }
  }
  #rebuild(): void {
    this.#messages = new Map(materializeConversationMessages(this.#rawMessages, this.#deletion.ranges).map(message => [message.serverSeq, message]));
    this.#refreshEditTarget();
  }
  #refreshEditTarget(): void {
    if (!this.#edit) return;
    if (conversationSeqDeleted(this.#edit.serverSeq, this.#deletion.ranges)) { this.#clearEdit(); return; }
    const target = this.#messages.get(this.#edit.serverSeq);
    if (target && this.#editOperationId && target.operationId === this.#editOperationId) return;
    if (!this.#edit.stale && (!target || !this.#matchesEdit(this.#edit, target))) this.#edit = Object.freeze({ ...this.#edit, stale: true });
  }
  #reading(value: ConversationReadingPosition): ConversationReadingPosition {
    let highest = Math.max(this.#highestReceived, value.highestReceivedSeq.state === 'known' ? value.highestReceivedSeq.value : 0);
    for (const seq of this.#rawMessages.keys()) highest = Math.max(highest, seq);
    if (value.confirmedReadSeq.state === 'known' && integer(value.confirmedReadSeq.value) &&
      (this.#confirmedRead.state !== 'known' || value.confirmedReadSeq.value > this.#confirmedRead.value)) this.#confirmedRead = copySeq(value.confirmedReadSeq);
    if (this.#confirmedRead.state === 'known' && this.#pendingRead <= this.#confirmedRead.value) this.#pendingRead = 0;
    return copyReading({ confirmedReadSeq: this.#confirmedRead,
      ...(this.#pendingRead ? { pendingReadSeq: this.#pendingRead } : {}),
      ...(value.firstUnreadTarget === undefined ? {} : { firstUnreadTarget: value.firstUnreadTarget }), highestReceivedSeq: highest ? { state: 'known', value: highest } : { state: 'unknown' } });
  }
  #projectTarget(target: ConversationOpeningTarget): ConversationOpeningTarget {
    if (target.kind === 'message' && target.reason === 'latest') {
      const last = [...this.#messages.values()].at(-1);
      return Object.freeze(last ? { kind: 'message', serverSeq: last.serverSeq, reason: 'latest' } : { kind: 'empty' });
    }
    if (target.kind === 'message') {
      const raw = this.#rawMessages.get(target.serverSeq);
      const seq = raw?.originalSeq ?? target.serverSeq;
      const original = this.#rawMessages.get(seq);
      if (this.#messages.has(seq) && (raw?.originalSeq === undefined || (original?.sender.uid && raw.sender.uid === original.sender.uid))) {
        return Object.freeze({ kind: 'message', serverSeq: seq, reason: target.reason,
          ...(target.reason === 'resume' && Number.isFinite(target.offsetPx) ? { offsetPx: target.offsetPx } : {}) });
      }
      const values = [...this.#messages.values()];
      const prior = target.reason === 'lastRead' ? values.filter(message => message.serverSeq <= target.serverSeq).at(-1) : undefined;
      const next = prior ?? values.find(message => message.serverSeq >= target.serverSeq) ?? values.at(-1);
      if (next) return Object.freeze({ kind: 'message', serverSeq: next.serverSeq, reason: target.reason });
    } else {
      const last = [...this.#messages.values()].at(-1);
      if (last) return Object.freeze({ kind: 'message', serverSeq: last.serverSeq, reason: 'latest' });
    }
    return Object.freeze({ kind: 'empty' });
  }
  #mergeMessages(page: ConversationPageResult, operation: Operation): void {
    // Validate each related response separately. Count still measures raw data packets.
    for (const part of this.#pages(page)) {
      this.#latestKnown = Math.max(this.#latestKnown, part.range.snapshotUpperSeq.state === 'known' ? part.range.snapshotUpperSeq.value : 0);
      for (const seq of part.range.receivedSeq) { this.#highestReceived = Math.max(this.#highestReceived, seq); this.#cover(seq, seq); }
      // Min, max, and count below the limit do not establish that the gap is covered.
      if (part.range.coverage === 'complete' && part.range.snapshotUpperSeq.state === 'known') {
        const high = Math.min(part.range.snapshotUpperSeq.value, part.range.query.before === undefined ? Number.MAX_SAFE_INTEGER : part.range.query.before - 1);
        this.#cover(part.range.query.since ?? 1, high);
      }
    }
    const copied = this.#pages(page).flatMap(part => part.messages.map(value => {
      const event = operation.messages.get(value.serverSeq);
      return { message: copyMessage(event && event.revision > part.revision ? event.message : value),
        revision: Math.max(part.revision, event?.revision ?? -1) };
    }));
    for (const { message, revision } of copied) this.#acceptRaw(message, revision);
    this.#rebuild(); this.#confirmKnownOutgoing();
  }
  #onEvent(port: ConversationPort, event: ConversationReadEvent): void {
    if (!this.#canRun() || this.#port !== port) return;
    try {
      this.#checkContext(event);
      if (event.kind === 'outgoingUpdated') { this.#acceptOutgoing(event.operation); return; }
      if (event.kind === 'closed') { void this.suspend(); return; }
      if (event.kind === 'unavailable') { void this.suspend(copyError(event.error)); return; }
      if (event.kind === 'readUpdated') {
        const value = event.confirmedReadSeq;
        if (value.state !== 'known' || !integer(value.value)) return;
        if (this.#confirmedRead.state !== 'known' || value.value > this.#confirmedRead.value) this.#confirmedRead = copySeq(value);
        if (this.#pendingRead <= value.value) this.#pendingRead = 0;
        if (this.#ready) this.#publishReady({ reading: this.#reading(this.#ready.reading) });
        return;
      }
      if (event.kind === 'readPending') {
        if (!integer(event.serverSeq, 1) || event.serverSeq <= (this.#confirmedRead.state === 'known' ? this.#confirmedRead.value : 0)) return;
        this.#pendingRead = Math.max(this.#pendingRead, event.serverSeq);
        if (this.#ready) this.#publishReady({ reading: this.#reading(this.#ready.reading) });
        return;
      }
      if (event.kind === 'receiptUpdated') {
        if (!/^usr[A-Za-z0-9_-]+$/.test(event.uid) || !integer(event.serverSeq) || (event.receipt !== 'read' && event.receipt !== 'recv')) return;
        const previous = this.#receipts.get(event.uid);
        if (!previous && this.#receipts.size >= 4096) return;
        const read = Math.max(previous?.readSeq.state === 'known' ? previous.readSeq.value : 0, event.receipt === 'read' ? event.serverSeq : 0);
        const received = Math.max(read, previous?.receivedSeq.state === 'known' ? previous.receivedSeq.value : 0, event.serverSeq);
        const readKnown = event.receipt === 'read' || previous?.readSeq.state === 'known';
        if (previous?.receivedSeq.state === 'known' && previous.receivedSeq.value === received &&
          (readKnown ? previous.readSeq.state === 'known' && previous.readSeq.value === read : previous.readSeq.state === 'unknown')) return;
        this.#receipts.set(event.uid, Object.freeze({ uid: event.uid,
          readSeq: readKnown ? Object.freeze({ state: 'known', value: read }) : Object.freeze({ state: 'unknown' }),
          receivedSeq: Object.freeze({ state: 'known', value: received }) }));
        if (this.#ready) this.#publishReady({ receipts: Object.freeze([...this.#receipts.values()]) });
        return;
      }
      if (event.kind === 'messagesDeleted') {
        if (!integer(event.deletion.transactionId)) return;
        this.#deletion = Object.freeze({ transactionId: Math.max(this.#deletion.transactionId, event.deletion.transactionId),
          ranges: mergeConversationDeletionRanges([...this.#deletion.ranges, ...event.deletion.ranges]) });
        for (const [seq, message] of this.#rawMessages) if (conversationSeqDeleted(seq, this.#deletion.ranges) ||
          (message.originalSeq !== undefined && conversationSeqDeleted(message.originalSeq, this.#deletion.ranges))) this.#rawMessages.delete(seq);
        this.#rebuild();
        if (this.#ready) this.#publishReady({ messages: sortConversationMessages([...this.#messages.values()]), target: this.#projectTarget(this.#ready.target) });
        return;
      }
      if (event.kind === 'permissionsChanged') {
        const permissions = copyPermissions(event.permissions);
        if (permissions.canRead.state === 'denied') {
          void this.suspend({ area: 'history', kind: 'permission', messageCode: 'conversationReadDenied', retryable: false }); return;
        }
        if (this.#operation && event.revision > (this.#operation.permissions?.revision ?? -1)) this.#operation.permissions = Object.freeze({ ...event, permissions });
        if (event.revision > this.#permissionsRevision) {
          this.#permissionsRevision = event.revision;
          this.#publishReady({ permissions });
          if (permissions.canWrite.state !== 'allowed') this.#photoBatch?.abort();
        }
        return;
      }
      if (event.kind === 'metadataUpdated') {
        if (event.header.kind !== this.identity.kind) return;
        const header = copyHeader(event.header);
        if (this.#operation && event.revision > (this.#operation.header?.revision ?? -1)) this.#operation.header = Object.freeze({
          kind: 'metadataUpdated', identity: this.identity, revision: event.revision, header });
        if (this.#ready && event.revision > this.#headerRevision) {
          this.#headerRevision = event.revision; this.#publishReady({ header });
        }
      } else if (event.kind === 'messageUpsert') {
        const message = copyMessage(event.message);
        if (message.serverSeq - this.#latestKnown > 1) this.#atLatest = false;
        this.#latestKnown = Math.max(this.#latestKnown, message.serverSeq);
        if (this.#operation && event.revision > (this.#operation.messages.get(event.message.serverSeq)?.revision ?? -1)) {
          // Keep raw packets and objects owned by other operations out of this buffer.
          this.#operation.messages.set(event.message.serverSeq, Object.freeze({ kind: 'messageUpsert', identity: this.identity, revision: event.revision, message }));
        }
        this.#acceptRaw(message, event.revision); this.#rebuild(); this.#confirmKnownOutgoing();
        if (this.#ready) this.#publishReady({ messages: sortConversationMessages([...this.#messages.values()]), reading: this.#reading(this.#ready.reading) });
      }
    } catch { /* Malformed or unrelated events leave the confirmed snapshot intact. */ }
  }
  #position(): ConversationReadySnapshot['position'] {
    const read = Math.max(this.#confirmedRead.state === 'known' ? this.#confirmedRead.value : 0, this.#pendingRead);
    const count = Math.max(0, this.#latestKnown - read);
    return Object.freeze({ atLatest: this.#atLatest, newMessageCount: count, scrollRequest: Object.freeze({ id: this.#scrollRevision, target: this.#scrollTarget }) });
  }
  #cover(low: number, high: number): void {
    if (!integer(low, 1) || !integer(high, 1) || high < low) return;
    const next = [...this.#coverage, { low, high }].sort((a, b) => a.low - b.low);
    const merged: { low: number; high: number }[] = [];
    for (const range of next) {
      const previous = merged.at(-1);
      if (previous && range.low - previous.high <= 1) previous.high = Math.max(previous.high, range.high);
      else merged.push({ ...range });
    }
    this.#coverage = merged;
  }
  #gaps(): readonly ConversationHistoryGap[] {
    const gaps: ConversationHistoryGap[] = [], rows = [...this.#messages.keys()].sort((a, b) => a - b);
    const add = (since: number, before?: number) => {
      const beforeMessageSeq = before === undefined ? undefined : rows.find(seq => seq >= before);
      gaps.push(Object.freeze({ query: Object.freeze({ since, ...(before === undefined ? {} : { before }), limit: 32 }),
        ...(beforeMessageSeq === undefined ? {} : { beforeMessageSeq }) }));
    };
    const start = this.#coverage[0]?.low;
    if (start === undefined || start > this.#latestKnown) return [];
    // Deletion ranges close holes inside the loaded window without starting an older window.
    const deleted = this.#deletion.ranges.map(range => ({ low: range.low, high: range.hi === undefined ? range.low : range.hi - 1 }));
    const coverage = [...this.#coverage, ...deleted].sort((a, b) => a.low - b.low);
    let end = start - 1;
    for (const range of coverage) {
      if (range.high < start) continue;
      if (range.low > this.#latestKnown) break;
      if (range.low - end > 1) add(end + 1, range.low);
      end = Math.max(end, Math.min(range.high, this.#latestKnown));
    }
    if (end < this.#latestKnown) add(end + 1, this.#latestKnown < Number.MAX_SAFE_INTEGER ? this.#latestKnown + 1 : undefined);
    return Object.freeze(gaps);
  }
  #publishReady(patch: Partial<Omit<ConversationReadySnapshot, 'phase' | 'identity'>>): void {
    if (!this.#ready) return;
    const previous = this.#ready.search;
    const search = patch.search ?? (patch.messages && previous.state !== 'closed'
      ? this.#searchFor(previous.query, patch.messages, previous) : previous);
    const next = { ...this.#ready, ...patch };
    const older = next.history.older;
    const deletedPrefix = this.#deletion.ranges[0];
    // The merged journal starts at 1 only when it covers the beginning of the chat.
    if (older.state === 'more' && older.query.before !== undefined && deletedPrefix?.low === 1 &&
      (deletedPrefix.hi ?? deletedPrefix.low + 1) >= older.query.before) {
      next.history = Object.freeze({ ...next.history, older: { state: 'end' } as const });
      next.older = idle;
    }
    const ready = Object.freeze({ ...next, search,
      composer: this.#composer(), outgoing: this.#outgoing, gaps: this.#gaps(), position: this.#position() });
    this.#ready = ready; this.#publish(ready);
  }
  #publish(snapshot: ConversationSnapshot): void {
    this.#snapshot = snapshot;
    this.#notifyContinuation();
    for (const listener of [...this.#listeners]) {
      try { listener(); } catch { console.error('Conversation controller subscriber notification failed.'); }
    }
  }
  #canRun(): boolean {
    return this.#snapshot.phase !== 'closed' && this.#snapshot.phase !== 'suspended' && (!this.#managed || this.#owners > 0);
  }
  #current(operation: Operation): boolean { return this.#canRun() && this.#operation === operation && !operation.abort.signal.aborted; }
  #finish(operation: Operation): void { if (this.#operation === operation) this.#operation = undefined; operation.resolve(); }
  #cancel(): void {
    const operation = this.#operation; this.#operation = undefined;
    operation?.abort.abort(); operation?.resolve();
  }
  #detachCurrent(): void {
    const detach = this.#detachPort, port = this.#port;
    this.#detachPort = () => {}; this.#port = undefined;
    try { detach(); } catch { /* The retired port can no longer publish events. */ } finally { if (port) this.#retire(port); }
  }
  #retire(port: ConversationPort): void {
    if (this.#retired.has(port)) return;
    this.#retired.add(port);
    this.#cleanup = this.#cleanup.then(async () => {
      try {
        const result = await port.close();
        if (!sameIdentity(result.identity, this.identity)) throw invalid();
        const copied: ConversationCloseResult = Object.freeze(result.state === 'blocked'
          ? { identity: this.identity, state: 'blocked', error: Object.freeze({ ...copyError(result.error), retryable: false }) }
          : { identity: this.identity, state: 'detached' });
        if (this.#closeResult?.state !== 'blocked') this.#closeResult = copied;
        if (copied.state === 'blocked') this.#blockedError = copied.error;
      } catch {
        this.#blockedError = Object.freeze({ area: 'history', kind: 'timeout', messageCode: 'conversationAttachUnconfirmed', retryable: false });
        this.#closeResult = Object.freeze({ identity: this.identity, state: 'blocked', error: this.#blockedError });
      } finally {
        try { port.dispose(); } catch { /* The close result is already known. The controller does not own the SDK. */ }
      }
      if (this.#snapshot.phase === 'error' && this.#blockedError && !this.#operation) {
        this.#publish(Object.freeze({ phase: 'error', identity: this.identity, error: this.#blockedError }));
      }
    });
  }
  #clear(): void {
    this.#deleting?.abort(); this.#deleting = undefined;
    this.#voiceLifetime.abort(); this.#voiceLifetime = new AbortController();
    this.#localVoiceResources.dispose(); this.#localVoiceResources = new MediaResources();
    for (const id of this.#voiceFiles.keys()) this.#dropVoice(id);

    const reconcile = this.#reconcile; this.#reconcile = undefined; reconcile?.abort.abort(); reconcile?.resolve(); this.#verification = undefined;
    const submission = this.#submission; this.#submission = undefined; submission?.abort.abort(); submission?.resolve();
    this.#photoBatch?.abort(); this.#photoBatch = undefined;
    for (const owned of this.#localPhotoPreviews.values()) for (const preview of owned) URL.revokeObjectURL(preview);
    this.#localPhotoPreviews.clear();
    for (const read of this.#photoReads) read.abort();
    this.#photoReads.clear();
    this.#edit = undefined; this.#editOperationId = undefined; this.#draft = ''; this.#draftRevision = 0; this.#draftDirty = false;
    this.#storedDraftId = undefined; this.#draftSave = undefined; this.#composerError = undefined; this.#submissions.clear(); this.#outgoing = Object.freeze([]);
    this.#scrollAnchor = undefined; this.#searchIndex = undefined;
    this.#ready = undefined; this.#messages.clear(); this.#rawMessages.clear(); this.#messageRevisions.clear(); this.#headerRevision = -1;
    this.#deletion = { transactionId: 0, ranges: [] }; this.#permissionsRevision = -1; this.#highestReceived = 0;
    this.#snapshotUpper = undefined; this.#openingUpper = 0; this.#latestKnown = 0; this.#coverage = []; this.#atLatest = false; this.#atEnd = false; this.#scrollRevision = 0; this.#scrollTarget = 'latest';
    this.#confirmedRead = { state: 'unknown' }; this.#pendingRead = 0; this.#receipts.clear(); this.#viewportActive = false;
  }
  // Continuation captures the small live state before this generation is cleared.
  suspend(reason: ConversationError = sessionError()): Promise<void> {
    if (this.#snapshot.phase === 'closed') return this.#closePromise?.then(() => {}) ?? this.#cleanup;
    if (this.#suspendPromise) return this.#suspendPromise;
    this.#suspendPromise = Promise.resolve().then(async () => {
      await Promise.allSettled([...this.#works]); await this.#cleanup;
    });
    this.#notifyContinuation(); this.#cancel(); this.#detachCurrent(); this.#clear();
    this.#resume = undefined;
    this.#publish(Object.freeze({ phase: 'suspended', identity: this.identity, error: copyError(reason) }));
    return this.#suspendPromise;
  }
  close(): Promise<ConversationCloseResult | undefined> {
    if (this.#closePromise) return this.#closePromise;
    this.#closePromise = Promise.resolve().then(async () => {
      await Promise.allSettled([...this.#works]); await this.#cleanup; return this.#closeResult;
    });
    this.#notifyContinuation(); this.#cancel(); this.#detachCurrent(); this.#clear(); this.#resume = undefined; activeControllers.delete(this);
    this.#publish(Object.freeze({ phase: 'closed', identity: this.identity })); this.#listeners.clear(); this.#continuationListeners.clear();
    return this.#closePromise;
  }
  dispose(): void { void this.close(); }
}
if (import.meta.hot) import.meta.hot.dispose(() => { for (const controller of activeControllers) controller.dispose(); });
