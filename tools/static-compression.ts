import { createReadStream } from 'node:fs';
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';
import type { Plugin } from 'vite';

const compressGzip = promisify(gzip);
const compressBrotli = promisify(brotliCompress);
const contentTypes: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};
type Encoding = 'br' | 'gzip';
const extensions = { br: '.br', gzip: '.gz' } as const;

async function fileStat(filename: string): Promise<Stats | undefined> {
  try { const result = await stat(filename); return result.isFile() ? result : undefined; }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return undefined;
    throw error;
  }
}

function preferences(header: string | undefined): Map<string, number> {
  const values = new Map<string, number>();
  for (const item of header?.split(',') ?? []) {
    const [name, ...parameters] = item.trim().toLowerCase().split(';');
    if (!name) continue;
    const weight = parameters.find((parameter) => parameter.trim().startsWith('q='));
    const match = weight?.trim().match(/^q=(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/);
    values.set(name.trim(), weight === undefined ? 1 : match ? Number(match[1]) : 0);
  }
  return values;
}

function varyEncoding(response: ServerResponse): void {
  const previous = response.getHeader('Vary');
  const value = Array.isArray(previous) ? previous.join(', ') : String(previous ?? '');
  if (!value.split(',').some((item) => ['*', 'accept-encoding'].includes(item.trim().toLowerCase()))) {
    response.setHeader('Vary', value ? value + ', Accept-Encoding' : 'Accept-Encoding');
  }
}

async function serveCompressed(request: IncomingMessage, response: ServerResponse,
  next: () => void, outputDir: string, base: string): Promise<void> {
  if (!['GET', 'HEAD'].includes(request.method ?? '')) { next(); return; }
  let pathname: string;
  try { pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://preview.local').pathname); }
  catch { next(); return; }
  if (!pathname.startsWith(base)) { next(); return; }
  const name = pathname.slice(base.length) || 'index.html';
  const filename = resolve(outputDir, name);
  const local = relative(outputDir, filename);
  if (local === '..' || local.startsWith('..' + sep) || local.startsWith(sep)) { next(); return; }
  const contentType = contentTypes[extname(filename).toLowerCase()];
  if (!contentType) { next(); return; }
  const original = await fileStat(filename);
  if (!original) { next(); return; }
  varyEncoding(response);
  const weights = preferences(request.headers['accept-encoding']);
  const identity = weights.get('identity');
  const identityAllowed = identity !== 0 && !(identity === undefined && weights.get('*') === 0);
  if (request.headers.range) {
    if (!identityAllowed) { response.statusCode = 406; response.end(); return; }
    request.headers['accept-encoding'] = 'identity';
    next(); return;
  }
  let selected: { encoding: Encoding; stats: Stats; quality: number } | undefined;
  for (const encoding of ['br', 'gzip'] as const) {
    const quality = weights.get(encoding) ?? weights.get('*') ?? 0;
    if (quality <= 0 || (selected && quality <= selected.quality)) continue;
    const stats = await fileStat(filename + extensions[encoding]);
    // Skip stale compressed files when the original was rebuilt or replaced separately.
    if (stats && stats.mtimeMs >= original.mtimeMs && stats.size < original.size) {
      selected = { encoding, stats, quality };
    }
  }
  if (identity !== undefined && selected && identity > selected.quality) selected = undefined;
  if (!selected) {
    if (!identityAllowed) {
      response.statusCode = 406; response.end(); return;
    }
    // The standard preview applies gzip on the fly without honoring q values. We already selected identity.
    request.headers['accept-encoding'] = 'identity';
    next(); return;
  }
  const { encoding, stats } = selected;
  const etag = 'W/"' + stats.size.toString(16) + '-' + stats.mtimeMs.toString(16) + '-' + encoding + '"';
  response.setHeader('Content-Type', contentType);
  response.setHeader('Content-Encoding', encoding);
  response.setHeader('Cache-Control', 'no-cache');
  response.setHeader('ETag', etag);
  response.setHeader('Last-Modified', stats.mtime.toUTCString());
  const condition = request.headers['if-none-match'];
  if (condition?.split(',').some((value) => value.trim().replace(/^W\//, '') === etag.replace(/^W\//, '') || value.trim() === '*')) {
    response.statusCode = 304; response.end(); return;
  }
  response.setHeader('Content-Length', stats.size);
  if (request.method === 'HEAD') { response.end(); return; }
  // Stream the prepared bytes without compressing on demand or buffering the whole build.
  pipeline(createReadStream(filename + extensions[encoding]), response, () => {});
}

export function staticCompressionPlugin(appBase: string): Plugin {
  let outputDir = '';
  const base = appBase === './' ? '/' : appBase;
  return {
    name: 'tinode-static-compression',
    configResolved(config) { outputDir = resolve(config.root, config.build.outDir); },
    async writeBundle() {
      let count = 0;
      for (const entry of await readdir(outputDir, { withFileTypes: true, recursive: true })) {
        if (!entry.isFile() || !contentTypes[extname(entry.name).toLowerCase()]) continue;
        const filename = join(entry.parentPath, entry.name);
        const source = await readFile(filename);
        const [br, gz] = await Promise.all([
          compressBrotli(source, { params: {
            [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
            [constants.BROTLI_PARAM_QUALITY]: 11,
            [constants.BROTLI_PARAM_SIZE_HINT]: source.length,
          } }),
          compressGzip(source, { level: 6 }),
        ]);
        for (const [suffix, compressed] of [['.br', br], ['.gz', gz]] as const) {
          if (compressed.length < source.length) { await writeFile(filename + suffix, compressed); count++; }
          else await rm(filename + suffix, { force: true });
        }
      }
      this.info('Prepared ' + count + ' smaller gzip/Brotli variants; original files preserved.');
    },
    configurePreviewServer(server) {
      server.middlewares.use((request, response, next) => {
        void serveCompressed(request, response, next, outputDir, base).catch(next);
      });
    },
  };
}
