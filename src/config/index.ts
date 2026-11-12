import { readClientConfig } from './client-config';

export const clientConfig = readClientConfig({
  VITE_TINODE_HOST: import.meta.env.VITE_TINODE_HOST,
  VITE_TINODE_API_KEY: import.meta.env.VITE_TINODE_API_KEY,
  VITE_APP_BASE: import.meta.env.VITE_APP_BASE,
  VITE_UI_LANGUAGE: import.meta.env.VITE_UI_LANGUAGE,
  VITE_REGISTRATION_ENABLED: import.meta.env.VITE_REGISTRATION_ENABLED,
  VITE_CHAT_CREATION_ENABLED: import.meta.env.VITE_CHAT_CREATION_ENABLED,
});
