import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { Plugin } from 'vite';
import { languageStorageKey, readStartupLanguage } from '../src/i18n/language-preference.ts';
import { applyThemePreference, readStoredTheme, themePreferences, themeStorageKey, watchSystemTheme } from '../src/app/theme-preference.ts';

function attribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll("'", '&#39;');
}

export function bootstrapShellPlugin(language: 'ru' | 'en'): Plugin {
  let root = '';
  return {
    name: 'tinode-bootstrap-shell',
    configResolved(config) { root = config.root; },
    handleHotUpdate({ file, server }) {
      if (file.startsWith(resolve(root, 'src/styles/themes') + sep)) {
        server.ws.send({ type: 'full-reload' });
        return [];
      }
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        const loadingLabel = (locale: 'ru' | 'en'): string => {
          const { loadingApplication } = JSON.parse(readFileSync(resolve(root, 'src/locales', locale, 'common.json'), 'utf8'));
          if (typeof loadingApplication !== 'string' || !loadingApplication.trim()) {
            throw new Error('Bootstrap loading translation is missing.');
          }
          return loadingApplication;
        };
        const labels = { ru: loadingLabel('ru'), en: loadingLabel('en') };
        // Render the startup spinner from the shared SVG before network requests.
        const icons = readFileSync(resolve(root, 'src/assets/ui-icons.svg'), 'utf8');
        const spinner = icons.match(/<symbol id="spinner" viewBox="0 0 24 24">([\s\S]*?)<\/symbol>/)?.[1].trim();
        if (!spinner) throw new Error('Bootstrap spinner symbol is missing.');
        // Make the initial background and spinner styles available before loading modules.
        const themes = themePreferences.filter(name => name !== 'system').map(name => 'themes/' + name + '.css');
        const styles = [...themes, 'app.css', 'spinner.css', 'loading-screen.css']
          .map(file => readFileSync(resolve(root, 'src/styles', file), 'utf8')).join('\n');
        const theme = '{ const apply = (' + applyThemePreference.toString() + ');' +
          'apply((' + readStoredTheme.toString() + ')(' + JSON.stringify(themeStorageKey) + ',' +
          JSON.stringify(themePreferences) + '));' +
          '(' + watchSystemTheme.toString() + ')(apply); }';
        const startupLanguage = 'document.documentElement.lang = (' + readStartupLanguage.toString() + ')(' +
          JSON.stringify(languageStorageKey) + ');';
        const label = 'document.getElementById("bootstrap-screen").setAttribute("aria-label", ' +
          JSON.stringify(labels).replaceAll('<', '\\u003c') + '[document.documentElement.lang]);';
        return html.replace('%BOOTSTRAP_THEME%', () => theme)
          .replace('%BOOTSTRAP_LANGUAGE%', () => startupLanguage)
          .replace('%BOOTSTRAP_LOADING_LANGUAGE%', () => label)
          .replace('%BOOTSTRAP_STYLES%', styles)
          .replace('%BOOTSTRAP_SPINNER%', spinner)
          .replace('%BOOTSTRAP_LOADING_LABEL%', attribute(labels[language]));
      },
    },
  };
}
