import { z } from 'zod';
import { q } from '../../db/pool';
import { TtlCache } from '../../lib/cache';

/**
 * One slot, one row, read by every install on every resume and written by one
 * operator about once a month — the most cacheable thing in the product. The
 * route already sends `cache-control: public, max-age=300` for the edge; this
 * covers the requests that reach the origin anyway, and the console clears it
 * on save so an operator never has to wonder whether their change went out.
 */
const CACHE_TTL_MS = 60_000;
const cache = new TtlCache<Sponsor>(CACHE_TTL_MS, 1);
const CACHE_KEY = 'sponsor';

/** Called by the console the moment the slot is edited. */
export function invalidateSponsor(): void {
  cache.delete(CACHE_KEY);
}

/**
 * The one sponsored card at the top of the app's Home screen.
 *
 * Read by every install, written only by the console. Deliberately a single
 * row rather than a campaign table: there is one slot, and a schedule nobody
 * has asked for is a schedule nobody maintains.
 */

export interface Sponsor {
  enabled: boolean;
  label: string;
  brand: string;
  byLine: string;
  pitch: string;
  cta: string;
  /** What kind of address [linkUrl] holds. */
  linkKind: SponsorLinkKind;
  /** The whole address, scheme and all — `tel:…`, `mailto:…`, an https URL. */
  linkUrl: string;
  imageUrl: string;
  accent: string;
  updatedAt: string;
}

/**
 * The four things a sponsor's button can do.
 *
 * Kept a closed list rather than "any URI the operator types", because this
 * string is handed straight to a phone's launcher on every install: an open
 * field is how `javascript:` and `intent:` get in. Adding a fifth is a one-line
 * change here, in [LINK_RULES], and in the console's dropdown.
 */
export const SPONSOR_LINK_KINDS = ['web', 'phone', 'whatsapp', 'email'] as const;
export type SponsorLinkKind = (typeof SPONSOR_LINK_KINDS)[number];

/**
 * Per kind: how to read what the operator typed, and how to write it back out.
 *
 * `parse` returns the canonical address or null if the input is not one of
 * these at all; `display` is the inverse, and is what the app puts on the
 * button when the sponsor has not written their own text — a number reads
 * better on a button that dials than the word "Website" does.
 */
interface LinkRule {
  parse(raw: string): string | null;
  display(url: string): string;
  message: string;
}

/** Digits and a leading +, with the spaces, dashes and brackets people type. */
function digits(raw: string): string {
  return raw.replace(/[^\d]/g, '');
}

const LINK_RULES: Record<SponsorLinkKind, LinkRule> = {
  web: {
    // Unchanged from when this was the only kind: https only, absolute only.
    parse: (raw) => (/^https:\/\/[^\s]+$/i.test(raw) ? raw : null),
    display: (url) => url.replace(/^https:\/\//i, '').replace(/\/$/, ''),
    message: 'The link must be a full https:// address.',
  },
  phone: {
    // A dialler takes anything, so the only real check is that this is a
    // number at all. The `+` is kept when it is there — a sponsor who wrote
    // their country code meant it, and a phone roaming outside India needs it.
    parse: (raw) => {
      const d = digits(raw);
      if (d.length < 6 || d.length > 15) return null;
      return `tel:${raw.trim().startsWith('+') ? '+' : ''}${d}`;
    },
    display: (url) => url.replace(/^tel:/i, ''),
    message: 'Give a phone number of 6 to 15 digits.',
  },
  whatsapp: {
    // wa.me wants the country code and nothing else — no `+`, no spaces. A
    // ten-digit Indian number posted as-is opens a chat with nobody and fails
    // silently on the phone, so it is rejected here instead.
    parse: (raw) => {
      const d = digits(raw).replace(/^0+/, '');
      if (d.length < 11 || d.length > 15) return null;
      return `https://wa.me/${d}`;
    },
    display: (url) => `+${url.replace(/^https:\/\/wa\.me\//i, '')}`,
    message: 'Give a WhatsApp number with its country code, like 919876543210.',
  },
  email: {
    parse: (raw) => {
      const v = raw.trim();
      return /^[^\s@,:;<>]+@[^\s@.,:;<>]+(\.[^\s@.,:;<>]+)+$/.test(v) ? `mailto:${v}` : null;
    },
    display: (url) => url.replace(/^mailto:/i, ''),
    message: 'That does not look like an email address.',
  },
};

/**
 * The address as a person would read it: `98765 43210`, not `tel:9876543210`.
 *
 * Computed rather than stored, so the one canonical copy of the link stays the
 * one the launcher is given.
 */
export function linkText(kind: SponsorLinkKind, url: string): string {
  if (!url) return '';
  return LINK_RULES[kind].display(url);
}

/**
 * What the console may set.
 *
 * `enabled` is validated but everything else is accepted empty, because a
 * half-filled draft has to be savable — the operator switching it on is the
 * moment it matters, and that is checked in [SponsorInput.superRefine].
 */
export const SponsorInput = z
  .object({
    enabled: z.boolean(),
    label: z.string().trim().max(40).default('Sponsored'),
    brand: z.string().trim().max(60).default(''),
    byLine: z.string().trim().max(80).default(''),
    pitch: z.string().trim().max(300).default(''),
    cta: z.string().trim().max(30).default(''),
    linkKind: z.enum(SPONSOR_LINK_KINDS).default('web'),
    // What the operator typed, in whatever shape suits the kind they picked —
    // a number with spaces in it, an email address, an https URL. The
    // transform below is what turns it into the address the app launches.
    linkUrl: z.string().trim().max(500).default(''),
    imageUrl: z.string().trim().max(500).default(''),
    accent: z
      .string()
      .trim()
      .max(7)
      .default('')
      .refine((v) => v === '' || /^#[0-9a-f]{6}$/i.test(v), {
        message: 'The accent must be a hex colour like #C97B4E.',
      }),
  })
  .superRefine((v, ctx) => {
    // Switching the slot on with no brand would replace the in-house card with
    // an anonymous box. Off, anything goes — it is a draft.
    if (v.enabled && !v.brand) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Give the sponsor a name before switching the card on.',
      });
    }
    // Empty is always allowed: no link means no button, which is a card that
    // just says something. A non-empty one has to be the kind it claims to be,
    // because nothing downstream looks at it again — the app hands it to the
    // phone's launcher as it stands.
    if (v.linkUrl && LINK_RULES[v.linkKind].parse(v.linkUrl) === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['linkUrl'],
        message: LINK_RULES[v.linkKind].message,
      });
    }
  })
  // Canonical form is written, never what was typed: `98765 43210` and
  // `+91 98765-43210` are the same button, and the row should not remember
  // which day's typing produced it.
  .transform((v) => ({
    ...v,
    linkUrl: v.linkUrl ? (LINK_RULES[v.linkKind].parse(v.linkUrl) ?? '') : '',
  }));

export type SponsorInputType = z.infer<typeof SponsorInput>;

const EMPTY: Sponsor = {
  enabled: false,
  label: 'Sponsored',
  brand: '',
  byLine: '',
  pitch: '',
  cta: '',
  linkKind: 'web',
  linkUrl: '',
  imageUrl: '',
  accent: '',
  updatedAt: '',
};

export async function readSponsor(): Promise<Sponsor> {
  const hit = cache.get(CACHE_KEY);
  if (hit) return hit;
  const rows = await q<{
    enabled: number;
    label: string;
    brand: string;
    by_line: string;
    pitch: string;
    cta: string;
    link_kind: string;
    link_url: string;
    image_url: string;
    accent: string;
    updated_at: string;
  }>(
    `SELECT enabled, label, brand, by_line, pitch, cta, link_kind, link_url,
            image_url, accent, updated_at
       FROM app_sponsor WHERE id = 1`,
  );
  const r = rows[0];
  // The migration seeds the row, so a miss means someone truncated the table.
  // Answering with the empty slot beats a 500 on the app's Home screen.
  if (!r) return EMPTY;
  const sponsor: Sponsor = {
    enabled: r.enabled === 1,
    label: r.label,
    brand: r.brand,
    byLine: r.by_line,
    pitch: r.pitch,
    cta: r.cta,
    // The column is CHECK-constrained, so this only falls back for a row
    // written by hand. 'web' is what every pre-0002 row meant.
    linkKind: (SPONSOR_LINK_KINDS as readonly string[]).includes(r.link_kind)
      ? (r.link_kind as SponsorLinkKind)
      : 'web',
    linkUrl: r.link_url,
    imageUrl: r.image_url,
    accent: r.accent,
    updatedAt: r.updated_at,
  };
  cache.set(CACHE_KEY, sponsor);
  return sponsor;
}

export async function writeSponsor(input: SponsorInputType): Promise<void> {
  // UPSERT rather than UPDATE: the row is seeded by the migration, but a
  // console that only works on a database somebody remembered to seed is a
  // console that breaks on the next fresh environment.
  await q(
    `INSERT INTO app_sponsor
       (id, enabled, label, brand, by_line, pitch, cta, link_kind, link_url,
        image_url, accent)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       enabled = excluded.enabled, label = excluded.label, brand = excluded.brand,
       by_line = excluded.by_line, pitch = excluded.pitch, cta = excluded.cta,
       link_kind = excluded.link_kind, link_url = excluded.link_url,
       image_url = excluded.image_url, accent = excluded.accent`,
    [
      input.enabled ? 1 : 0,
      input.label,
      input.brand,
      input.byLine,
      input.pitch,
      input.cta,
      input.linkKind,
      input.linkUrl,
      input.imageUrl,
      input.accent,
    ],
  );
  // Straight after the write, so the operator's next look at the app shows
  // what they just saved rather than what it said a minute ago.
  invalidateSponsor();
}
