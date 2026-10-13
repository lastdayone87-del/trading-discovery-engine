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
// migrations and seedDefaults() (both write), so the staging marker is
// checked here through a one-shot non-initializing pool. Fail closed.
async function verifyStagingTarget(connectionString: string): Promise<void> {
  const probe = new pg.Pool({ connectionString, ssl: stagingSsl() });
  let ok = false;
  try {
    const marker = await probe.query(`SELECT note FROM staging_proof_marker LIMIT 1`);
    ok = (marker.rows[0] as Record<string, unknown> | undefined)?.note === 'terminology-e2e-staging';
  } catch {
    ok = false;
  } finally {
    await probe.end().catch(() => undefined);
  }
  if (!ok) throw new Error('Refusing to run: target is not the provisioned staging database (marker check failed) — never production.');
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
  const pools = [new pg.Pool({ connectionString, ssl: stagingSsl() }), new pg.Pool({ connectionString, ssl: stagingSsl() })];
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
    await Promise.all(pools.map(pool => pool.end().catch(() => undefined)));
    await dbPool.end().catch(() => undefined);
  }
}

main().then(
  () => { process.exitCode = 0; },
  error => { console.error('VOCAB RACE ERROR', error); process.exitCode = 1; }
);
