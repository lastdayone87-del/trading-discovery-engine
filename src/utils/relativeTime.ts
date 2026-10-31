/** Formats the first successful Discord validation timestamp for the table.
 * Returns null when the timestamp is absent or invalid so callers can render
 * an explicit "unavailable" state instead of inventing a discovery date. */
export function formatFoundAgo(timestamp: string | null | undefined, now = Date.now()): string | null {
  if (!timestamp) return null;
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed) || !Number.isFinite(now)) return null;
  const elapsedSeconds = Math.max(0, Math.floor((now - parsed) / 1000));
  if (elapsedSeconds < 60) return 'Found just now';
  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) return `Found ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Found ${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `Found ${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `Found ${months}mo ago`;
  return `Found ${Math.floor(months / 12)}y ago`;
}

/** Same bounded relative-time contract as `formatFoundAgo`, but for the
 * latest serving verification rather than the first confirmation. */
export function formatLastVerifiedAgo(timestamp: string | null | undefined, now = Date.now()): string | null {
  const found = formatFoundAgo(timestamp, now);
  return found ? found.replace(/^Found /, 'Verified ') : null;
}
