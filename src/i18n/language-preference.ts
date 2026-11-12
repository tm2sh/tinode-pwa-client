export type AppLanguage = 'ru' | 'en';
export const languageStorageKey = 'tinode-pwa-client:language:v1';

// Also runs inline in the HTML head before the runtime bundle loads.
export function readStartupLanguage(key: string): AppLanguage {
  try {
    const saved = window.localStorage.getItem(key);
    if (saved === 'ru' || saved === 'en') return saved;
  } catch {
    // The browser's language remains available when storage is disabled.
  }

  const preferences = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const locale of preferences) {
    const primary = locale?.toLowerCase().split('-')[0];
    if (primary === 'ru' || primary === 'en') return primary;
  }
  return 'en';
}
