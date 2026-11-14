import { SUPPORTED_PRODUCTION_COUNTRIES } from '../src/data/initial_countries';
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
         AND a.lifecycle='COMPLETED'
         AND EXISTS (
           SELECT 1 FROM discovery_action_outcomes o WHERE o.action_id=a.id
         )
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

export function parseSelectedCountries(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('DISCOVERY_SCOPE_SELECTION_MALFORMED');
  }
  if (!Array.isArray(parsed)) throw new Error('DISCOVERY_SCOPE_SELECTION_MALFORMED');
  // Match the authoritative parser: non-string entries are malformed, not
  // coercion targets. Only registered country identities can become seeds.
  if (parsed.some(entry => typeof entry !== 'string')) {
    throw new Error('DISCOVERY_SCOPE_SELECTION_MALFORMED');
  }
  const supported = new Set(SUPPORTED_PRODUCTION_COUNTRIES.map(canonicalCountry));
  return [...new Set((parsed as string[])
    .map(canonicalCountry)
    .filter(country => Boolean(country) && supported.has(country)))];
}

export interface RelationshipSeedRetryEntry {
  country: string;
  attempts: number;
}

export type RelationshipSeedSweepOutcome = {
  country: string;
  status: 'COMPLETED' | 'FAILED';
};

/**
 * Strict parser for the internal retry ledger. A malformed ledger is ignored
 * by the sweep (and replaced on the next successful write) rather than
 * blocking seed expansion forever.
 */
export function parseSeedRetryEntries(raw: string): RelationshipSeedRetryEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('RELATIONSHIP_SEED_RETRY_MALFORMED');
  }
  if (!Array.isArray(parsed)) throw new Error('RELATIONSHIP_SEED_RETRY_MALFORMED');
  const supported = new Set(SUPPORTED_PRODUCTION_COUNTRIES.map(canonicalCountry));
  const entries = new Map<string, RelationshipSeedRetryEntry>();
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('RELATIONSHIP_SEED_RETRY_MALFORMED');
    }
    const row = entry as Record<string, unknown>;
    if (typeof row.country !== 'string') throw new Error('RELATIONSHIP_SEED_RETRY_MALFORMED');
    const country = canonicalCountry(row.country);
    if (!supported.has(country)) continue;
    // The ledger is internal state. A missing/non-positive/non-integer attempt
    // count is corruption, not a reason to reset that country's retry budget.
    if (!Number.isSafeInteger(row.attempts) || Number(row.attempts) <= 0) {
      throw new Error('RELATIONSHIP_SEED_RETRY_MALFORMED');
    }
    entries.set(country, { country, attempts: Number(row.attempts) });
  }
  return [...entries.values()];
}

/**
 * One daily sweep window. The rotation cursor always advances past the
 * countries that were actually in the rotation window; failed countries are
 * carried in the retry ledger instead of being skipped. Retry countries are
 * processed before new rotation countries, and are dropped after a bounded
 * number of attempts so a permanently broken country cannot pin the sweep.
 *
 * Recording the day on every window preserves the daily bound. A failed
 * country is retried on the next day (not every autonomous cycle).
 */
export function nextSeedSweepState(input: {
  currentRetry: RelationshipSeedRetryEntry[];
  rotationCountries: string[];
  outcomes: RelationshipSeedSweepOutcome[];
  maxRetryAttempts?: number;
}): { cursorAdvance: number; retry: RelationshipSeedRetryEntry[] } {
  const maxAttempts = Math.max(1, Math.min(10, Math.trunc(input.maxRetryAttempts ?? 3)));
  const currentAttempts = new Map(input.currentRetry.map(entry => [entry.country, entry.attempts]));
  const retry = new Map(input.currentRetry.map(entry => [entry.country, entry]));
  for (const outcome of input.outcomes) {
    if (outcome.status === 'COMPLETED') {
      retry.delete(outcome.country);
      continue;
    }
    const attempts = (currentAttempts.get(outcome.country) ?? 0) + 1;
    if (attempts < maxAttempts) {
      retry.set(outcome.country, { country: outcome.country, attempts });
    } else {
      retry.delete(outcome.country);
    }
  }
  return {
    cursorAdvance: input.rotationCountries.length,
    retry: [...retry.values()],
  };
}

/**
 * Daily bounded seed sweep. It enqueues the existing relationship-canary job;
 * it never creates a new crawler, table, or query source. Default-inert until
 * relationship_canary_enabled is explicitly true.
 */
export async function sweepRelationshipCanarySeeds(now = new Date()): Promise<{
  status: 'DISABLED' | 'ALREADY_RAN' | 'NO_COUNTRIES' | 'INVALID_SCOPE' | 'COMPLETED';
  queued: number;
  countries: string[];
}> {
  const enabled = String(await getAppSetting('relationship_canary_enabled', 'false')).trim().toLowerCase() === 'true';
  const killSwitch = String(await getAppSetting('relationship_canary_kill_switch', 'true')).trim().toLowerCase() === 'true';
  if (!enabled || killSwitch) return { status: 'DISABLED', queued: 0, countries: [] };
  const day = now.toISOString().slice(0, 10);
  const lastDay = await getAppSetting('relationship_canary_seed_sweep_day', '');
  if (lastDay === day) return { status: 'ALREADY_RAN', queued: 0, countries: [] };

  const rawScope = await getAppSetting('query_intelligence_discovery_scope', 'GLOBAL');
  const scope = typeof rawScope === 'string' ? rawScope.trim().toUpperCase() : '';
  if (scope !== 'GLOBAL' && scope !== 'SELECTED_COUNTRIES') {
    return { status: 'INVALID_SCOPE', queued: 0, countries: [] };
  }
  let configured: string[] = [];
  if (scope === 'SELECTED_COUNTRIES') {
    try {
      configured = parseSelectedCountries(await getAppSetting('query_intelligence_selected_countries', '[]'));
    } catch {
      return { status: 'INVALID_SCOPE', queued: 0, countries: [] };
    }
    if (!configured.length) return { status: 'NO_COUNTRIES', queued: 0, countries: [] };
  }
  const countries = [...new Set(scope === 'SELECTED_COUNTRIES' ? configured : DEFAULT_NON_DORMANT_COUNTRIES)];
  if (!countries.length) return { status: 'NO_COUNTRIES', queued: 0, countries: [] };
  const cursor = Math.max(0, Number(await getAppSetting('relationship_canary_seed_cursor', '0')) || 0);
  const retryKey = 'relationship_canary_seed_retry';
  let currentRetry: RelationshipSeedRetryEntry[] = [];
  try {
    currentRetry = parseSeedRetryEntries(await getAppSetting(retryKey, '[]'));
  } catch {
    // Internal retry state is not operator input; a corrupt value must not
    // block the sweep. Replace it after this window.
    currentRetry = [];
  }
  // Prune retry entries for countries that are no longer in scope.
  const scopedRetry = currentRetry.filter(entry => countries.includes(entry.country));
  const retryCountries = scopedRetry.map(entry => entry.country);
  const usingRetry = retryCountries.length > 0;
  const rotationSelected = usingRetry
    ? []
    : Array.from({ length: Math.min(RELATIONSHIP_SEED_SWEEP_MAX_COUNTRIES, countries.length) }, (_, index) =>
        countries[(cursor + index) % countries.length],
      );
  const selected = usingRetry
    ? retryCountries.slice(0, RELATIONSHIP_SEED_SWEEP_MAX_COUNTRIES)
    : rotationSelected;

  let queued = 0;
  const outcomes: RelationshipSeedSweepOutcome[] = [];
  const queuedCountries: string[] = [];
  for (const country of selected) {
    try {
      await assertCountryAllowed(country, 'relationship-canary:seed-sweep');
      const selection = await selectRelationshipCanarySeeds(country);
      if (!selection.seeds.length) {
        // A completed selection with no eligible/cooldown seeds is progress.
        outcomes.push({ country, status: 'COMPLETED' });
        continue;
      }
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
      outcomes.push({ country, status: 'COMPLETED' });
    } catch (error: any) {
      if (error?.code === 'COUNTRY_EXCLUDED') {
        // Exclusion is permanent for this country; do not let it pin the
        // cursor or retry ledger forever.
        outcomes.push({ country, status: 'COMPLETED' });
        continue;
      }
      // A single country's provider/admission failure must not abort the
      // sweep, but it is recorded for a future day's retry window.
      outcomes.push({ country, status: 'FAILED' });
    }
  }
  const next = nextSeedSweepState({
    currentRetry: scopedRetry,
    rotationCountries: rotationSelected,
    outcomes,
  });
  // Persist retry state first: if this write fails, leave the day unrecorded
  // so the next cycle can retry rather than silently dropping the failures.
  await setAppSetting(retryKey, JSON.stringify(next.retry));
  await setAppSetting('relationship_canary_seed_sweep_day', day).catch(() => undefined);
  if (next.cursorAdvance > 0) {
    await setAppSetting('relationship_canary_seed_cursor', String(cursor + next.cursorAdvance)).catch(() => undefined);
  }
  return { status: 'COMPLETED', queued, countries: queuedCountries };
}
