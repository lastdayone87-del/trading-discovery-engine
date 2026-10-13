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
import { getDb } from '../server/db';
import { observeTerminologyDetailed } from '../server/terminologyIntelligence';
import { saveExtractedTerm } from '../server/dbCore';
import { defaultReconcileExtractedTerm } from '../server/queryIntelligence';

function stagingSsl() {
  // Identical to the application pool (server/dbCore.ts getDb): PGSSL=disable
  // forces plaintext for tunnel-local staging; production negotiates TLS.
  return process.env.PGSSL === 'disable' ? false : process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined;
}

function targetConnectionString(): string {
  const connectionString = process.env.PHASE10_POSTGRES_URL || process.env.DATABASE_URL;
  if (process.env.STAGING_OK !== 'true' || !connectionString) {
    throw new Error('Refusing to run: set STAGING_OK=true and PHASE10_POSTGRES_URL (or DATABASE_URL) to a writable staging database (never production).');
  }
  return connectionString;
}

// Target verification BEFORE any initializing connection: getDb() runs
// migrations and seedDefaults() (both write), so staging identity is proven
// here through a one-shot non-initializing pool. Three independent refusals,
// all fail-closed: (1) no pairing token; (2) non-loopback target without TLS
// (the provisioned topology is a localhost tunnel); (3) marker row absent or
// token mismatch. Timeouts bound the probe so a black-holed endpoint fails.
async function verifyStagingTarget(connectionString: string): Promise<void> {
  const expectedToken = process.env.STAGING_PROOF_TOKEN;
  if (!expectedToken) throw new Error('Refusing to run: STAGING_PROOF_TOKEN is required (pairing token from staging provisioning).');
  let host = '';
  try { host = new URL(connectionString).hostname.toLowerCase(); } catch { host = ''; }
  const loopback = host === '' || host === 'localhost' || host === '127.0.0.1' || host === '::1';
  const wantsTls = /[?&]sslmode=(require|verify-ca|verify-full)(&|$)/.test(connectionString);
  if (!loopback && !wantsTls) {
    throw new Error(`Refusing to run: non-loopback target '${host}' without sslmode=require — refusing plaintext credentials.`);
  }
  const probe = new pg.Pool({ connectionString, ssl: stagingSsl(), connectionTimeoutMillis: 15_000, query_timeout: 30_000 });
  let ok = false;
  try {
    const marker = await probe.query(`SELECT token FROM staging_proof_marker WHERE note='terminology-e2e-staging'`);
    ok = (marker.rows[0] as Record<string, unknown> | undefined)?.token === expectedToken;
  } catch {
    ok = false;
  } finally {
    await probe.end().catch(() => undefined);
  }
  if (!ok) throw new Error('Refusing to run: staging pairing token mismatch — target is not the provisioned staging database.');
}

const COUNTRY_ALIAS = 'US';
const COUNTRY_CANON = 'United States';
const RUN = randomUUID().slice(0, 8);
const TERM = `race probe ${RUN}`;
// Equivalent spellings, one canonical identity: racers must collapse to a
// single vocabulary row no matter which surface form wins the insert race.
// Unique fixture IDs per run: no existing record is ever modified.
const SPELLINGS = [TERM, TERM.toUpperCase(), TERM.replace(/ /g, '  '), ` ${TERM} `];
const CHANNELS = [1, 2, 3, 4].map(i => `race-${RUN}-ch-${i}`);
const OBS_PER_CHANNEL = 1;

let passed = 0;
// Fail fast: a failed check throws, so no further writes follow a break.
function check(name: string, cond: boolean, evidence: unknown) {
  if (!cond) throw new Error(`CHECK FAILED: ${name} ${JSON.stringify(evidence)}`);
  passed += 1;
  console.log(`PASS ${name} ${JSON.stringify(evidence)}`);
}

async function main() {
  const connectionString = targetConnectionString();
  await verifyStagingTarget(connectionString);
  process.env.DATABASE_URL = connectionString!;
  const dbPool = await getDb();
  const db = dbPool;
  const pools = [
    new pg.Pool({ connectionString, ssl: stagingSsl(), connectionTimeoutMillis: 15_000 }),
    new pg.Pool({ connectionString, ssl: stagingSsl(), connectionTimeoutMillis: 15_000 }),
  ];
  try {
  for (const channelId of CHANNELS) {
    await db.query(
      `INSERT INTO channels(channel_id,channel_name,youtube_url,country,country_status,discord_status,scan_status,discovery_source,first_seen,quality_score,trading_status)
       VALUES($1,$1,$2,$3,'CONFIRMED','UNKNOWN','PENDING','vocab-race',now(),90,'TRADING_CONFIRMED')
       ON CONFLICT(channel_id) DO NOTHING`,
      [channelId, `https://youtube.com/channel/${channelId}`, COUNTRY_CANON]
    );
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
      });
    }
  }
  const expected = await db.query(
    `SELECT COUNT(*)::int n FROM terminology_observations o JOIN canonical_trading_terms t ON t.id=o.canonical_term_id
     WHERE t.country=$1 AND t.normalized_term=$2`, [COUNTRY_CANON, TERM.toLowerCase()]
  );
  const expectedCount = Number(expected.rows[0]?.n);
  check('race preconditions committed', expectedCount === CHANNELS.length * OBS_PER_CHANNEL, { expectedCount });

  // Genuine overlap: separate pools so advisory-lock blocking is real.
  const racers: Array<Promise<unknown>> = [];
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
  await Promise.all(racers);

  // RUN-bound ILIKE: only this run's spellings match (prior runs used other
  // ids), case-insensitively — the winning surface form may be the uppercased
  // spelling while RUN hex contains a-f (case-sensitive LIKE would miss it).
  const rows = await db.query(
    `SELECT country,term,occurrences FROM extracted_trading_vocabulary WHERE term ILIKE $1`, [`%${RUN}%`]
  );
  check('exactly one vocabulary row across equivalent spellings', rows.rows.length === 1, rows.rows);
  check('row under canonical country', rows.rows[0]?.country === COUNTRY_CANON, rows.rows[0]);
  check('occurrences converged to committed evidence', Number(rows.rows[0]?.occurrences) === expectedCount, { got: rows.rows[0]?.occurrences, expectedCount });

  console.log(`VOCAB RACE COMPLETE (${passed} checks)`);
  } finally {
    try {
      const termIds = (await db.query(`SELECT id FROM canonical_trading_terms WHERE normalized_term LIKE $1`, [`%${RUN.toLowerCase()}%`]).catch(() => ({ rows: [] as unknown[] }))).rows;
      const ids = (termIds as Array<Record<string, unknown>>).map(row => Number(row.id));
      if (ids.length > 0) {
        await db.query(`DELETE FROM terminology_observations WHERE canonical_term_id = ANY($1)`, [ids]);
        await db.query(`DELETE FROM extracted_vocabulary_sources WHERE term_id = ANY($1)`, [ids]);
        await db.query(`DELETE FROM terminology_performance WHERE canonical_term_id = ANY($1)`, [ids]);
      await db.query(`DELETE FROM terminology_score_snapshots WHERE canonical_term_id = ANY($1)`, [ids]);
      await db.query(`DELETE FROM trading_term_aliases WHERE canonical_term_id = ANY($1)`, [ids]);
      await db.query(`DELETE FROM country_native_evidence_projections WHERE canonical_term_id = ANY($1)`, [ids]);
      await db.query(`DELETE FROM country_native_performance_attribution WHERE canonical_term_id = ANY($1)`, [ids]);
        await db.query(`DELETE FROM terminology_lifecycle_events WHERE canonical_term_id = ANY($1)`, [ids]);
      }
      await db.query(`DELETE FROM extracted_trading_vocabulary WHERE term ILIKE $1`, [`%${RUN}%`]);
      if (ids.length > 0) await db.query(`DELETE FROM canonical_trading_terms WHERE id = ANY($1)`, [ids]);
      await db.query(`DELETE FROM channels WHERE channel_id = ANY($1)`, [CHANNELS]);
      console.log('cleanup: removed run fixtures');
    } catch (error) {
      console.warn('cleanup: fixture removal incomplete (ids are run-unique; later runs unaffected)', error);
    }
    await Promise.all(pools.map(pool => pool.end().catch(() => undefined)));
    await dbPool.end().catch(() => undefined);
  }
}

main().then(
  () => { process.exitCode = 0; },
  error => { console.error('VOCAB RACE ERROR', error); process.exitCode = 1; }
);
