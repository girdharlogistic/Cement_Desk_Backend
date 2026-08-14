import { z, ZodTypeAny, ZodError } from 'zod';
import { errors, ErrorDetail } from './errors';

function zodDetails(err: ZodError): ErrorDetail[] {
  return err.issues.map((i) => ({
    field: i.path.join('.') || undefined,
    code: i.code.toUpperCase(),
    message: i.message,
  }));
}

/** Parse with zod; failures become 400 VALIDATION_FAILED envelopes (§10). */
export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.output<S> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) throw errors.validation('Validation failed', zodDetails(r.error));
  return r.data;
}

export function parseOr<S extends ZodTypeAny>(schema: S, data: unknown, fallback: z.output<S>): z.output<S> {
  const r = schema.safeParse(data ?? {});
  return r.success ? r.data : fallback;
}
