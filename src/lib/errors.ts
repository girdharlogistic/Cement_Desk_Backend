/** Error envelope per spec §10: { error: { code, message, details?, requestId } } */

export type ErrorDetail = { field?: string; code: string; message: string };

export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: ErrorDetail[],
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const errors = {
  validation: (message: string, details?: ErrorDetail[]) =>
    new AppError(400, 'VALIDATION_FAILED', message, details),
  malformedJson: () => new AppError(400, 'MALFORMED_JSON', 'Request body is not valid JSON'),
  unauthenticated: (message = 'Authentication required') =>
    new AppError(401, 'UNAUTHENTICATED', message),
  tokenExpired: () => new AppError(401, 'TOKEN_EXPIRED', 'Access token expired'),
  tokenRevoked: () => new AppError(401, 'TOKEN_REVOKED', 'Session was revoked'),
  forbidden: (message = 'Forbidden') => new AppError(403, 'FORBIDDEN', message),
  insufficientRole: () => new AppError(403, 'INSUFFICIENT_ROLE', 'Insufficient role for this operation'),
  notAFirmMember: () => new AppError(403, 'NOT_A_FIRM_MEMBER', 'Not a member of this firm'),
  notFound: (message = 'Not found') => new AppError(404, 'NOT_FOUND', message),
  revMismatch: (server?: unknown) => {
    const e = new AppError(409, 'REV_MISMATCH', 'The record was changed elsewhere');
    (e as any).server = server;
    return e;
  },
  duplicateKey: (message = 'Duplicate key') => new AppError(409, 'DUPLICATE_KEY', message),
  claimImmutable: (field: string) =>
    new AppError(409, 'CLAIM_IMMUTABLE', `Claim field '${field}' is frozen and cannot be modified`),
  cursorTooOld: () =>
    new AppError(409, 'CURSOR_TOO_OLD', 'Sync cursor is older than the tombstone retention window; do a full resync'),
  stockDayExists: () => new AppError(409, 'STOCK_DAY_EXISTS', 'A stock sheet already exists for this date'),
  dayBeforeBaseline: () =>
    new AppError(409, 'DAY_BEFORE_BASELINE', 'Pick a date after the opening balances date.'),
  lastOwner: () => new AppError(409, 'LAST_OWNER', 'A firm must always keep at least one owner'),
  lastFirm: () => new AppError(409, 'LAST_FIRM', 'A user must always keep at least one firm'),
  businessRule: (message: string, details?: ErrorDetail[]) =>
    new AppError(422, 'BUSINESS_RULE_VIOLATION', message, details),
  rateLimited: (retryAfterSeconds: number) => {
    const e = new AppError(429, 'RATE_LIMITED', 'Too many requests');
    (e as any).retryAfter = retryAfterSeconds;
    return e;
  },
};

/** MySQL/TiDB duplicate-key error number. */
export const ER_DUP_ENTRY = 1062;
export function isDuplicateKey(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as any).errno === ER_DUP_ENTRY;
}
