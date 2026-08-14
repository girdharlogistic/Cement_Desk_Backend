/**
 * Date handling per spec §5.7.
 * Business dates are calendar days, timezone-opaque: the dealer's "14 August" stays
 * 14 August regardless of server timezone. We therefore never construct a JS Date
 * from a business date — we validate the shape and pass the 'yyyy-MM-dd' string
 * straight through to the DATE column. Audit timestamps are DATETIME(3) in UTC,
 * carried as 'YYYY-MM-DD HH:mm:ss.SSS' strings (mysql2 is in dateStrings mode).
 */

export const MIN_BUSINESS_DATE = '2000-01-01';
export const MAX_BUSINESS_DATE = '2100-01-01';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_LOCAL_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,6})?)?$/;

function isRealCalendarDay(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= dim;
}

/**
 * Accepts 'yyyy-MM-dd' or an ISO-8601 local-midnight datetime WITHOUT timezone
 * offset (what the client's toIso8601String produces), and also tolerates a
 * trailing 'Z' — in every case the calendar day is taken literally, with no
 * timezone conversion applied (§5.7). Returns 'yyyy-MM-dd' or null.
 */
export function parseBusinessDate(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let day: string;
  const m1 = DATE_RE.exec(input);
  if (m1) {
    day = input;
  } else {
    const m2 = ISO_LOCAL_RE.exec(input);
    if (m2) {
      day = m2[1];
    } else {
      // ISO with explicit offset: take the date part literally (no conversion).
      const m3 = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})$/.exec(input);
      if (!m3) return null;
      day = m3[1];
    }
  }
  const [y, mo, d] = day.split('-').map((s) => parseInt(s, 10));
  if (!isRealCalendarDay(y, mo, d)) return null;
  if (day < MIN_BUSINESS_DATE || day >= MAX_BUSINESS_DATE) return null;
  return day;
}

/** DATETIME(3) 'YYYY-MM-DD HH:mm:ss.SSS' in UTC for "now". */
export function nowSql(d: Date = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}`
  );
}

export function addSecondsSql(base: Date, seconds: number): string {
  return nowSql(new Date(base.getTime() + seconds * 1000));
}

export function addDaysSql(base: Date, days: number): string {
  return addSecondsSql(base, days * 86400);
}

/** Convert a DATETIME(3) sql string to ISO-8601 with 'Z' for the wire. */
export function sqlToIso(sql: string | null | undefined): string | null {
  if (!sql) return null;
  return sql.replace(' ', 'T') + 'Z';
}

/** Convert an ISO-8601 instant (cursor) to DATETIME(3) sql string, or null if invalid. */
export function isoToSql(iso: unknown): string | null {
  if (typeof iso !== 'string') return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return nowSql(new Date(t));
}

export function businessDateOrThrow(input: unknown, field: string): string {
  const d = parseBusinessDate(input);
  if (!d) {
    const e = new Error(`Invalid business date for ${field}`);
    (e as any).field = field;
    throw e;
  }
  return d;
}
