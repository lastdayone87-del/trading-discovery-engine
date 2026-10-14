/**
 * Live-PostgreSQL vocabulary race verification (PR #522 follow-up).
 *
 * Proves the advisory-lock serialization and derived occurrence counts of
 * saveExtractedTerm / defaultReconcileExtractedTerm under genuine concurrent
 * connections — the requirement deterministic fakes cannot satisfy.
 *
 * Staging/disposable database only. Requires STAGING_OK=true and a writable
 * DATABASE_URL (or PHASE10_POSTGRES_URL). Migrations must already be applied
 * (npx tsx scripts/runMigrations.ts).
 *
 * Run: STAGING_OK=true DATABASE_URL=<staging> npx tsx scripts/terminologyVocabRace.ts
 *
 * Provisioning (once per staging database, before first run): same marker as
 * the E2E proof (see scripts/terminologyStagingProof.ts header); run with
 * STAGING_PROOF_TOKEN=<same-token>. The pre-init check compares the token
 * before any initializing connection, so a copied marker row alone never
 * authorizes.
 *
 * Race pools intentionally carry no query timeout: advisory-lock blocking
 * waits are the behavior under test, and a timeout would abort legitimate
 * contention. Connection establishment alone is bounded (15s).
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { normalizeTerm, observeTerminologyDetailed } from '../server/terminologyIntelligence';
import { sanitizedConnectionString, tlsPoolConfig, verifyStagingTarget } from './stagingTargetGuard';

// Single pool constructor for this script: the connection string is stripped
// of every TLS parameter first (proven: node-postgres lets URL parameters
// override an explicit `ssl` object), then paired with the verdict's explicit
// TLS configuration — no other TLS input can reach the opened connection.
function stagingPool(
  connectionString: string,
  tls: { ssl: false | { rejectUnauthorized: boolean } | undefined; caFile?: string },
  extra?: Record<string, unknown>
) {
  return new pg.Pool({ connectionString: sanitizedConnectionString(connectionString), ssl: tlsPoolConfig(tls), ...extra });
}

import { saveExtractedTerm } from '../server/dbCore';
import { defaultReconcileExtractedTerm } from '../server/queryIntelligence';

// TLS configuration comes from the verified guard verdict (see
// scripts/stagingTargetGuard.ts): PGSSL=disable applies to loopback only;
// every non-loopback target uses fully verified TLS regardless of PGSSL.
function targetConnectionString(): string {
  const connectionString = process.env.PHASE10_POSTGRES_URL || process.env.DATABASE_URL;
  if (process.env.STAGING_OK !== 'true' || !connectionString) {
    throw new Error('Refusing to run: set STAGING_OK=true and PHASE10_POSTGRES_URL (or DATABASE_URL) to a writable staging database (never production).');
  }
  return connectionString;
}

// Target verification BEFORE any initializing connection: getDb() runs
// migrations and seedDefaults() (both write), so staging identity is proven
// here through a one-shot non-initializing pool (guard verdict + pairing
// token, both fail-closed). Returns the verified TLS configuration for the
// pools below.
async function verifyStagingTargetOrThrow(connectionString: string): Promise<false | { rejectUnauthorized: boolean } | undefined> {
  const expectedToken = process.env.STAGING_PROOF_TOKEN;
  if (!expectedToken) throw new Error('Refusing to run: STAGING_PROOF_TOKEN is required (pairing token from staging provisioning).');
  const verdict = verifyStagingTarget(connectionString);
  if (!verdict.ok) throw new Error(`Refusing to run: ${verdict.reason} — never production.`);
  const probe = stagingPool(connectionString, verdict, { connectionTimeoutMillis: 15_000, query_timeout: 30_000 });
  let tokenMatches = false;
  let probeError: unknown = null;
  try {
    const marker = await probe.query(`SELECT token FROM staging_proof_marker WHERE note='terminology-e2e-staging'`);
    tokenMatches = (marker.rows[0] as Record<string, unknown> | undefined)?.token === expectedToken;
  } catch (error) {
    probeError = error;
  } finally {
    await probe.end().catch(() => undefined);
  }
  // Distinguish a failed probe (connectivity — fail closed) from a wrong
  // identity so a dead tunnel is never misreported as a token mismatch.
  if (probeError !== null) {
    const detail = probeError instanceof Error ? `${probeError.name}: ${probeError.message}` : String(probeError);
    throw new Error(`Refusing to run: staging probe failed (${detail}) — verify the tunnel and staging database instead of retrying blindly.`);
  }
  if (!tokenMatches) throw new Error('Refusing to run: staging pairing token mismatch — target is not the provisioned staging database.');
  return verdict.ssl;
}

const COUNTRY_ALIAS = 'US';
const COUNTRY_CANON = 'United States';
// Full-uuid run identity (32 hex): 8-hex suffixes collide across runs
// sharing one staging database with probability 2^-32 per pair; full uuids
// make fixture identity unique in practice as well as by construction.
const RUN = randomUUID().replace(/-/g, '');
const TERM = `race probe ${RUN}`;
// Equivalent spellings, one canonical identity: racers must collapse to a
// single vocabulary row no matter which surface form wins the insert race.
// Unique fixture IDs per run: no existing record is ever modified.
const SPELLINGS = [TERM, TERM.toUpperCase(), TERM.replace(/ /g, '  '), ` ${TERM} `];
const CHANNELS = [1, 2, 3, 4].map(i => `race-${RUN}-ch-${i}`);
const OBS_PER_CHANNEL = 1;

// pg typings omit EventEmitter.on for Pool (present at runtime — verified);
// route pool error subscriptions through this helper instead of fighting it.
function onPoolError(pool: InstanceType<typeof pg.Pool>, listener: (error: unknown) => void): void {
  (pool as unknown as { on: (event: 'error', listener: (error: unknown) => void) => void }).on('error', listener);
}

// Bounded wait: the loser timer is always cleared, so a fast operation never
// trips a stale timeout later (and never holds the event loop open).
async function bounded<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { onTimeout(); reject(new Error(`bounded wait expired after ${ms}ms`)); }, ms);
        (timer as unknown as { unref?: () => void }).unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

let passed = 0;
// Fail fast: a failed check throws, so no further writes follow a break.
function check(name: string, cond: boolean, evidence: unknown) {
  if (!cond) throw new Error(`CHECK FAILED: ${name} ${JSON.stringify(evidence)}`);
  passed += 1;
  console.log(`PASS ${name} ${JSON.stringify(evidence)}`);
}

interface RaceCleanupScope {
  normTerm: string;
  createdChannels: string[];
}

// Fixture cleanup, resolved by run-unique normalized identity plus intended
// country — never by bare id lists or unscoped text matching. Vocabulary-row
// ids are resolved first because source links reference them, not
// canonical-term ids. Only channels whose insert actually created a row are
// removed. Every step runs independently (INJECT_CLEANUP_FAILURE=<step>
// forces a fault for drills); any step failure or leftover residue throws so
// incomplete cleanup is never reported as successful.
async function cleanupRaceFixtures(
  db: { query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> },
  scope: RaceCleanupScope
): Promise<void> {
  const failures: string[] = [];
  const cleanupStep = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
    try {
      if (process.env.INJECT_CLEANUP_FAILURE === name) throw new Error(`injected cleanup failure at step ${name}`);
      await fn();
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const normTerm = scope.normTerm;
  // Resolution fallback: a lookup failure must not strand every later step.
  // Predicate deletes below still scope to this run's identity, and the
  // recorded failure keeps the exit nonzero.
  let ids: number[] = [];
  let vocabIds: number[] = [];
  try {
    const termRows = await db.query(
      `SELECT id FROM canonical_trading_terms WHERE normalized_term=$1 AND country=$2`, [normTerm, COUNTRY_CANON]
    );
    ids = termRows.rows.map(row => Number(row.id));
    const vocabRows = await db.query(
      `SELECT id FROM extracted_trading_vocabulary WHERE country=$1 AND lower(regexp_replace(trim(term), '\\s+', ' ', 'g')) = $2`,
      [COUNTRY_CANON, normTerm]
    );
    vocabIds = vocabRows.rows.map(row => Number(row.id));
  } catch (error) {
    failures.push(`resolve: ${error instanceof Error ? error.message : String(error)}`);
  }
  const byTerm = (table: string) => `DELETE FROM ${table} WHERE canonical_term_id = ANY($1)`;
  if (ids.length > 0) {
    await cleanupStep('observations', () => db.query(byTerm('terminology_observations'), [ids]));
    await cleanupStep('performance', () => db.query(byTerm('terminology_performance'), [ids]));
    await cleanupStep('lifecycle', () => db.query(byTerm('terminology_lifecycle_events'), [ids]));
    await cleanupStep('snapshots', () => db.query(byTerm('terminology_score_snapshots'), [ids]));
    await cleanupStep('aliases', () => db.query(byTerm('trading_term_aliases'), [ids]));
    await cleanupStep('projections', () => db.query(byTerm('country_native_evidence_projections'), [ids]));
    await cleanupStep('attribution', () => db.query(byTerm('country_native_performance_attribution'), [ids]));
  }
  if (vocabIds.length > 0) {
    await cleanupStep('links', () => db.query(`DELETE FROM extracted_vocabulary_sources WHERE term_id = ANY($1)`, [vocabIds]));
    await cleanupStep('vocab', () => db.query(`DELETE FROM extracted_trading_vocabulary WHERE id = ANY($1)`, [vocabIds]));
  }
  if (ids.length > 0) await cleanupStep('canonical', () => db.query(`DELETE FROM canonical_trading_terms WHERE id = ANY($1)`, [ids]));
  if (scope.createdChannels.length > 0) await cleanupStep('channels', () => db.query(`DELETE FROM channels WHERE channel_id = ANY($1)`, [scope.createdChannels]));
  const residue = await db.query(
    `SELECT (SELECT COUNT(*) FROM extracted_trading_vocabulary WHERE country=$1 AND lower(regexp_replace(trim(term), '\\s+', ' ', 'g')) = $2) AS vocab,
            (SELECT COUNT(*) FROM canonical_trading_terms WHERE normalized_term=$2 AND country=$1) AS terms,
            (SELECT COUNT(*) FROM channels WHERE channel_id = ANY($3)) AS channels`,
    [COUNTRY_CANON, normTerm, scope.createdChannels.length > 0 ? scope.createdChannels : ['']]
  ).catch(() => ({ rows: [] as Array<Record<string, unknown>> }));
  const leftovers = residue.rows[0] as Record<string, unknown> | undefined;
  const remaining = leftovers ? Number(leftovers.vocab ?? 0) + Number(leftovers.terms ?? 0) + Number(leftovers.channels ?? 0) : -1;
  if (failures.length > 0 || remaining !== 0) {
    throw new Error(`cleanup incomplete (failures=[${failures.join('; ')}] remaining=${remaining})`);
  }
  console.log('cleanup: removed run fixtures, residue verified 0');
}

async function main() {
  const connectionString = targetConnectionString();
  const targetSsl = await verifyStagingTargetOrThrow(connectionString);
  process.env.DATABASE_URL = connectionString!;
  // Script-owned pools (verified TLS): race writers each get a pool directly
  // (transaction-bound advisory locks), the main pool serves seeds/asserts,
  // and getDb() is never touched. application_name tags race backends so a
  // straggler timeout can terminate exactly those connections.
  const dbPool = stagingPool(connectionString, { ssl: targetSsl }, { connectionTimeoutMillis: 15_000 });
  onPoolError(dbPool, error => console.warn(`pool: database pool client error (${error})`));
  const db = dbPool;
  const createdChannels: string[] = [];
  const racers: Array<Promise<unknown>> = [];
  // Per-run application name: a straggler termination in one invocation can
  // never kill another concurrent run's writers sharing this database.
  const appName = `terminology-vocab-race-${RUN}`;
  const pools = [
    stagingPool(connectionString, { ssl: targetSsl }, { connectionTimeoutMillis: 15_000, application_name: appName }),
    stagingPool(connectionString, { ssl: targetSsl }, { connectionTimeoutMillis: 15_000, application_name: appName }),
  ];
  for (const pool of pools) {
    // Idle-client deaths must never crash the run; checked-out failures
    // surface through the writers' rejected promises below.
    onPoolError(pool, error => console.warn(`pool: race pool client error (${error})`));
  }
  // Shared shutdown, used by the preflight guard (which runs before the main
  // try/finally) and by the main finally alike.
  const closePools = () => bounded((async () => {
    await Promise.all(pools.map(pool => pool.end().catch(() => undefined)));
    await dbPool.end().catch(() => undefined);
  })(), 20_000, () => console.warn('cleanup: pool close timed out; proceeding to exit code')).catch(() => undefined);
  // Fixture-identity preflight FIRST: abort when this run's normalized term
  // already exists for the intended country, before any observation can
  // commit a row the run would then mistake for its own. Cleanup below is
  // skipped on preflight failure — the matching row belongs to another run
  // (or prior residue), never to this one, so deleting it would be wrong.
  let preflightPassed = false;
  try {
    const clash = await db.query(
      `SELECT id FROM canonical_trading_terms WHERE normalized_term=$1 AND country=$2`, [normalizeTerm(TERM), COUNTRY_CANON]
    );
    check('fixture identity novel', clash.rows.length === 0, { term: TERM });
    preflightPassed = true;
  } catch (error) {
    // Preflight runs before the main try/finally: close pools here so a
    // failed preflight exits with its error instead of hanging.
    await closePools();
    throw error;
  }
  let legError: unknown = null;
  try {
  for (const channelId of CHANNELS) {
    const inserted = await db.query(
      `INSERT INTO channels(channel_id,channel_name,youtube_url,country,country_status,discord_status,scan_status,discovery_source,first_seen,quality_score,trading_status)
       VALUES($1,$1,$2,$3,'CONFIRMED','UNKNOWN','PENDING','vocab-race',now(),90,'TRADING_CONFIRMED')
       ON CONFLICT(channel_id) DO NOTHING RETURNING channel_id`,
      [channelId, `https://youtube.com/channel/${channelId}`, COUNTRY_CANON]
    );
    if (inserted.rows.length > 0) createdChannels.push(channelId);
  }
  // Committed observation evidence all racers must converge to.
  for (const channelId of CHANNELS) {
    for (let v = 0; v < OBS_PER_CHANNEL; v++) {
      const videoId = `race-${channelId}-v${v}`;
      await observeTerminologyDetailed({
        term: TERM, country: COUNTRY_ALIAS, termType: 'TERMINOLOGY', observationType: 'VIDEO_TITLE',
        channelId, videoId,
        evidence: {
          extractor: 'GEMINI', qualityVersion: 'native-v1', literal: true,
          sourceRef: { kind: 'VIDEO_TITLE', index: 0, span: TERM, videoId, sourceHash: `race-${videoId}` },
          novel: true, knownAs: null, generic: false, spamConfirmed: false, spamSignals: [], translationRisk: null,
        },
      }, dbPool);
    }
  }
  const expected = await db.query(
    `SELECT COUNT(*)::int n FROM terminology_observations o JOIN canonical_trading_terms t ON t.id=o.canonical_term_id
     WHERE t.country=$1 AND t.normalized_term=$2`, [COUNTRY_CANON, normalizeTerm(TERM)]
  );
  const expectedCount = Number(expected.rows[0]?.n);
  check('race preconditions committed', expectedCount === CHANNELS.length * OBS_PER_CHANNEL, { expectedCount });

  // Genuine overlap: separate pools so advisory-lock blocking is real.
  // Bounded overall deadline (RACE_DEADLINE_MS): a wedged query rejects the
  // run instead of hanging it. Settlement is always awaited below — even on
  // failure — so cleanup never runs while writers are still in flight.
  const deadlineMs = Number(process.env.RACE_DEADLINE_MS || '180000');
  CHANNELS.forEach((channelId, i) => {
    // Pass each pool directly: the writers detect the Pool, pin lock, reads
    // and writes to one transaction-bound client, and hold the advisory lock
    // across the critical section — the serialization under test. Spellings
    // rotate so concurrently arriving surface forms must still converge.
    const runner = pools[i % pools.length];
    const spelling = SPELLINGS[i % SPELLINGS.length];
    racers.push(saveExtractedTerm(COUNTRY_ALIAS, spelling, 'terminology', channelId, runner as never));
    racers.push(saveExtractedTerm(COUNTRY_ALIAS, SPELLINGS[(i + 1) % SPELLINGS.length], 'terminology', channelId, runner as never));
    racers.push(defaultReconcileExtractedTerm(COUNTRY_ALIAS, SPELLINGS[(i + 2) % SPELLINGS.length], 'terminology', channelId, runner as never));
  });
  const settlement = racers.map((racer, index) => racer.then(
    () => ({ index, ok: true as const, error: null as unknown }),
    (error: unknown) => ({ index, ok: false as const, error })
  ));
  const deadline = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error(`race deadline exceeded after ${deadlineMs}ms with writers pending`)), deadlineMs);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
  const outcomes = await Promise.race([Promise.all(settlement), deadline]);
  const failed = outcomes.filter(outcome => !outcome.ok);
  check('all racers settled successfully', failed.length === 0, failed.map(entry => ({ index: entry.index, error: String(entry.error) })));

  // Exact fixture identity: intended country plus the SQL-normalized surface
  // form (lower/collapse/trim — exact for this ASCII spelling set). No
  // substring matching, so unrelated rows containing the run token can
  // neither hide a split nor fail the check.
  const rows = await db.query(
    `SELECT country,term,occurrences FROM extracted_trading_vocabulary WHERE country=$1 AND lower(regexp_replace(trim(term), '\\s+', ' ', 'g')) = $2`,
    [COUNTRY_CANON, normalizeTerm(TERM)]
  );
  check('exactly one vocabulary row across equivalent spellings', rows.rows.length === 1, rows.rows);
  check('row under canonical country', rows.rows[0]?.country === COUNTRY_CANON, rows.rows[0]);
  check('occurrences converged to committed evidence', Number(rows.rows[0]?.occurrences) === expectedCount, { got: rows.rows[0]?.occurrences, expectedCount });

  console.log(`VOCAB RACE COMPLETE (${passed} checks)`);
  } catch (error) {
    // A failed check is captured, not lost: teardown still runs below, and
    // the original error propagates after pool shutdown instead of being
    // replaced by a teardown failure (both are reported).
    legError = error;
  } finally {
    // Stragglers from a deadline breach settle here (bounded) before cleanup
    // touches fixtures. On timeout the race backends are terminated by
    // application_name: the server rolls back their transactions, so late
    // commits are impossible and cleanup cannot be followed by resurrected
    // rows. Any path through here after a failure stays exit-nonzero.
    let stragglers = false;
    await bounded(Promise.allSettled(racers), 30_000, () => { stragglers = true; }).catch(() => { stragglers = true; });
    if (stragglers) {
      // Cancel first: aborting the in-flight query rolls back that writer's
      // transaction while keeping its connection alive, so settlement errors
      // flow through promises instead of crashing the process on dead-client
      // 'error' events. Termination below is the last resort for backends
      // that ignore cancel (their connections die; pool error handlers above
      // absorb the fallout).
      const cancelled = await db.query(
        `SELECT count(*)::int n FROM (SELECT pg_cancel_backend(pid) AS cancelled FROM pg_stat_activity WHERE application_name=$1 AND pid<>pg_backend_pid()) s WHERE cancelled`,
        [appName]
      ).catch(() => ({ rows: [] as Array<Record<string, unknown>> }));
      console.warn(`cleanup: cancelled ${Number((cancelled.rows[0] as Record<string, unknown> | undefined)?.n ?? 0)} straggler backends; their transactions abort`);
      let stillStuck = false;
      await bounded(Promise.allSettled(racers), 15_000, () => { stillStuck = true; }).catch(() => { stillStuck = true; });
      if (stillStuck) {
        const killed = await db.query(
          `SELECT count(*)::int n FROM (SELECT pg_terminate_backend(pid) AS killed FROM pg_stat_activity WHERE application_name=$1 AND pid<>pg_backend_pid()) s WHERE killed`,
        [appName]
        ).catch(() => ({ rows: [] as Array<Record<string, unknown>> }));
        console.warn(`cleanup: terminated ${Number((killed.rows[0] as Record<string, unknown> | undefined)?.n ?? 0)} unresponsive backends; their transactions rolled back server-side`);
        await bounded(Promise.allSettled(racers), 15_000, () => console.warn('cleanup: writers still unsettled after termination')).catch(() => undefined);
        const remaining = await db.query(
          `SELECT count(*)::int n FROM pg_stat_activity WHERE application_name=$1 AND pid<>pg_backend_pid()`, [appName]
        ).catch(() => ({ rows: [] as Array<Record<string, unknown>> }));
        if (Number((remaining.rows[0] as Record<string, unknown> | undefined)?.n ?? 1) > 0) {
          throw new Error('cleanup unverified: race backends still alive after termination — fixtures left in place, inspect staging before rerunning');
        }
      }
    }
    let cleanupError: unknown = null;
    if (!preflightPassed) {
      console.warn('cleanup: skipped — preflight aborted before this run created any fixture');
    } else {
      try {
        await cleanupRaceFixtures(db, { normTerm: normalizeTerm(TERM), createdChannels });
      } catch (error) {
        cleanupError = error;
      }
    }
    // Bounded close (shared with the preflight guard above): runs even when
    // cleanup throws. Outer `timeout` remains the final backstop.
    await closePools();
    // Both errors are reported and the run exits nonzero either way, but a
    // failed check is never hidden behind a cleanup failure.
    if (cleanupError !== null) console.error('cleanup failed', cleanupError);
    if (legError !== null) throw legError;
    if (cleanupError !== null) throw cleanupError;
  }
}

main().then(
  () => { process.exitCode = 0; },
  error => { console.error('VOCAB RACE ERROR', error); process.exitCode = 1; }
);
