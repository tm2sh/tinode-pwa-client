export const themePreferences = ['system', 'dark', 'light', 'black', 'white'] as const;

export type ThemePreference = (typeof themePreferences)[number];

export const themeStorageKey = 'tinode-pwa-client:theme:v1';

// These functions also run inline from the HTML head before the app loads.
export function readStoredTheme(key: string, preferences: readonly ThemePreference[]): ThemePreference {
  try {
    const value = window.localStorage.getItem(key);
    return preferences.find(preference => preference === value) ?? 'system';
  } catch {
    return 'system';
  }
}

export function applyThemePreference(preference: ThemePreference): void {
  const { dataset } = document.documentElement;
  dataset.theme = preference;
  if (preference === 'system') {
    dataset.palette = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } else {
    dataset.palette = preference;
  }
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[data-theme-color]')) {
    const scheme = meta.dataset.themeColor;
    if (preference === 'system' && (scheme === 'light' || scheme === 'dark')) {
      meta.media = '(prefers-color-scheme: ' + scheme + ')';
    } else if (preference === scheme) {
      meta.removeAttribute('media');
    } else {
      meta.media = 'not all';
    }
  }
}

export function watchSystemTheme(apply: typeof applyThemePreference): void {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (document.documentElement.dataset.theme === 'system') apply('system');
  });
}

export function getThemePreference(): ThemePreference {
  const value = document.documentElement.dataset.theme;
  return themePreferences.find(preference => preference === value) ?? 'system';
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
