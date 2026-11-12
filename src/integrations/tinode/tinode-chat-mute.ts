import { chatInfoPushWant } from '../../chat-info/chat-info-normalize';
import type { ChatInfoMuteState, ChatInfoPermissions } from '../../chat-info/chat-info-types';
import type { ChatMuteErrorCode } from '../../chats/chat-list-types';
import type { TinodeMetadataWriteResult } from './TinodeSessionScope';

interface OwnState {
  readonly permissions: ChatInfoPermissions;
  readonly mute: ChatInfoMuteState;
}
type VerifiedOwnState = { readonly permissions: ChatInfoPermissions; readonly mute: Extract<ChatInfoMuteState, { state: 'confirmed' }> };

export type TinodeMuteOutcome =
  | ({ readonly state: 'confirmed' } & VerifiedOwnState)
  | { readonly state: 'failed' | 'reconciling'; readonly messageCode: ChatMuteErrorCode; readonly serverCode?: number };

interface MuteOptions {
  readonly topic: string;
  readonly target: boolean;
  readonly read: () => Promise<OwnState>;
  readonly write: (want: string, enabled: boolean) => Promise<TinodeMetadataWriteResult>;
  readonly report: (mode?: string) => void;
  readonly assertActive: () => void;
}

export async function changeTinodeChatMute({ topic, target, read, write, report, assertActive }: MuteOptions): Promise<TinodeMuteOutcome> {
  let reconcile = false;
  let confirmedMode: string | undefined;
  try {
    assertActive();
    const own = await read();
    assertActive();
    const access = own.permissions.ownAccess;
    if (access.state !== 'known' || own.mute.state !== 'confirmed') {
      return { state: 'failed', messageCode: 'chatInfoMuteUnavailable' };
    }
    if (own.permissions.canChangeMute.state !== 'allowed') return { state: 'failed', messageCode: 'chatInfoMuteDenied' };

    // Retries always start with a fresh read: the earlier write may already have applied.
    const want = chatInfoPushWant(access.want, !target);
    if (want === access.want && own.mute.muted === target) {
      confirmedMode = access.mode;
      return { state: 'confirmed', permissions: own.permissions, mute: own.mute };
    }
    reconcile = true;
    const result = await write(access.want, !target);
    assertActive();
    if (result.state === 'rejected') {
      reconcile = false;
      return { state: 'failed', messageCode: 'chatInfoMuteFailed', serverCode: result.serverCode };
    }
    const verified = await read();
    assertActive();
    const updated = verified.permissions.ownAccess;
    if (updated.state === 'known' && verified.mute.state === 'confirmed') {
      if (updated.want === want && verified.mute.muted === target) {
        confirmedMode = updated.mode;
        return { state: 'confirmed', permissions: verified.permissions, mute: verified.mute };
      }
      if (verified.permissions.canChangeMute.state !== 'allowed') return { state: 'failed', messageCode: 'chatInfoMuteDenied' };
      if (result.state === 'acknowledged') {
        return { state: 'failed', messageCode: topic.startsWith('chn') ? 'chatInfoChannelMuteNotSaved' : 'chatInfoMuteFailed' };
      }
    }
    return { state: 'reconciling', messageCode: 'chatInfoMuteUnknown' };
  } catch {
    assertActive();
    return reconcile ? { state: 'reconciling', messageCode: 'chatInfoMuteUnknown' }
      : { state: 'failed', messageCode: 'chatInfoMuteUnavailable' };
  } finally {
    if (reconcile || confirmedMode !== undefined) report(confirmedMode);
  }
}
