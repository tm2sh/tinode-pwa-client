import { Tinode } from 'tinode-sdk';

const expectedVersion = '0.26.0-alpha3';

export const sdkVersion = Tinode.getVersion();

if (sdkVersion !== expectedVersion) {
  throw new Error('The Tinode SDK version does not match the pinned release.');
}
