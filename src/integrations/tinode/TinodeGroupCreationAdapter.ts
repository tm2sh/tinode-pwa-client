import { isGroupTitle, maxGroupAvatarBytes } from '../../chat-info/group-public-patch';
import { groupCreationPacketBytes, groupCreationParams, groupTopicPattern, participantIdPattern } from '../../groups/group-creation-packet';
import type { GroupCreationInput, GroupCreationPort, GroupCreationProgress, GroupCreationResult, GroupInviteIssue } from '../../groups/group-creation-types';
import { TinodeSessionFailure } from './TinodeSessionScope';
import type { TinodeSessionScope } from './TinodeSessionScope';

type Created = Extract<GroupCreationResult, { state: 'created' }>;
type Attachment = 'confirmed' | 'possible' | 'detached';

function groupAttached(code: unknown): boolean {
  return code === 200 || code === 304;
}

function wasRejected(reason: unknown): boolean {
  return reason instanceof TinodeSessionFailure && reason.code !== undefined &&
    reason.code >= 400 && reason.code < 500 && reason.code !== 408 && reason.code !== 429;
}

export class TinodeGroupCreationAdapter implements GroupCreationPort {
  readonly #scope: TinodeSessionScope;
  #busy = false;

  readonly maxMessageSize;
  readonly subscriberLimit;

  constructor(scope: TinodeSessionScope) {
    this.#scope = scope;
    this.maxMessageSize = scope.mediaLimits().maxMessageSize;
    this.subscriberLimit = scope.subscriberLimit();
  }

  get account() { return this.#scope.account; }

  async run(input: GroupCreationInput, previous: GroupCreationProgress | undefined, signal: AbortSignal, knownGroups: readonly string[]): Promise<GroupCreationResult> {
    if (this.#busy || signal.aborted || !this.#scope.active) return previous ?? { state: 'rejected', reason: 'unavailable' };
    const { kind } = input;
    if (previous && previous.kind !== kind) return { state: 'rejected', reason: 'invalid' };
    this.#busy = true;
    try {
      if (previous?.state === 'created') return await this.#invite(previous, 'detached', signal);

      const participants = [...new Set(input.participants)];
      const issues = participants.map(userId => ({ userId, state: 'rejected' as const }));
      if (previous?.state === 'unconfirmed') {
        const topicKey = await this.#scope.findCreatedGroup(kind, previous.operationId, previous.knownGroups).catch(() => undefined);
        return topicKey ? await this.#invite({ state: 'created', kind, topicKey, issues }, 'possible', signal) : previous;
      }

      const title = input.title.trim();
      if (!isGroupTitle(title) || participants.some(id => !participantIdPattern.test(id) || id === this.account.uid)) {
        return { state: 'rejected', reason: 'invalid' };
      }
      const limit = this.subscriberLimit;
      if (limit !== undefined && participants.length + 1 > limit) return { state: 'rejected', reason: 'limit' };

      const avatar = input.avatar;
      let photo: { type: 'jpeg' | 'png'; data: string } | undefined;
      if (avatar) {
        const { blob, photoType } = avatar;
        if (!(blob instanceof Blob) || (photoType !== 'jpeg' && photoType !== 'png') ||
          blob.type !== 'image/' + photoType || blob.size === 0) return { state: 'rejected', reason: 'invalid' };
        if (blob.size > maxGroupAvatarBytes) return { state: 'rejected', reason: 'tooLarge' };
        const bytes = new Uint8Array(await blob.arrayBuffer());
        photo = { type: photoType, data: btoa(String.fromCharCode(...bytes)) };
      }
      const operationId = crypto.randomUUID();
      const params = groupCreationParams(title, operationId, photo);
      const maxMessageSize = this.maxMessageSize;
      if (maxMessageSize.state === 'known' && groupCreationPacketBytes(params, kind) > maxMessageSize.value) {
        return { state: 'rejected', reason: 'tooLarge' };
      }
      if (signal.aborted) return { state: 'rejected', reason: 'unavailable' };
      const reply = await this.#scope.createGroup(kind, params);
      if (reply.state === 'created') {
        return await this.#invite({ state: 'created', kind, topicKey: reply.topicKey, issues }, 'confirmed', signal);
      }
      if (reply.state === 'rejected') return { state: 'rejected', reason: reply.code === 413 ? 'tooLarge' : 'denied' };

      const topicKey = await this.#scope.findCreatedGroup(kind, operationId, knownGroups).catch(() => undefined);
      return topicKey ? await this.#invite({ state: 'created', kind, topicKey, issues }, 'possible', signal)
        : { state: 'unconfirmed', kind, operationId, knownGroups };
    } finally { this.#busy = false; }
  }

  async #invite(group: Created, attachment: Attachment, signal: AbortSignal): Promise<Created> {
    const { topicKey, kind } = group;
    if (!this.#scope.active || !groupTopicPattern.test(topicKey)) return { ...group, attachmentUncertain: true };
    const interest = this.#scope.topicInterest(topicKey, 'conversation');
    const issues: GroupInviteIssue[] = [];
    let attachmentUncertain = false;
    try {
      if (await interest.acquire()) {
        if (attachment === 'possible' && !groupAttached((await this.#scope.leave(topicKey)).code)) {
          throw new TinodeSessionFailure('invalidResponse');
        }
        if (attachment !== 'confirmed' && !groupAttached((await this.#scope.subscribe(topicKey)).code)) {
          throw new TinodeSessionFailure('invalidResponse');
        }
        interest.attached();
      }
      for (const issue of group.issues) {
        if (signal.aborted || !this.#scope.active) { issues.push(issue); continue; }
        if (issue.state === 'unknown') {
          try { if (await this.#scope.hasGroupMember(topicKey, issue.userId, kind)) continue; }
          catch { issues.push(issue); continue; }
        }
        if (signal.aborted) { issues.push(issue); continue; }
        try { await this.#scope.inviteGroupUser(topicKey, issue.userId, kind); }
        catch (reason: unknown) { issues.push({ userId: issue.userId, state: wasRejected(reason) ? 'rejected' : 'unknown' }); }
      }
    } catch {
      issues.push(...group.issues);
      attachmentUncertain = true;
    } finally {
      if (interest.release()) {
        let detached = false;
        try {
          if (this.#scope.active) detached = groupAttached((await this.#scope.leave(topicKey)).code);
        } catch {
          // Keep the topic reserved until the current connection is replaced.
        } finally { interest.detached(detached); }
        attachmentUncertain = !detached;
      }
    }
    return { ...group, issues, attachmentUncertain };
  }
}
