const UNIQUE_VIOLATION = '23505';

/**
 * True when a database error is a Postgres unique-constraint violation. drizzle wraps driver
 * errors in a DrizzleQueryError with the original (carrying the Postgres `code`) as `cause`, so
 * the cause chain is checked as well as the error itself.
 */
export function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth += 1) {
    if ((current as { code?: unknown }).code === UNIQUE_VIOLATION) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
