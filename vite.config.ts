import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { readClientConfig } from './src/config/client-config.ts';
import { pwaManifestPlugin } from './tools/pwa-manifest.ts';
import { staticCompressionPlugin } from './tools/static-compression.ts';
import { bootstrapShellPlugin } from './tools/bootstrap-shell.ts';
import { tinodeMediaProxyPlugin } from './tools/tinode-media-proxy.ts';

export default defineConfig(({ mode }) => {
  const clientConfig = readClientConfig(loadEnv(mode, process.cwd(), 'VITE_'));

  return {
    plugins: [react(), tinodeMediaProxyPlugin(clientConfig.host), bootstrapShellPlugin(clientConfig.uiLanguage), staticCompressionPlugin(clientConfig.appBase), pwaManifestPlugin(clientConfig.appBase, clientConfig.uiLanguage), {
      name: 'ui-document-language',
      transformIndexHtml(html) {
        return html.replace('<html lang="ru">', '<html lang="' + clientConfig.uiLanguage + '">');
      },
    }],
    base: clientConfig.appBase,
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
    },
    preview: {
      host: '127.0.0.1',
      port: 4175,
      strictPort: true,
    },
    build: {
      target: 'es2022',
    },
  };
});
