import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

function authorization(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const name of ['x-tinode-apikey', 'x-tinode-auth']) {
    const value = request.headers[name];
    if (typeof value === 'string') headers.set(name, value);
  }
  return headers;
}

function allowedDestination(url: URL, server: URL): boolean {
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) return false;
  return url.origin === server.origin ||
    (url.port === '' && /^(?:[a-z0-9][a-z0-9.-]*\.)?s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/i.test(url.hostname));
}

async function serveFile(request: IncomingMessage, response: ServerResponse, server: URL): Promise<void> {
  const abort = new AbortController();
  const stop = () => abort.abort();
  request.once('aborted', stop);
  response.once('close', stop);
  try {
    let url = new URL(request.url!, server);
    let upstream: Response | undefined;
    for (let redirect = 0; redirect <= 3; redirect++) {
      if (!allowedDestination(url, server)) throw new Error('Unsupported media destination');
      upstream = await fetch(url, {
        method: request.method,
        headers: url.origin === server.origin ? authorization(request) : undefined,
        redirect: 'manual',
        signal: abort.signal,
      });
      if (![301, 302, 303, 307, 308].includes(upstream.status)) break;
      const location = upstream.headers.get('location');
      await upstream.body?.cancel();
      if (!location || redirect === 3) throw new Error('Invalid media redirect');
      url = new URL(location, url);
    }
    if (!upstream) throw new Error('Missing media response');
    response.statusCode = upstream.status;
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const mime = upstream.headers.get('content-type');
    if (mime) response.setHeader('Content-Type', mime);
    const length = upstream.headers.get('content-length');
    // fetch decompresses response bytes, so the compressed length cannot be reused.
    if (length && !upstream.headers.has('content-encoding')) response.setHeader('Content-Length', length);
    if (!upstream.body || request.method === 'HEAD') response.end();
    else {
      // DOM and Node declare separate types for the same WHATWG stream.
      const body = upstream.body as unknown as NodeReadableStream<Uint8Array>;
      await pipeline(Readable.fromWeb(body), response);
    }
  } catch {
    if (!response.headersSent && !response.destroyed) {
      response.writeHead(502, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      response.end('Media request failed.');
    } else if (!response.destroyed) response.destroy();
  } finally {
    request.removeListener('aborted', stop);
    response.removeListener('close', stop);
  }
}

// Vite development only. Production clients use the configured Tinode server directly.
export function tinodeMediaProxyPlugin(host: string): Plugin {
  const server = new URL('https://' + host);
  return {
    name: 'tinode-dev-media-proxy',
    apply: 'serve',
    config() {
      return { server: { proxy: {
        '^/v0/file/u(?:/|$)': {
          target: server.origin,
          changeOrigin: true,
          configure(proxy) {
            proxy.on('proxyReq', request => {
              request.removeHeader('origin');
              request.removeHeader('referer');
              request.removeHeader('cookie');
              request.removeHeader('authorization');
            });
          },
        },
      } } };
    },
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        const pathname = request.url?.split('?', 1)[0] ?? '';
        if ((request.method !== 'GET' && request.method !== 'HEAD') || !/^\/v0\/file\/s(?:\/|$)/.test(pathname)) {
          next();
          return;
        }
        void serveFile(request, response, server);
      });
    },
  };
}
