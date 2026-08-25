import { randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { getConfig } from '../../config';
import { errors } from '../../lib/errors';

/**
 * Storage for notification images.
 *
 * FCM does not accept an uploaded file — it takes a URL and fetches the image
 * from Google's side when the notification is built. So an image has to be
 * public somewhere before it can be sent, and this is the somewhere: written
 * to a directory outside the repo and served back over the tunnel.
 *
 * Deliberately no database table. These are throwaway attachments to a message
 * that has already been delivered; a row per file would outlive its usefulness
 * by years.
 */

/**
 * Only raster formats the notification tray can actually draw, and
 * deliberately **not** SVG: an SVG is a script container, and serving one from
 * our own origin would hand any uploader a cross-site scripting foothold on
 * the same domain the API answers on.
 */
const TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/** FCM recommends staying under 1 MB; this is the hard stop, not the advice. */
const MAX_BYTES = 4 * 1024 * 1024;

/** Files older than this are swept on the next upload. */
const KEEP_MS = 30 * 24 * 3600 * 1000;

function dir(): string {
  const d = getConfig().CONSOLE_MEDIA_DIR;
  if (!d) throw errors.validation('Image uploads are not configured (CONSOLE_MEDIA_DIR).');
  if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o755 });
  return d;
}

/**
 * The one shape a stored name may take. Every read goes through this before it
 * touches the filesystem — the name arrives in a URL, and a check that lets
 * `../` through turns an image route into "read any file on the server".
 *
 * The optional `s-` marks a *pinned* file: a sponsor logo, which is referenced
 * by a database row that will still be there in a year and so must survive
 * [sweep]. Notification attachments carry no prefix and are still swept.
 */
const NAME = /^(s-)?[a-f0-9]{32}\.(png|jpg|webp)$/;

/** Pinned files begin with this. Checked by [sweep], set by [storeDataUrl]. */
const PIN = 's-';

export interface StoredImage {
  name: string;
  url: string;
  bytes: number;
}

/**
 * Accepts a `data:` URL as posted by the console page and writes it out.
 *
 * Base64 in JSON rather than multipart: it costs a third more bytes on a file
 * that is capped at four megabytes anyway, and saves adding a body-parser
 * plugin to the server for one form.
 */
export function storeDataUrl(
  dataUrl: string,
  opts: {
    /**
     * Keep the file indefinitely. Set for a sponsor logo, whose URL is stored
     * in `app_sponsor` and read by the app for as long as that sponsor runs —
     * the 30-day sweep would otherwise leave a live card with a dead image.
     */
    pinned?: boolean;
  } = {},
): StoredImage {
  const m = /^data:([a-z/+-]+);base64,(.+)$/is.exec(dataUrl.trim());
  if (!m) throw errors.validation('That does not look like an image file.');
  const ext = TYPES[m[1].toLowerCase()];
  if (!ext) {
    throw errors.validation('Use a PNG, JPEG or WebP image.');
  }
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length) throw errors.validation('That image is empty.');
  if (buf.length > MAX_BYTES) {
    throw errors.validation(`That image is ${(buf.length / 1048576).toFixed(1)} MB — keep it under 4 MB.`);
  }

  const base = dir();
  sweep(base);
  const name = `${opts.pinned ? PIN : ''}${randomBytes(16).toString('hex')}.${ext}`;
  writeFileSync(join(base, name), buf, { mode: 0o644 });

  const origin = getConfig().PUBLIC_BASE_URL.replace(/\/+$/, '');
  if (!origin) {
    throw errors.validation('PUBLIC_BASE_URL is not set, so the image would have no reachable address.');
  }
  return { name, url: `${origin}/media/${name}`, bytes: buf.length };
}

export function readStored(name: string): { body: Buffer; contentType: string } {
  if (!NAME.test(name)) throw errors.notFound('No such image');
  const ext = name.split('.').pop()!;
  const contentType = Object.entries(TYPES).find(([, e]) => e === ext)?.[0] ?? 'application/octet-stream';
  const path = join(dir(), name);
  if (!existsSync(path)) throw errors.notFound('No such image');
  return { body: readFileSync(path), contentType };
}

/** Best-effort cleanup. A failure here must never block a send. */
function sweep(base: string): void {
  try {
    const cutoff = Date.now() - KEEP_MS;
    for (const f of readdirSync(base)) {
      if (!NAME.test(f) || f.startsWith(PIN)) continue;
      const p = join(base, f);
      if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
    }
  } catch {
    /* the disk is the operator's problem, not this request's */
  }
}
