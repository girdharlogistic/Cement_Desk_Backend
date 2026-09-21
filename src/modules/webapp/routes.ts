import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createReadStream, statSync, existsSync, realpathSync } from 'fs';
import { join, normalize, extname, sep } from 'path';
import { getConfig } from '../../config';

/**
 * Serves the Cement Desk PWA at `/app/`, and the installability shim at `/`.
 *
 * ## Why this lives in the API server
 *
 * Same origin. The Flutter app's base URL is hard-coded to
 * `https://cementdesk.sallytion.qzz.io/api/v1`, and serving the web build from
 * that same host means its requests are same-origin: no CORS preflight on
 * every sync push, no second hostname in the tunnel, no third party in the
 * critical path. It also means one deploy — `tools/build_pwa.sh` in the
 * Android repo rsyncs a directory and this reads it. There is nothing to
 * restart.
 *
 * ## Why `/app/` and not `/`
 *
 * `/` is the developer-website URL on the Play listing, and Google crawls it.
 * It stays the marketing page. The PWA lives one level down, its manifest
 * scopes itself to `/app/`, and the landing page's "Add to Home Screen"
 * button installs it from there.
 *
 * ## Caching
 *
 * `no-cache` with a strong ETag on everything, which reads as wasteful and is
 * not: Flutter's output is not content-hashed — `main.dart.js` keeps that name
 * across every build — so any `max-age` at all risks pinning a browser to a
 * build that no longer exists. Revalidation costs one 304, and after the first
 * visit the service worker is answering anyway, so almost nothing reaches
 * here twice.
 *
 * A `.gz` written beside a file by tools/precompress_web.py is served in its
 * place to clients that take gzip — CanvasKit is 5.7 MB of wasm that halves.
 */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  // Streaming compilation only happens when the type is exactly this. Get it
  // wrong and CanvasKit still loads, just slower and through a second parse.
  '.wasm': 'application/wasm',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.bin': 'application/octet-stream',
  '.frag': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function mimeFor(path: string): string {
  const ext = extname(path).toLowerCase();
  if (MIME[ext]) return MIME[ext];
  // Flutter emits `NOTICES` and `AssetManifest.bin` without a useful
  // extension. Text beats a download prompt.
  if (path.endsWith('NOTICES')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

/**
 * Resolves a request path inside the web root, or null if it escapes.
 *
 * Two checks, because one is not enough: `normalize` collapses `..` segments,
 * and the realpath comparison catches a symlink inside the directory pointing
 * out of it. This directory is written by rsync from a build machine, so
 * neither is likely — but a static file server that can be talked out of its
 * root is the oldest bug there is, and the check is two lines.
 */
function resolveInRoot(root: string, requestPath: string): string | null {
  const decoded = (() => {
    try {
      return decodeURIComponent(requestPath);
    } catch {
      return null;
    }
  })();
  if (decoded === null || decoded.includes('\0')) return null;

  const rel = normalize(decoded).replace(/^(\.\.(\/|\\|$))+/, '');
  const full = join(root, rel);
  if (full !== root && !full.startsWith(root + sep)) return null;
  if (!existsSync(full)) return null;
  try {
    const real = realpathSync(full);
    const realRoot = realpathSync(root);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) return null;
    return real;
  } catch {
    return null;
  }
}

function acceptsGzip(req: FastifyRequest): boolean {
  const header = req.headers['accept-encoding'];
  if (typeof header !== 'string') return false;
  return /\bgzip\b/.test(header);
}

function sendFile(req: FastifyRequest, reply: FastifyReply, path: string): FastifyReply {
  let stat = statSync(path);
  if (stat.isDirectory()) {
    const index = join(path, 'index.html');
    if (!existsSync(index)) {
      reply.callNotFound();
      return reply;
    }
    path = index;
    stat = statSync(path);
  }

  const type = mimeFor(path);
  let body = path;
  let encoding: string | null = null;

  const packed = path + '.gz';
  if (acceptsGzip(req) && existsSync(packed)) {
    body = packed;
    encoding = 'gzip';
    // Sized from the compressed copy on purpose — content-length describes
    // what goes on the wire, not what comes out the other end.
    stat = statSync(packed);
  }

  // Suffixed for the gzip copy: the same resource in two encodings is two
  // entities, and a shared validator lets a cache in between hand a gzip body
  // to a client that asked for none.
  const etag = `"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}${encoding ? '-gz' : ''}"`;

  reply
    .header('content-type', type)
    .header('cache-control', 'no-cache')
    .header('etag', etag)
    .header('vary', 'Accept-Encoding')
    // The app is not meant to be framed by anyone, including us.
    .header('x-content-type-options', 'nosniff');

  if (encoding) reply.header('content-encoding', encoding);

  if (req.headers['if-none-match'] === etag) return reply.code(304).send();

  reply.header('content-length', String(stat.size));
  return reply.send(createReadStream(body));
}

/**
 * The service worker the *landing page* registers.
 *
 * It caches nothing and is not the PWA's service worker — that one is at
 * `/app/sw.js` and does the real work. This exists because Chrome will not
 * offer `beforeinstallprompt` on a page that no service worker controls, and
 * the whole point of the "Add to Home Screen" button is that it sits on `/`
 * beside the Play button. A worker scoped to `/app/` cannot control `/`, so
 * `/` gets its own, and it is a pass-through so that nothing about the
 * marketing page's caching changes.
 */
const ROOT_SW = `// Cement Desk — installability shim for the landing page.
// Intentionally does nothing. The PWA's real service worker is /app/sw.js.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
`;

export function registerWebAppRoutes(app: FastifyInstance): void {
  const root = getConfig().WEBAPP_DIR.replace(/\/+$/, '');

  app.get('/sw.js', async (_req, reply) =>
    reply
      .type('text/javascript; charset=utf-8')
      .header('cache-control', 'no-cache')
      // Without this a worker served from `/` may only claim `/`; it is
      // already at the root, but stating it keeps a future move honest.
      .header('service-worker-allowed', '/')
      .send(ROOT_SW),
  );

  // `/app` without the slash would resolve the page's relative URLs against
  // `/`, so every asset would 404. A permanent redirect rather than serving
  // the page at both, so the installed app only ever has one start URL.
  app.get('/app', async (_req, reply) => reply.redirect('/app/', 301));

  const serve = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!existsSync(root)) {
      return reply.code(503).send({
        error: {
          code: 'WEBAPP_NOT_DEPLOYED',
          message: 'The web app has not been deployed to this server yet.',
          requestId: req.id,
        },
      });
    }

    const rest = (req.params as { '*'?: string })['*'] ?? '';
    const target = resolveInRoot(root, rest === '' ? 'index.html' : rest);
    if (target) return sendFile(req, reply, target);

    // Not a file. If a browser is asking for a page — a restored tab, a
    // shortcut, a link into the app — hand back the shell and let Flutter
    // sort out where it lands. Anything else is a genuine 404: answering an
    // asset request with HTML is how you get a "SyntaxError: Unexpected
    // token <" that takes an afternoon to trace.
    const accept = req.headers.accept ?? '';
    if (typeof accept === 'string' && accept.includes('text/html')) {
      const shell = resolveInRoot(root, 'index.html');
      if (shell) return sendFile(req, reply, shell);
    }
    reply.callNotFound();
    return reply;
  };

  app.get('/app/', serve);
  app.get('/app/*', serve);
}
