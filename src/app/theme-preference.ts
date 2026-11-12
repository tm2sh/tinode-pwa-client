export type ThemePreference = 'system' | 'light' | 'dark';

export const themeStorageKey = 'tinode-pwa-client:theme:v1';

// These two functions also run inline from the HTML head before the app loads.
export function readStoredTheme(key: string): ThemePreference {
  try {
    const value = window.localStorage.getItem(key);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

export function applyThemePreference(preference: ThemePreference): void {
  document.documentElement.dataset.theme = preference;
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[data-theme-color]')) {
    const scheme = meta.dataset.themeColor;
    if (preference === 'system') {
      meta.media = '(prefers-color-scheme: ' + scheme + ')';
    } else if (preference === scheme) {
      meta.removeAttribute('media');
    } else {
      meta.media = 'not all';
    }
  }
}

export function getThemePreference(): ThemePreference {
  const value = document.documentElement.dataset.theme;
  return value === 'light' || value === 'dark' ? value : 'system';
}

export function setThemePreference(preference: ThemePreference): boolean {
  applyThemePreference(preference);
  try {
    window.localStorage.setItem(themeStorageKey, preference);
    return true;
  } catch {
    return false;
  }
}
