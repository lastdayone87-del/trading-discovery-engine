/**
 * TEMPORARY read-only investigation: paid-community evidence provenance.
 *
 * This replaces the retry-job forensic script only on the temporary
 * investigation branch. It never writes to the database: the transaction is
 * READ ONLY and all queries are SELECTs.
 *
 * Goal:
 *  1. Explain where a channel's platform-community evidence URLs came from.
 *  2. Count PAID_COMMUNITY_INDICATED channels whose PAID evidence is only the
 *     platform's own docs/careers/blog/marketing/help pages.
 *  3. Preserve exact URLs/sources for review before proposing a filter.
 */
const fs = require('node:fs');
const { Client } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL secret is required');
const OUT_DIR = 'forensic-output';
fs.mkdirSync(OUT_DIR, { recursive: true });

const PLATFORMS = ['WHOP', 'SKOOL', 'CIRCLE', 'PATREON'];

// Conservative platform-owned path prefixes. Anything else on the platform
// host is treated as creator-specific, so the filter does not assume that
// single-segment creator URLs are platform pages.
const RESERVED_PATHS = {
  WHOP: new Set([
    '', 'about', 'academy', 'affiliates', 'api', 'apps', 'blog', 'brand', 'blueprints',
    'careers', 'company', 'contact', 'creators', 'customers', 'developers', 'discover',
    'docs', 'enterprise', 'events', 'features', 'guides', 'help', 'jobs', 'legal',
    'login', 'marketplace', 'newsroom', 'partners', 'press', 'pricing', 'privacy',
    'resources', 'security', 'signin', 'signup', 'sitemap', 'status', 'support',
    'team', 'terms', 'trust',
  ]),
  SKOOL: new Set([
    '', 'about', 'academy', 'affiliates', 'api', 'blog', 'brand', 'careers', 'communities',
    'community-guidelines', 'company', 'contact', 'creators', 'customers', 'developers',
    'discover', 'download', 'enterprise', 'events', 'features', 'games', 'guidelines',
    'help', 'jobs', 'leaderboard', 'leaderboards', 'legal', 'login', 'newsroom',
    'pricing', 'privacy', 'resources', 'signin', 'signup', 'sitemap', 'status',
    'support', 'terms',
  ]),
  CIRCLE: new Set([
    '', 'about', 'academy', 'api', 'blog', 'brand', 'careers', 'communities', 'community',
    'company', 'contact', 'creators', 'customers', 'demo', 'developers', 'docs', 'events',
    'features', 'help', 'integrations', 'jobs', 'legal', 'login', 'newsroom', 'pricing',
    'privacy', 'resources', 'security', 'signin', 'signup', 'sitemap', 'status', 'support',
    'terms', 'trust',
  ]),
  PATREON: new Set([
    '', 'about', 'api', 'blog', 'brand', 'careers', 'collections', 'community',
    'communities', 'company', 'contact', 'create', 'creators', 'developers', 'discover',
    'explore', 'features', 'help', 'home', 'jobs', 'join', 'legal', 'membership',
    'newsroom', 'paid', 'podcast', 'policy', 'press', 'pricing', 'privacy', 'resources',
    'search', 'signin', 'signup', 'sitemap', 'status', 'support', 'terms', 'trust',
    'video',
  ]),
};

const RESERVED_CIRCLE_SUBDOMAINS = new Set([
  'www', 'help', 'support', 'docs', 'blog', 'careers', 'status', 'api', 'login',
  'signup', 'signin', 'auth', 'billing', 'trust', 'security',
]);

function lowerHost(input) {
  try {
    return new URL(input).hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  } catch {
    return '';
  }
}

function parsedUrl(input) {
  try { return new URL(input); } catch { return null; }
}

function segments(input) {
  const u = parsedUrl(input);
  if (!u) return [];
  return u.pathname.split('/').filter(Boolean).map(part => decodeURIComponent(part).toLowerCase());
}

function normalizedUrl(input) {
  const u = parsedUrl(input);
  if (!u) return String(input || '').trim().toLowerCase().replace(/\/+$/, '');
  u.hash = '';
  return `${u.origin.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`;
}

function platformForHost(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  if (h === 'whop.com' || h.endsWith('.whop.com')) return 'WHOP';
  if (h === 'skool.com' || h.endsWith('.skool.com')) return 'SKOOL';
  if (h === 'circle.so' || h.endsWith('.circle.so')) return 'CIRCLE';
  if (h === 'patreon.com' || h.endsWith('.patreon.com')) return 'PATREON';
  return null;
}

/** A platform-own page is the platform's corporate/docs/careers/etc surface,
 * not a creator tenant/storefront. Kept deliberately conservative: only known
 * platform paths/subdomains are rejected. */
function isPlatformOwnPage(rawUrl, platformOverride) {
  const u = parsedUrl(rawUrl);
  if (!u) return false;
  const platform = platformOverride || platformForHost(u.hostname);
  if (!platform) return false;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  const segs = segments(rawUrl);
  const first = segs[0] || '';

  if (platform === 'WHOP') {
    // Whop creator pages are path-based. Every whop.com subdomain in the
    // observed evidence set is a platform property (docs/careers/help/...).
    if (host !== 'whop.com' && host !== 'www.whop.com') return true;
    return RESERVED_PATHS.WHOP.has(first);
  }

  if (platform === 'SKOOL') {
    // Skool creator communities are path-based on skool.com / www.skool.com.
    if (host !== 'skool.com' && host !== 'www.skool.com') return true;
    return RESERVED_PATHS.SKOOL.has(first);
  }

  if (platform === 'CIRCLE') {
    // Circle tenant communities are usually on a *.circle.so subdomain. The
    // platform's own marketing/docs site is circle.so. A /c/<slug> or
    // /join/<slug> path is community-specific even on a shared host.
    if (first === 'c' && segs.length >= 2) return false;
    if (first === 'join' && segs.length >= 2) return false;
    if (host !== 'circle.so' && host !== 'www.circle.so') {
      const sub = host.split('.')[0];
      return RESERVED_CIRCLE_SUBDOMAINS.has(sub);
    }
    return RESERVED_PATHS.CIRCLE.has(first);
  }

  if (platform === 'PATREON') {
    // Creator pages are patreon.com/<creator>, /c/<creator>, /join/<creator>.
    if (first === 'c' && segs.length >= 2) return false;
    if (first === 'join' && segs.length >= 2) return false;
    if (host !== 'patreon.com' && host !== 'www.patreon.com') return true;
    return RESERVED_PATHS.PATREON.has(first);
  }

  return false;
}

function evidenceKind(evidence) {
  const platform = String(evidence.communityPlatform || '').toUpperCase();
  const url = evidence.communityUrl;
  if (!PLATFORMS.includes(platform)) return 'unknown_platform';
  return isPlatformOwnPage(url, platform) ? 'platform_own' : 'creator_specific';
}

function sourceKind(evidence, platform) {
  const community = normalizedUrl(evidence.communityUrl);
  const source = normalizedUrl(evidence.sourcePageUrl);
  if (community && source && community === source) return 'same_page';
  if (!source) return 'missing_source';
  return isPlatformOwnPage(evidence.sourcePageUrl, platform)
    ? 'linked_from_platform_page'
    : 'linked_from_creator_page';
}

function safeIntents(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }
  return [];
}

function summariseChannel(row) {
  const intents = safeIntents(row.community_intents).filter(item => item && item.communityUrl);
  const evidence = intents.map(item => {
    const platform = String(item.communityPlatform || platformForHost(parsedUrl(item.communityUrl)?.hostname) || '').toUpperCase();
    return {
      platform,
      communityUrl: item.communityUrl,
      sourcePageUrl: item.sourcePageUrl || null,
      intent: item.intent || 'UNKNOWN',
      paidSignals: Array.isArray(item.paidSignals) ? item.paidSignals : [],
      privateSignals: Array.isArray(item.privateSignals) ? item.privateSignals : [],
      observedAt: item.observedAt || null,
      extractionConfidence: item.extractionConfidence || null,
      kind: evidenceKind({ ...item, communityPlatform: platform }),
      sourceKind: sourceKind({ ...item, communityPlatform: platform }, platform),
    };
  });
  const paid = evidence.filter(item => item.intent === 'PAID');
  const creatorPaid = paid.filter(item => item.kind === 'creator_specific');
  const platformPaid = paid.filter(item => item.kind === 'platform_own');
  return {
    channel_id: row.channel_id,
    channel_name: row.channel_name,
    youtube_url: row.youtube_url,
    subscriber_count: row.subscriber_count,
    country: row.country,
    community_discovery_status: row.community_discovery_status,
    discord_invite: row.discord_invite,
    community_intents: evidence,
    paid_count: paid.length,
    creator_paid_count: creatorPaid.length,
    platform_paid_count: platformPaid.length,
    classification: paid.length === 0 ? 'no_paid_evidence'
      : creatorPaid.length === 0 ? 'platform_only'
      : platformPaid.length === 0 ? 'creator_only'
      : 'mixed',
    platforms_with_platform_paid: [...new Set(platformPaid.map(item => item.platform).filter(Boolean))],
    platforms_with_creator_paid: [...new Set(creatorPaid.map(item => item.platform).filter(Boolean))],
  };
}

(async () => {
  const report = {
    generatedAt: new Date().toISOString(),
    criteria: {
      reservedPaths: Object.fromEntries(Object.entries(RESERVED_PATHS).map(([k, v]) => [k, [...v]])),
      circleReservedSubdomains: [...RESERVED_CIRCLE_SUBDOMAINS],
      rules: [
        'WHOP: whop.com paths not in reserved list, or any non-whop.com subdomain, are creator-specific. All observed *.whop.com subdomains are platform properties.',
        'SKOOL: skool.com/www.skool.com paths not in reserved list are creator-specific; other skool.com subdomains are platform properties.',
        'CIRCLE: circle.so paths in reserved list are platform-owned; /c/<slug> and /join/<slug> are creator-specific; tenant *.circle.so subdomains are creator-specific unless reserved.',
        'PATREON: /c/<slug> and /join/<slug> are creator-specific; patreon.com first path not reserved is creator-specific; other subdomains are platform-owned.',
      ],
    },
    paidChannels: [],
    platformBreakdown: {},
    evidenceMechanisms: {},
    stevenLord: null,
  };

  const client = new Client({
    connectionString: DATABASE_URL,
    application_name: 'dashboard-paid-community-investigation',
    statement_timeout: 120000,
  });
  try {
    await client.connect();
    await client.query('BEGIN TRANSACTION READ ONLY');
    await client.query("SET LOCAL statement_timeout = '120s'");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL work_mem = '8MB'");
    await client.query("SET LOCAL temp_file_limit = '64MB'");

    const paidRes = await client.query(`
      SELECT channel_id, channel_name, youtube_url, subscriber_count, country,
             community_discovery_status, community_intents, discord_invite,
             discord_duplicate_owner_channel_id, last_checked
      FROM channels
      WHERE community_discovery_status = 'PAID_COMMUNITY_INDICATED'
      ORDER BY channel_name ASC NULLS LAST, channel_id ASC
    `);
    report.paidChannelCount = paidRes.rowCount;
    report.paidChannels = paidRes.rows.map(summariseChannel);

    const platformBreakdown = Object.fromEntries(PLATFORMS.map(platform => [platform, {
      channelsWithPaidPlatformEvidence: 0,
      platformOnlyPaidChannels: 0,
      mixedPaidChannels: 0,
      platformPaidEvidence: 0,
      creatorPaidEvidence: 0,
      examples: [],
    }]));
    const mechanisms = {};
    let platformOnlyTotal = 0;
    let mixedTotal = 0;
    let creatorOnlyTotal = 0;
    let noPaidEvidenceTotal = 0;

    for (const channel of report.paidChannels) {
      if (channel.classification === 'platform_only') platformOnlyTotal += 1;
      else if (channel.classification === 'mixed') mixedTotal += 1;
      else if (channel.classification === 'creator_only') creatorOnlyTotal += 1;
      else noPaidEvidenceTotal += 1;

      for (const item of channel.community_intents) {
        if (!PLATFORMS.includes(item.platform)) continue;
        const bucket = platformBreakdown[item.platform];
        if (item.intent === 'PAID') {
          if (item.kind === 'platform_own') bucket.platformPaidEvidence += 1;
          if (item.kind === 'creator_specific') bucket.creatorPaidEvidence += 1;
        }
        const key = `${item.platform}:${item.kind}:${item.intent}:${item.sourceKind}`;
        mechanisms[key] = (mechanisms[key] || 0) + 1;
      }

      for (const platform of PLATFORMS) {
        const paidForPlatform = channel.community_intents.filter(item => item.platform === platform && item.intent === 'PAID');
        if (!paidForPlatform.length) continue;
        platformBreakdown[platform].channelsWithPaidPlatformEvidence += 1;
        if (channel.classification === 'platform_only') {
          platformBreakdown[platform].platformOnlyPaidChannels += 1;
          if (platformBreakdown[platform].examples.length < 3) {
            platformBreakdown[platform].examples.push({
              channel_id: channel.channel_id,
              channel_name: channel.channel_name,
              youtube_url: channel.youtube_url,
              evidence: channel.community_intents.filter(item => item.platform === platform),
              all_paid_evidence: channel.community_intents.filter(item => item.intent === 'PAID'),
            });
          }
        } else if (channel.classification === 'mixed') {
          platformBreakdown[platform].mixedPaidChannels += 1;
        }
      }
    }

    report.classificationTotals = {
      platform_only: platformOnlyTotal,
      creator_only: creatorOnlyTotal,
      mixed: mixedTotal,
      no_paid_evidence: noPaidEvidenceTotal,
    };
    report.platformBreakdown = platformBreakdown;
    report.evidenceMechanisms = mechanisms;

    // Source investigation for Steven Lord and the three observed platform URLs.
    const targetRes = await client.query(`
      SELECT channel_id, channel_name, youtube_url, subscriber_count, country,
             community_discovery_status, community_intents, discord_invite,
             discord_duplicate_owner_channel_id, last_checked
      FROM channels
      WHERE channel_name ILIKE '%steven lord%'
         OR community_intents::text ILIKE '%docs.whop.com%'
         OR community_intents::text ILIKE '%whop.com/careers%'
         OR community_intents::text ILIKE '%whop.com/blueprints%'
      ORDER BY channel_name ASC NULLS LAST, channel_id ASC
      LIMIT 100
    `);
    const targetIds = targetRes.rows.map(row => row.channel_id);
    let creatorLinks = [];
    let siteInspections = [];
    let observations = [];
    if (targetIds.length) {
      const linksRes = await client.query(`
        SELECT channel_id, site_identity, source_surface, source_url, first_seen, last_seen
        FROM creator_site_links
        WHERE channel_id = ANY($1::text[])
        ORDER BY channel_id ASC, last_seen DESC
      `, [targetIds]);
      creatorLinks = linksRes.rows;
      const identities = [...new Set(linksRes.rows.map(row => row.site_identity).filter(Boolean))];
      if (identities.length) {
        const sitesRes = await client.query(`
          SELECT site_identity, identity_tier, identity_basis, canonical_url, final_url,
                 outcome, source_channel_id, claim_status, community_intents, provenance,
                 observations, last_observed_at
          FROM site_inspections
          WHERE site_identity = ANY($1::text[])
          ORDER BY last_observed_at DESC
          LIMIT 100
        `, [identities]);
        siteInspections = sitesRes.rows;
      }
      const obsRes = await client.query(`
        SELECT channel_id, requested_url, final_url, outcome, retryable, failure_class,
               detail, provenance, observed_at
        FROM external_acquisition_observations
        WHERE channel_id = ANY($1::text[])
        ORDER BY observed_at DESC
        LIMIT 200
      `, [targetIds]);
      observations = obsRes.rows;
    }
    report.stevenLord = {
      matchedChannels: targetRes.rows.map(summariseChannel),
      creatorSiteLinks: creatorLinks,
      siteInspections: siteInspections.map(row => ({
        ...row,
        community_intents: safeIntents(row.community_intents),
        observations: Array.isArray(row.observations) ? row.observations.slice(0, 30) : [],
        provenance: row.provenance && typeof row.provenance === 'object' ? row.provenance : {},
      })),
      observations,
    };

    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    report.error = error instanceof Error ? { name: error.name, message: error.message, code: error.code } : String(error);
    console.error('[dashboard-investigation] failed:', error);
  } finally {
    await client.end().catch(() => undefined);
  }

  fs.writeFileSync(`${OUT_DIR}/community-intent-investigation.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    paidChannelCount: report.paidChannelCount,
    classificationTotals: report.classificationTotals,
    platformBreakdown: Object.fromEntries(Object.entries(report.platformBreakdown || {}).map(([platform, value]) => [platform, {
      channelsWithPaidPlatformEvidence: value.channelsWithPaidPlatformEvidence,
      platformOnlyPaidChannels: value.platformOnlyPaidChannels,
      mixedPaidChannels: value.mixedPaidChannels,
      platformPaidEvidence: value.platformPaidEvidence,
      creatorPaidEvidence: value.creatorPaidEvidence,
      examples: value.examples.map(example => example.channel_name),
    }])),
    stevenLordChannels: report.stevenLord?.matchedChannels?.map(channel => channel.channel_name),
    error: report.error || null,
  }, null, 2));
})();
