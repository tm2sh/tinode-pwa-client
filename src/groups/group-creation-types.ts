import type { AccountScope } from '../chats/chat-list-types';
import type { PreparedAvatar } from '../media/AvatarPreparation';
import type { ServerLimit } from '../media/MediaResources';

export type GroupCreationKind = 'group' | 'channel';

export interface GroupCreationInput {
  readonly kind: GroupCreationKind;
  readonly title: string;
  readonly avatar?: PreparedAvatar;
  readonly participants: readonly string[];
}

export interface GroupInviteIssue {
  readonly userId: string;
  readonly state: 'rejected' | 'unknown';
}

export type GroupCreationResult =
  | { readonly state: 'rejected'; readonly reason: 'invalid' | 'tooLarge' | 'denied' | 'limit' | 'unavailable' }
  | { readonly state: 'unconfirmed'; readonly kind: GroupCreationKind; readonly operationId: string; readonly knownGroups: readonly string[] }
  | { readonly state: 'created'; readonly kind: GroupCreationKind; readonly topicKey: string; readonly issues: readonly GroupInviteIssue[]; readonly attachmentUncertain?: boolean };

export type GroupCreationProgress = Exclude<GroupCreationResult, { state: 'rejected' }>;

export interface GroupCreationPort {
  readonly account: AccountScope;
  readonly maxMessageSize: ServerLimit;
  readonly subscriberLimit?: number;
  run(input: GroupCreationInput, previous: GroupCreationProgress | undefined, signal: AbortSignal, knownGroups: readonly string[]): Promise<GroupCreationResult>;
}

export type OpenGroupCreationPort = () => Promise<GroupCreationPort>;
