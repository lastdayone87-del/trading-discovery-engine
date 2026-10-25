/**
 * Shared URL identity for same-inspection evidence.
 *
 * The static terminal-not-found barrier and the rendered crawler must agree
 * on what "the same seed URL" means; a drifting copy of this normalizer would
 * make the barrier miss the seed observation or match the wrong one. Keep the
 * implementation dependency-free so both tiers can import it.
 */
export function normalizeVisitUrl(rawUrl: string): string | null {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const path = parsed.pathname.replace(/\/+$/, '') || '/';
  const port = parsed.port ? `:${parsed.port}` : '';
  return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${port}${path}${parsed.search}`;
}
