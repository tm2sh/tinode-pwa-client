export const maxOwnAvatarBytes = 32 * 1024;
const deleteField = '␡' as const;

export interface OwnProfilePublicPatch {
  readonly fn?: string;
  readonly photo?: { readonly type: 'jpeg' | 'png'; readonly data: string } | 'remove';
}

export function isProfileName(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value !== deleteField &&
    value === value.trim() && !/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(value);
}

export function ownProfileSetParams({ fn, photo }: OwnProfilePublicPatch) {
  return { desc: { public: {
    ...(fn === undefined ? {} : { fn }),
    ...(photo === undefined ? {} : { photo: photo === 'remove' ? deleteField :
      { type: photo.type, data: photo.data, ref: deleteField } }),
  } } };
}

export function ownProfileSetBytes(params: ReturnType<typeof ownProfileSetParams>): number {
  // SDK generates the request ID. Reserve enough space for its full integer counter.
  return new TextEncoder().encode(JSON.stringify({ set: {
    id: String(Number.MAX_SAFE_INTEGER), topic: 'me', ...params,
  } })).byteLength;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function unmatchedOwnProfileFields(profile: unknown, desired: OwnProfilePublicPatch): OwnProfilePublicPatch {
  const current = record(profile) ? profile : undefined;
  const actual = current?.photo;
  const wanted = desired.photo;
  const absent = actual === undefined || actual === null || actual === deleteField;
  const noRef = record(actual) &&
    (actual.ref === undefined || actual.ref === null || actual.ref === '' || actual.ref === deleteField);
  const actualType = record(actual) && typeof actual.type === 'string'
    ? actual.type.toLowerCase().replace(/^image\//, '').replace(/^jpg$/, 'jpeg')
    : record(actual) && actual.type == null ? 'jpeg' : undefined;
  const samePhoto = wanted === 'remove' ? absent : wanted !== undefined &&
    record(actual) && noRef && actualType === wanted.type && actual.data === wanted.data;
  return {
    ...(desired.fn === undefined || current?.fn === desired.fn ? {} : { fn: desired.fn }),
    ...(wanted === undefined || samePhoto ? {} : { photo: wanted }),
  };
}
