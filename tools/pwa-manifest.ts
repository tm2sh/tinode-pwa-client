import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

export function pwaManifestPlugin(appBase: string, uiLanguage: 'ru' | 'en'): Plugin {
  let manifestPath = '';
  let translationsPath = '';
  const deploymentPath = appBase === './' ? '/' : appBase;

  function manifestSource(): string {
    const template = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const translations = JSON.parse(readFileSync(translationsPath, 'utf8'));
    if (typeof translations.appDescription !== 'string' || !translations.appDescription.trim()) {
      throw new Error('PWA description translation is missing.');
    }

    return JSON.stringify({
      ...template,
      lang: uiLanguage,
      description: translations.appDescription,
      id: deploymentPath,
      start_url: appBase,
      scope: appBase,
    }, null, 2) + '\n';
  }

  return {
    name: 'tinode-pwa-manifest',
    configResolved(config) {
      manifestPath = resolve(config.root, 'public/manifest.webmanifest');
      translationsPath = resolve(config.root, 'src/locales', uiLanguage, 'common.json');
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = (request.url ?? '/').split('?')[0];

        if (
          pathname !== deploymentPath + 'manifest.webmanifest' ||
          (request.method !== 'GET' && request.method !== 'HEAD')
        ) {
          next();
          return;
        }

        response.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
        response.setHeader('Cache-Control', 'no-cache');
        response.end(request.method === 'HEAD' ? undefined : manifestSource());
      });
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.webmanifest',
        source: manifestSource(),
      });
    },
  };
}
