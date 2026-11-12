import type { ClientConfig } from './client-config';

// Use the same server ID for the adapter, the session record, and the storage key.
export function tinodeServerId(config: Pick<ClientConfig, 'secure' | 'host'>): string {
  return new URL((config.secure ? 'wss://' : 'ws://') + config.host).origin;
}
