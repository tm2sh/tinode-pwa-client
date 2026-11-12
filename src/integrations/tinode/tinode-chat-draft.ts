import { conversationDraftByteLimit, isConversationDraftId, normalizeConversationDraft } from '../../conversation/ConversationDraft';
import type { ConversationDraft } from '../../conversation/ConversationDraft';

const headKey = 'x-tinode-pwa-client-draft';
const bodyPrefix = headKey + '-body-';
const removeValue = '␡';
export const maxDraftCleanup = 32;

export function projectOwnDraft(privateValue: unknown) {
  if (!privateValue || typeof privateValue !== 'object' || Array.isArray(privateValue)) return {};
  const fields = privateValue as Record<string, unknown>;
  const id = fields[headKey];
  let draft: ConversationDraft | undefined;
  if (isConversationDraftId(id)) {
    const stored = fields[bodyPrefix + id];
    if (typeof stored === 'string' && stored.length <= conversationDraftByteLimit * 6 + 2) {
      try { draft = normalizeConversationDraft({ id, text: JSON.parse(stored) }); }
      catch { /* Invalid data from another client is ignored. */ }
    }
  }
  const draftIds: string[] = [];
  for (const key of Object.keys(fields)) {
    if (!key.startsWith(bodyPrefix)) continue;
    const version = key.slice(bodyPrefix.length);
    if (isConversationDraftId(version) && version !== id) draftIds.push(version);
    if (draftIds.length === maxDraftCleanup) break;
  }
  return {
    ...(draft === undefined ? {} : { draft: Object.freeze({ ...draft }) }),
    ...(draftIds.length === 0 ? {} : { draftIds: Object.freeze(draftIds) }),
  };
}

export function draftPrivatePatch(draft: ConversationDraft | undefined, updateHead: boolean, removeIds: readonly string[]) {
  const patch: Record<string, string> = {};
  for (const id of removeIds) {
    if (isConversationDraftId(id) && id !== draft?.id) patch[bodyPrefix + id] = removeValue;
  }
  if (updateHead) {
    patch[headKey] = draft?.id ?? removeValue;
    if (draft) patch[bodyPrefix + draft.id] = JSON.stringify(draft.text);
  }
  return patch;
}
