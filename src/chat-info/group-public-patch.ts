export const maxGroupAvatarBytes = 32 * 1024;
const deleteField = '␡' as const;

export interface GroupPublicPatch {
  readonly fn?: string;
  readonly photo?: { readonly type: 'jpeg' | 'png'; readonly data: string };
}

export function groupPublicSetParams(patch: GroupPublicPatch) {
  return { desc: { public: {
    ...(patch.fn === undefined ? {} : { fn: patch.fn }),
    ...(patch.photo === undefined ? {} : { photo: { type: patch.photo.type, data: patch.photo.data, ref: deleteField } }),
  } } };
}

export function groupPublicSetBytes(topic: string, params: ReturnType<typeof groupPublicSetParams>): number {
  // Reserve a full safe-integer ID for the SDK's monotonically increasing counter.
  const packet = { set: { id: String(Number.MAX_SAFE_INTEGER), topic, ...params } };
  return new TextEncoder().encode(JSON.stringify(packet)).byteLength;
}

export function isGroupTitle(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value !== deleteField &&
    value === value.trim() && !/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(value);
}
