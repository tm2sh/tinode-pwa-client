import type { AvatarImageSource } from '../../chats/chat-list-types';
import { normalizeOwnProfile } from '../../chats/chat-list-normalize';
import { isProfileName, maxOwnAvatarBytes, unmatchedOwnProfileFields } from '../../profile/own-profile-patch';
import type { OwnProfilePublicPatch } from '../../profile/own-profile-patch';
import type { ConfirmedOwnProfile, OwnProfilePatch, OwnProfilePort, OwnProfileSaveResult } from '../../profile/own-profile-types';
import { TinodeSessionFailure } from './TinodeSessionScope';
import type { TinodeSessionScope } from './TinodeSessionScope';

type Rejection = Extract<OwnProfileSaveResult, { state: 'rejected' }>['reason'];
const unknown = Object.freeze({ state: 'unknown' } as const);

function reject(reason: Rejection): OwnProfileSaveResult {
  return Object.freeze({ state: 'rejected', reason });
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rejectedByServer(code?: number): OwnProfileSaveResult {
  return reject(code === 401 || code === 403 ? 'permission' : code === 413 ? 'tooLarge' : 'server');
}

function hasChanges(patch: OwnProfilePublicPatch): boolean {
  return patch.fn !== undefined || patch.photo !== undefined;
}

async function preparePatch(input: OwnProfilePatch): Promise<OwnProfilePublicPatch> {
  const invalid = () => new TinodeSessionFailure('invalidResponse');
  if (!record(input) || Object.keys(input).some(key => key !== 'displayName' && key !== 'avatar') ||
    (input.displayName === undefined && input.avatar === undefined)) throw invalid();
  const fn = typeof input.displayName === 'string' ? input.displayName.trim() : undefined;
  if (input.displayName !== undefined && !isProfileName(fn)) throw invalid();
  const avatar = input.avatar;
  if (avatar === undefined) return { fn };
  if (!record(avatar)) throw invalid();
  if (avatar.kind === 'remove') {
    if (Object.keys(avatar).some(key => key !== 'kind')) throw invalid();
    return { fn, photo: 'remove' };
  }
  if (avatar.kind !== 'replace' || !record(avatar.prepared) ||
    Object.keys(avatar).some(key => key !== 'kind' && key !== 'prepared')) throw invalid();
  const { blob, edge, photoType } = avatar.prepared;
  if (!(blob instanceof Blob) || blob.size === 0 ||
    typeof edge !== 'number' || !Number.isSafeInteger(edge) || edge < 1 || edge > 512 ||
    (photoType !== 'png' && photoType !== 'jpeg') || blob.type !== 'image/' + photoType) throw invalid();
  if (blob.size > maxOwnAvatarBytes) throw new TinodeSessionFailure('tooLarge');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const signature = photoType === 'png' ? [137, 80, 78, 71, 13, 10, 26, 10] : [255, 216, 255];
  if (!signature.every((byte, index) => bytes[index] === byte)) throw invalid();
  return { fn, photo: { type: photoType, data: btoa(String.fromCharCode(...bytes)) } };
}

export class TinodeProfileAdapter implements OwnProfilePort {
  #scope: TinodeSessionScope;
  #busy = false;
  #pending: OwnProfilePublicPatch | undefined;

  constructor(scope: TinodeSessionScope) { this.#scope = scope; }

  get account() { return this.#scope.account; }
  get maxMessageSize() { return this.#scope.mediaLimits().maxMessageSize; }

  save(patch: OwnProfilePatch, signal: AbortSignal): Promise<OwnProfileSaveResult> {
    return this.#run(signal, () => this.#save(patch, signal));
  }

  checkSave(signal: AbortSignal): Promise<OwnProfileSaveResult> {
    return this.#run(signal, async () => {
      const desired = this.#pending;
      if (!desired) return reject('invalid');
      const result = await this.#read(signal);
      return hasChanges(unmatchedOwnProfileFields(result.card, desired)) ? unknown : this.#confirm(result.profile, desired.photo);
    });
  }

  async #save(input: OwnProfilePatch, signal: AbortSignal): Promise<OwnProfileSaveResult> {
    if (this.#pending) return unknown;
    const desired = await preparePatch(input);
    const before = await this.#read(signal);
    const changes = unmatchedOwnProfileFields(before.card, desired);
    if (!hasChanges(changes)) return this.#confirm(before.profile, desired.photo);

    const write = await this.#scope.writeOwnProfile(changes, signal);
    if (write.state === 'rejected') return rejectedByServer(write.serverCode);
    this.#pending = desired;
    const after = await this.#read(signal);
    if (!hasChanges(unmatchedOwnProfileFields(after.card, desired))) return this.#confirm(after.profile, desired.photo);
    if (write.state === 'unknown') return unknown;
    this.#pending = undefined;
    return reject('server');
  }

  async #read(signal: AbortSignal): Promise<{ card: unknown; profile: ConfirmedOwnProfile }> {
    const response = await this.#scope.readOwnProfile(signal);
    if (typeof response.code === 'number' && response.code >= 400) {
      throw new TinodeSessionFailure('rejected', response.code);
    }
    const profile = normalizeOwnProfile(response);
    const card = record(response.desc) ? response.desc.public : undefined;
    if (profile.state !== 'available' || (card != null && !record(card))) {
      throw new TinodeSessionFailure('invalidResponse');
    }
    return { card, profile };
  }

  #confirm(profile: ConfirmedOwnProfile, photo: OwnProfilePublicPatch['photo']): OwnProfileSaveResult {
    this.#pending = undefined;
    if (photo && photo !== 'remove') {
      // The readback matched these exact prepared bytes and contained no old reference.
      const imageSource = ('data:image/' + photo.type + ';base64,' + photo.data) as AvatarImageSource;
      profile = Object.freeze({ ...profile, avatar: Object.freeze({ state: 'ready', imageSource }) });
    }
    return Object.freeze({ state: 'confirmed', account: this.account, profile });
  }

  #cancelled(signal: AbortSignal): OwnProfileSaveResult | undefined {
    if (!this.#scope.active) {
      this.#pending = undefined;
      return Object.freeze({ state: 'cancelled', reason: 'closed' });
    }
    if (signal.aborted) return Object.freeze({ state: 'cancelled', reason: 'aborted' });
    return undefined;
  }

  async #run(signal: AbortSignal, action: () => Promise<OwnProfileSaveResult>): Promise<OwnProfileSaveResult> {
    const cancelled = this.#cancelled(signal);
    if (cancelled) return cancelled;
    if (this.#busy) return reject('busy');
    this.#busy = true;
    try {
      const result = await action();
      return this.#cancelled(signal) ?? result;
    } catch (reason: unknown) {
      const cancelled = this.#cancelled(signal);
      if (cancelled) return cancelled;
      if (this.#pending) return unknown;
      if (reason instanceof TinodeSessionFailure) {
        if (reason.reason === 'invalidResponse') return reject('invalid');
        if (reason.reason === 'tooLarge' || reason.reason === 'limitsUnavailable') return reject(reason.reason);
        return rejectedByServer(reason.code);
      }
      return reject('server');
    } finally { this.#busy = false; }
  }
}
