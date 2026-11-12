export interface ConversationDraft {
  readonly id: string;
  readonly text: string;
}

export interface ConversationDraftPort {
  readonly initial?: ConversationDraft;
  load(): Promise<ConversationDraft | undefined>;
  save(draft: ConversationDraft | undefined): Promise<void>;
  clear(ids: readonly string[]): Promise<void>;
}

export const conversationDraftByteLimit = 16 * 1024;
export const isConversationDraftId = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);

export function normalizeConversationDraft(value: unknown): ConversationDraft | undefined {
  if (!value || typeof value !== 'object' || !('id' in value) || !('text' in value)) return;
  const { id, text } = value;
  if (!isConversationDraftId(id) || typeof text !== 'string' || text.length > conversationDraftByteLimit ||
    !text.trim() || new TextEncoder().encode(text).length > conversationDraftByteLimit) return;
  return Object.freeze({ id, text });
}
