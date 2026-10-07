/**
 * R6 trail-parsed replay, batched (READ-ONLY, no writes).
 * Exact live classifier against stored pre-acquisition signals in
 * channels.inspection_trail ([Crawling] URL + Context Match + Source).
 */
import { Pool } from 'pg';
import { classifyUrlRelevance } from '../server/acquisitionRelevance';
import { creatorWebsiteHostsFromLinks } from '../server/inspector';

const BATCH = 100;

function parseTrailSeeds(trailText: string): Array<{ url: string; source: string; contextMatches: boolean }> {
  const out: Array<{ url: string; source: string; contextMatches: boolean }> = [];
  const re = /\[Crawling\]\s+(\S+)\s+\([^)]*Context Match:\s*(true|false)[^)]*Source:\s*([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(trailText)) !== null) {
    out.push({ url: m[1], contextMatches: m[2] === 'true', source: (m[3] || '').trim() });
  }
  return out;
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, statement_timeout: 60000 });
  // Pre-aggregate observations once (narrow columns only).
  const found = await pool.query(
    `SELECT channel_id, requested_url FROM external_acquisition_observations
     WHERE observed_at >= now() - interval '7 days' AND outcome='FOUND'`,
  );
  const foundSet = new Set<string>();
  for (const r of found.rows) foundSet.add(`${r.channel_id}\u0000${String(r.requested_url)}`);
  const wrappers = await pool.query(
    `SELECT channel_id, requested_url, provenance->>'wrapperUrl' AS wrapper
     FROM external_acquisition_observations
     WHERE observed_at >= now() - interval '7 days' AND provenance->>'wrapperUrl' IS NOT NULL`,
  );
  const wrapperMap = new Map<string, string>();
  for (const r of wrappers.rows) {
    if (r.wrapper) wrapperMap.set(`${r.channel_id}\u0000${String(r.requested_url)}`, String(r.wrapper));
  }
  const total = await pool.query(
    `SELECT count(*)::int AS n FROM channels WHERE inspection_trail::text LIKE '%[Crawling]%'`,
  );
  const totalN: number = total.rows[0].n;
  let seeds = 0, blocked = 0, demoted = 0, eligible = 0;
  let foundBlocked: Array<{ channel: string; url: string; reason: string }> = [];
  let foundDemoted = 0, foundEligible = 0;
  const blockedDetails: Array<{ channel: string; url: string; source: string; reason: string }> = [];
  for (let offset = 0; offset < totalN; offset += BATCH) {
    const ch = await pool.query(
      `SELECT channel_id, inspection_trail::text AS trail FROM channels
       WHERE inspection_trail::text LIKE '%[Crawling]%'
       ORDER BY channel_id LIMIT $1 OFFSET $2`,
      [BATCH, offset],
    );
    for (const row of ch.rows) {
      const trailSeeds = parseTrailSeeds(String(row.trail || ''));
      if (!trailSeeds.length) continue;
      let canonical: Set<string> = new Set();
      try {
        canonical = new Set(creatorWebsiteHostsFromLinks(trailSeeds.filter(s => s.source === 'CHANNEL_LINKS').map(s => s.url)));
      } catch { canonical = new Set(); }
      for (const seed of trailSeeds) {
        seeds++;
        const key = `${row.channel_id}\u0000${seed.url}`;
        const decision = classifyUrlRelevance({
          url: seed.url, source: seed.source, contextMatches: seed.contextMatches,
          wrapperUrl: wrapperMap.get(key), creatorCanonicalHosts: canonical,
        });
        const isFound = foundSet.has(key);
        if (decision.tier === 'BLOCK') {
          blocked++;
          if (blockedDetails.length < 50) {
            blockedDetails.push({ channel: String(row.channel_id), url: seed.url, source: seed.source, reason: decision.reason });
          }
          if (isFound) foundBlocked.push({ channel: String(row.channel_id), url: seed.url, reason: decision.reason });
        } else if (decision.tier === 'DEMOTE') {
          demoted++;
          if (isFound) foundDemoted++;
        } else {
          eligible++;
          if (isFound) foundEligible++;
        }
      }
    }
  }
  console.log(JSON.stringify({
    window: '2026-09-30 20:07:07Z → 2026-10-07 20:07:07Z (trail-parsed exact rules)',
    channelsWithTrails: totalN, seeds, blocked, demoted, eligible,
    foundBlocked: foundBlocked.length, foundDemoted, foundEligible,
    blockedDetails, foundBlockedList: foundBlocked,
  }, null, 2));
  await pool.end();
  process.exit(0);
}

main().catch(err => { console.error(String(err)); process.exit(1); });
