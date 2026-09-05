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
  linkUrl: string;
  imageUrl: string;
  accent: string;
  updatedAt: string;
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
    // Only http(s), and only an absolute URL. A `javascript:` or `intent:`
    // string here would be handed straight to a phone's URL launcher.
    linkUrl: z
      .string()
      .trim()
      .max(500)
      .default('')
      .refine((v) => v === '' || /^https:\/\/[^\s]+$/i.test(v), {
        message: 'The link must be a full https:// address.',
      }),
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
  });

export type SponsorInputType = z.infer<typeof SponsorInput>;

const EMPTY: Sponsor = {
  enabled: false,
  label: 'Sponsored',
  brand: '',
  byLine: '',
  pitch: '',
  cta: '',
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
    link_url: string;
    image_url: string;
    accent: string;
    updated_at: string;
  }>(
    `SELECT enabled, label, brand, by_line, pitch, cta, link_url, image_url,
            accent, updated_at
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
       (id, enabled, label, brand, by_line, pitch, cta, link_url, image_url, accent)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       enabled = excluded.enabled, label = excluded.label, brand = excluded.brand,
       by_line = excluded.by_line, pitch = excluded.pitch, cta = excluded.cta,
       link_url = excluded.link_url, image_url = excluded.image_url,
       accent = excluded.accent`,
    [
      input.enabled ? 1 : 0,
      input.label,
      input.brand,
      input.byLine,
      input.pitch,
      input.cta,
      input.linkUrl,
      input.imageUrl,
      input.accent,
    ],
  );
  // Straight after the write, so the operator's next look at the app shows
  // what they just saved rather than what it said a minute ago.
  invalidateSponsor();
}
