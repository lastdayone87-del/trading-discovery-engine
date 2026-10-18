import { Pool } from 'pg';

/**
 * True when `candidate` is a connection pool that must be checked out before a
 * multi-statement transaction can run on it.
 *
 * The shape test cannot be "has connect() and no release()": a standalone
 * pg.Client exposes connect() too, but it is itself the queryable — calling
 * connect() on it connects/reuses the caller's own client instead of handing
 * back a fresh one, and any later release() fails (a Client has no release).
 * Pool ownership is therefore explicit: a real Pool (instanceof) or a
 * connect-only double standing in for one. Anything already queryable —
 * standalone Client, checked-out PoolClient (release()), or a test runner
 * exposing query() — is reused as-is and stays on the caller's
 * transaction/connection.
 */
export function isConnectionPool(candidate: unknown): boolean {
  if (!candidate || (typeof candidate !== 'object' && typeof candidate !== 'function')) return false;
  const c = candidate as { connect?: unknown; query?: unknown };
  if (typeof c.connect !== 'function') return false;
  if ('release' in (candidate as object)) return false;
  return candidate instanceof Pool || typeof c.query !== 'function';
}
