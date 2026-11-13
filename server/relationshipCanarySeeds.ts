import { enqueueJob, getAppSetting, getDb, setAppSetting } from './db';
import { assertCountryAllowed } from './countryExclusion';
import { canonicalCountry } from './countryInference';
import { DEFAULT_NON_DORMANT_COUNTRIES } from './queryQuality/profiles';
import { QUALITY_CREATOR_SCORE_THRESHOLD } from './queryPerformance';
import {
  RELATIONSHIP_CANARY_JOB_TYPE,
  validateRelationshipCanaryPayload,
  type RelationshipCanarySeed,
} from './relationshipCanary';

export const RELATIONSHIP_SEED_SWEEP_MAX_COUNTRIES = 2;
export const RELATIONSHIP_SEED_SWEEP_MAX_SEEDS = 5;
export const RELATIONSHIP_SEED_SWEEP_MAX_PLAYLISTS = 2;
export const RELATIONSHIP_SEED_COOLDOWN_DAYS = 30;

export interface RelationshipSeedSelection {
  country: string;
  seeds: RelationshipCanarySeed[];
}

/**
 * Select bounded high-quality seeds for the existing relationship canary.
 * Channels are real confirmed trading creators; playlists are only reused when
 * a governed research action already observed them for this country.
 */
export async function selectRelationshipCanarySeeds(
  country: string,
  options: { maxSeeds?: number; maxPlaylists?: number; cooldownDays?: number } = {},
): Promise<RelationshipSeedSelection> {
  const canonical = canonicalCountry(country);
  if (!canonical) return { country: canonical, seeds: [] };
  const maxSeeds = Math.max(1, Math.min(RELATIONSHIP_SEED_SWEEP_MAX_SEEDS, Math.trunc(options.maxSeeds ?? RELATIONSHIP_SEED_SWEEP_MAX_SEEDS)));
  const maxPlaylists = Math.max(0, Math.min(RELATIONSHIP_SEED_SWEEP_MAX_PLAYLISTS, Math.trunc(options.maxPlaylists ?? RELATIONSHIP_SEED_SWEEP_MAX_PLAYLISTS)));
  const cooldownDays = Math.max(1, Math.min(180, Math.trunc(options.cooldownDays ?? RELATIONSHIP_SEED_COOLDOWN_DAYS)));
  const db = await getDb();

  const channels = await db.query(
    `SELECT c.channel_id
     FROM channels c
     WHERE LOWER(c.country)=LOWER($1)
       AND c.trading_status='TRADING_CONFIRMED'
       AND c.country_status='CONFIRMED'
       AND c.quality_score >= $2
       AND COALESCE(c.scan_status,'') NOT IN ('FAILED_PERMANENT','SKIPPED_EXCLUDED')
       AND NOT EXISTS (
         SELECT 1 FROM jobs j
         WHERE j.type=$4
           AND j.created_at > now()-($5::text || ' days')::interval
           AND j.payload->'seeds' @> jsonb_build_array(jsonb_build_object('kind','channel','id',c.channel_id))
       )
     ORDER BY c.quality_score DESC, c.last_checked DESC NULLS LAST, c.channel_id ASC
     LIMIT $3`,
    [canonical, QUALITY_CREATOR_SCORE_THRESHOLD, maxSeeds, RELATIONSHIP_CANARY_JOB_TYPE, String(cooldownDays)],
  );

  const seeds: RelationshipCanarySeed[] = channels.rows.map(row => ({
    kind: 'channel' as const,
    id: String(row.channel_id),
  }));

  if (maxPlaylists > 0 && seeds.length < maxSeeds) {
    const playlists = await db.query(
      `SELECT DISTINCT regexp_replace(a.normalized_target,'^playlist:','') AS playlist_id
       FROM discovery_actions a
       WHERE a.action_type='INSPECT_PLAYLIST'
         AND UPPER(a.context->>'country')=UPPER($1)
         AND a.normalized_target LIKE 'playlist:%'
         AND NOT EXISTS (
           SELECT 1 FROM jobs j
           WHERE j.type=$3
             AND j.created_at > now()-($4::text || ' days')::interval
             AND j.payload->'seeds' @> jsonb_build_array(jsonb_build_object('kind','playlist','id',regexp_replace(a.normalized_target,'^playlist:','')))
         )
       ORDER BY playlist_id ASC
       LIMIT $2`,
      [canonical, Math.min(maxPlaylists, maxSeeds - seeds.length), RELATIONSHIP_CANARY_JOB_TYPE, String(cooldownDays)],
    ).catch(() => ({ rows: [] as Array<Record<string, unknown>> }));
    for (const row of playlists.rows) {
      const id = String(row.playlist_id || '').trim();
      if (id) seeds.push({ kind: 'playlist', id });
    }
  }

  return { country: canonical, seeds };
}

function selectedCountries(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(String).map(canonicalCountry).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Daily bounded seed sweep. It enqueues the existing relationship-canary job;
 * it never creates a new crawler, table, or query source. Default-inert until
 * relationship_canary_enabled is explicitly true.
 */
export async function sweepRelationshipCanarySeeds(now = new Date()): Promise<{
  status: 'DISABLED' | 'ALREADY_RAN' | 'NO_COUNTRIES' | 'COMPLETED';
  queued: number;
  countries: string[];
}> {
  const enabled = String(await getAppSetting('relationship_canary_enabled', 'false')).trim().toLowerCase() === 'true';
  if (!enabled) return { status: 'DISABLED', queued: 0, countries: [] };
  const day = now.toISOString().slice(0, 10);
  const lastDay = await getAppSetting('relationship_canary_seed_sweep_day', '');
  if (lastDay === day) return { status: 'ALREADY_RAN', queued: 0, countries: [] };

  const scope = String(await getAppSetting('query_intelligence_discovery_scope', 'GLOBAL') || 'GLOBAL').trim().toUpperCase();
  const configured = scope === 'SELECTED_COUNTRIES'
    ? selectedCountries(await getAppSetting('query_intelligence_selected_countries', ''))
    : [];
  const countries = [...new Set(configured.length ? configured : DEFAULT_NON_DORMANT_COUNTRIES)];
  if (!countries.length) return { status: 'NO_COUNTRIES', queued: 0, countries: [] };
  const cursor = Math.max(0, Number(await getAppSetting('relationship_canary_seed_cursor', '0')) || 0);
  const selected = Array.from({ length: Math.min(RELATIONSHIP_SEED_SWEEP_MAX_COUNTRIES, countries.length) }, (_, index) =>
    countries[(cursor + index) % countries.length],
  );

  let queued = 0;
  let failures = 0;
  const queuedCountries: string[] = [];
  for (const country of selected) {
    try {
      await assertCountryAllowed(country, 'relationship-canary:seed-sweep');
      const selection = await selectRelationshipCanarySeeds(country);
      if (!selection.seeds.length) continue;
      const cohortId = `seed:${country}:${day}`.normalize('NFKC').toLowerCase().replace(/[^a-z0-9:-]+/g, '-').slice(0, 80);
      const payload = validateRelationshipCanaryPayload({
        cohortId,
        targetCountry: country,
        seeds: selection.seeds,
        maxDepth: 1,
        maxFanout: 5,
        maxChannels: 50,
      });
      await enqueueJob(
        RELATIONSHIP_CANARY_JOB_TYPE,
        { ...payload },
        {
          idempotencyKey: `relationship-seed:${cohortId}:${day}`,
          priority: 5,
          maxAttempts: 2,
          preventReopen: true,
        },
      );
      queued += 1;
      queuedCountries.push(country);
    } catch {
      failures += 1;
      // A single country's provider/admission failure must not abort the sweep.
    }
  }
  // Do not burn the day's sweep when every selected country failed before a
  // durable enqueue. A later cycle may then retry the same cursor position.
  if (queued > 0 && failures === 0) {
    await setAppSetting('relationship_canary_seed_sweep_day', day).catch(() => undefined);
    await setAppSetting('relationship_canary_seed_cursor', String(cursor + selected.length)).catch(() => undefined);
  }
  return { status: 'COMPLETED', queued, countries: queuedCountries };
}
