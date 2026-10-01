import { domainToASCII } from 'node:url';
import { getDomain, parse } from 'tldts';

export type SiteIdentityTier = 'A' | 'B' | 'C';

export interface SiteIdentity {
  /** Global deduplication key: registrable domain (A), full host (B),
   * or host + first path segment (C). Never a full URL. */
  siteIdentity: string;
  tier: SiteIdentityTier;
  /** Human-readable basis for audit logs (registry entry or PSL result). */
  basis: string;
  /** Normalized destination URL the identity was computed from. */
  crawlUrl: string;
}

/** Platforms whose subdomains are independent tenant sites. A subdomain of
 * one of these suffixes identifies the site by full host: collapsing to the
 * registrable domain would merge unrelated tenants (e.g. every Skool
 * community into `skool.com`). Code-owned, evidence-backed only: entries
 * require observed creator-link fixtures or production data. */
const SUBDOMAIN_TENANT_SUFFIXES = ['skool.com', 'circle.so'] as const;

/** Platforms whose tenants live under paths of a shared host. Neither the
 * registrable domain nor the full host separates them
 * (`linktr.ee/trader1` vs `linktr.ee/trader2`), so the identity carries the
 * first path segment. Same evidence bar as Tier B. */
const PATH_TENANT_HOSTS = [
  'linktr.ee',
  'beacons.ai',
  'whop.com',
  'bio.link',
  'solo.to',
  'campsite.bio',
  'lnk.bio',
  'patreon.com',
] as const;

export const SITE_IDENTITY_POLICY_VERSION = 'site-identity-v1';

function asciiHost(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  try {
    const ascii = domainToASCII(trimmed).replace(/\.+$/, '');
    return ascii || null;
  } catch {
    return null;
  }
}

function suffixMatch(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

/** Public suffix from the PSL private section (multi-tenant hosting such as
 * github.io, vercel.app, herokuapp.com), or null. Used split-only: a private
 * suffix marks a tenant boundary, so subdomains identify by full host and
 * can never collapse into one cache identity. PSL drift can only cause extra
 * splitting (recrawls), never unsafe merging — unlike relying on private
 * suffixes to decide merges, which stays prohibited. */
function privateTenantSuffix(host: string): string | null {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(host, { allowPrivateDomains: true });
  } catch {
    return null;
  }
  if (!parsed || !parsed.isPrivate || !parsed.publicSuffix) return null;
  return parsed.publicSuffix;
}

/** Computes the global site identity for a crawled URL. Identity is derived
 * from `finalUrl` (post-redirect destination) when available, falling back
 * to the requested URL — redirects are resolved first (Tier D behavior),
 * with the wrapper preserved separately by the caller. Returns null when no
 * safe identity exists (non-http(s), unparsable, dotless, IP literal, or
 * unknown public suffix): callers must then crawl without cache reuse
 * (fail closed toward inspection, never toward merging). */
export function canonicalSiteIdentity(requestedUrl: string, finalUrl?: string | null): SiteIdentity | null {
  const raw = (finalUrl || requestedUrl || '').trim();
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const host = asciiHost(parsed.hostname);
  if (!host || !host.includes('.')) return null;

  const pathTenant = PATH_TENANT_HOSTS.find(entry => suffixMatch(host, entry));
  if (pathTenant) {
    const firstSegment = parsed.pathname.split('/').filter(Boolean)[0];
    if (!firstSegment) return { siteIdentity: host, tier: 'C', basis: `path-tenant bare host ${pathTenant}`, crawlUrl: parsed.toString() };
    return { siteIdentity: `${host}/${firstSegment}`, tier: 'C', basis: `path-tenant ${pathTenant}`, crawlUrl: parsed.toString() };
  }

  const subdomainTenant = SUBDOMAIN_TENANT_SUFFIXES.find(entry => suffixMatch(host, entry));
  if (subdomainTenant) {
    return { siteIdentity: host, tier: 'B', basis: `subdomain-tenant ${subdomainTenant}`, crawlUrl: parsed.toString() };
  }

  // Private-suffix tenants (github.io, vercel.app, …): the registrable domain
  // under a private suffix is a tenant boundary, not a shared site. Split by
  // full host without requiring a registry entry. Split-only and fail-closed:
  // ICANN-suffix hosts are unaffected and keep Tier A behavior below.
  const tenantSuffix = privateTenantSuffix(host);
  if (tenantSuffix) {
    return { siteIdentity: host, tier: 'B', basis: `private-suffix tenant ${tenantSuffix}`, crawlUrl: parsed.toString() };
  }

  // Tier A: ICANN PSL registrable domain only. Private-domain behavior is
  // deliberately NOT enabled for merges: tenant platforms are decided by the
  // explicit registries above (or the private-suffix split) so PSL data drift
  // can never silently merge tenants.
  const registrable = getDomain(host);
  if (!registrable) return null;
  return { siteIdentity: registrable.toLowerCase(), tier: 'A', basis: 'ICANN registrable domain', crawlUrl: parsed.toString() };
}
