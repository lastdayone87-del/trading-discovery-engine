/**
 * Staging E2E proof for the terminology native-discovery loop (PR #522).
 *
 * Runs ONLY against a disposable staging database. Requires DATABASE_URL to
 * point at staging (refuses to run when STAGING_OK is not 'true' as a guard
 * against accidental production execution). Every leg executes production
 * functions against live PostgreSQL and asserts persisted evidence.
 *
 * Run: STAGING_OK=true DATABASE_URL=<staging> npx tsx scripts/terminologyStagingProof.ts
 *
 * Provisioning (once per staging database, before first run):
 *   npx tsx scripts/runMigrations.ts   (DATABASE_URL pointed at staging)
 *   CREATE TABLE staging_proof_marker(note text PRIMARY KEY, token text NOT NULL);
 *   INSERT INTO staging_proof_marker(note, token) VALUES('terminology-e2e-staging', '<random-token>');
 *   Run with STAGING_PROOF_TOKEN=<same-token>: the pre-init check compares it
 *   before any initializing connection, so a database that merely contains
 *   the marker row (e.g. a copy) still refuses without the pairing token.
 *   Run with STAGING_SYSTEM_IDENTIFIER=<pg_control_system() of staging> and
 *   (for non-loopback targets) STAGING_TARGET_ALLOWLIST=<host,...>.
 *
 * Quiescence requirement: run only against a staging database with no
 * workers pointed at it. The scripts refuse active queue work at startup
 * and fail loudly if any appears mid-run; they cannot prevent an operator
 * from starting workers against staging during verification.
 *
 * Non-coverage note: this proof exercises duplicate-observation suppression
 * (Leg 2), not removal of rule-admitted instruments from overlapping AI
 * candidates. That extraction-to-admission handoff has no automated coverage
 * (the extractor offers no AI seam), so it is tracked as a separate
 * unverified requirement and is not proven here.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  attributeTerminologyPerformance,
  getPlannerTerminology,
  normalizeTerm,
  observeTerminologyDetailed,
  refreshTerminologyLifecycle,
} from '../server/terminologyIntelligence';
import { assertStagingIdentity, pinLoopbackTarget, sanitizedConnectionString, tlsPoolConfig, verifyStagingTarget } from './stagingTargetGuard';
import type { StagingIdentity } from './stagingTargetGuard';

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
import { saveExtractedTerm, getExtractedVocabulary } from '../server/dbCore';
import { defaultReconcileExtractedTerm } from '../server/queryIntelligence';
import type { QueryRecord } from '../src/types';

// TLS configuration comes from the verified guard verdict (see
// scripts/stagingTargetGuard.ts): PGSSL=disable applies to loopback only;
// every non-loopback target uses fully verified TLS regardless of PGSSL.
function targetConnectionString(): string {
  if (process.env.STAGING_OK !== 'true' || !process.env.DATABASE_URL) {
    throw new Error('Refusing to run: set STAGING_OK=true and DATABASE_URL=<staging postgres> (never production).');
  }
  return process.env.DATABASE_URL;
}

// Target verification BEFORE any initializing connection: getDb() runs
// migrations and seedDefaults() (both write), so staging identity is proven
// here through a one-shot non-initializing pool. Three independent refusals,
// all fail-closed: (1) no pairing token configured; (2) non-loopback target
// without TLS (credentials must not travel plaintext — the provisioned
// topology is a localhost tunnel); (3) marker row absent or token mismatch
// (a copied marker row alone never authorizes). Timeouts bound the probe so
// a black-holed endpoint fails instead of hanging.
async function verifyStagingTargetOrThrow(
  connectionString: string
): Promise<{
  connectionString: string;
  tls: { ssl: false | { rejectUnauthorized: boolean } | undefined; caFile?: string };
  identity: StagingIdentity;
}> {
  const expectedToken = process.env.STAGING_PROOF_TOKEN;
  if (!expectedToken) throw new Error('Refusing to run: STAGING_PROOF_TOKEN is required (pairing token from staging provisioning).');
  const verdict = verifyStagingTarget(connectionString);
  if (!verdict.ok) throw new Error(`Refusing to run: ${verdict.reason} — never production.`);
  // Pin loopback hostnames to a verified loopback IP so later pools cannot
  // resolve the same name differently (DNS change between probe and work
  // pools). Remote targets keep the original hostname: their verified TLS
  // checks the certificate against that name.
  let pinned = connectionString;
  if (verdict.loopback) {
    pinned = (await pinLoopbackTarget(connectionString)).connectionString;
  }
  const probe = stagingPool(pinned, verdict, { connectionTimeoutMillis: 15_000, query_timeout: 30_000 });
  let tokenMatches = false;
  let activeJobs = -1;
  let clusterId: string | null = null;
  let serverAddr: string | null = null;
  let dbName = '';
  let probeError: unknown = null;
  try {
    const marker = await probe.query(`SELECT token FROM staging_proof_marker WHERE note='terminology-e2e-staging'`);
    tokenMatches = (marker.rows[0] as Record<string, unknown> | undefined)?.token === expectedToken;
    // Active (non-terminal) jobs only: COMPLETED/FAILED history rows must not
    // block verification, but live queue work does.
    const jobs = await probe.query(`SELECT count(*)::int n FROM jobs WHERE status NOT IN ('COMPLETED','FAILED')`);
    activeJobs = Number((jobs.rows[0] as Record<string, unknown> | undefined)?.n ?? -1);
    const sysid = await probe.query(`SELECT system_identifier::text AS sysid FROM pg_control_system()`);
    clusterId = String((sysid.rows[0] as Record<string, unknown> | undefined)?.sysid ?? '');
    const endpoint = await probe.query(`SELECT inet_server_addr()::text AS addr, current_database() AS db`);
    serverAddr = (endpoint.rows[0] as Record<string, unknown> | undefined)?.addr as string | null ?? null;
    dbName = String((endpoint.rows[0] as Record<string, unknown> | undefined)?.db ?? '');
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
  // Staging quiescence: these scripts require a worker-free database (fixture
  // channels must never be claimed by queue workers mid-run). Only ACTIVE
  // queue work refuses the run — COMPLETED/FAILED history is tolerated. The
  // provisioned staging database satisfies this.
  if (activeJobs !== 0) {
    throw new Error(`Refusing to run: jobs table has ${activeJobs} active rows — staging database must have no workers pointed at it.`);
  }
  // Cluster identity: a filesystem/container clone of staging carries the
  // marker row and token with it, so token comparison alone cannot tell a
  // clone from the provisioned database. The expected cluster identifier is
  // supplied out-of-band (never read from the target itself). Residual gap:
  // a clone inside the SAME cluster (e.g. another database) shares the
  // identifier and is not distinguished — see the provisioning notes.
  const expectedClusterId = process.env.STAGING_SYSTEM_IDENTIFIER;
  if (!expectedClusterId) throw new Error('Refusing to run: STAGING_SYSTEM_IDENTIFIER is required (cluster identity from staging provisioning).');
  if (clusterId !== expectedClusterId) {
    throw new Error('Refusing to run: cluster identifier mismatch — target is not the provisioned staging database (possible clone).');
  }
  return {
    connectionString: pinned,
    tls: { ssl: verdict.ssl, caFile: verdict.caFile },
    identity: { token: expectedToken, serverAddr, dbName, sysid: clusterId ?? '' },
  };
}

interface RunScope {
  createdChannels: string[];
  rawPhrases: string[];
  normPhrases: string[];
  countries: string[];
  preflightPassed: boolean;
}

// Best-effort removal of this run's fixtures, resolved by run-unique phrase
// identity plus intended country — never by bare id lists or unscoped text
// matching, so unrelated rows sharing a numeric id or a substring survive.
// Vocabulary-row ids are resolved first because source links reference them,
// not canonical-term ids. Only channels whose insert actually created a row
// are removed.
//
// Every step runs independently: one failing DELETE is recorded and the rest
// still execute. INJECT_CLEANUP_FAILURE=<step> forces a step to fail (staging
// fault drill). Any step failure — or leftover residue found afterwards —
// throws, so incomplete cleanup is never reported as successful.
const INJECTED_CLEANUP_FAILURE = process.env.INJECT_CLEANUP_FAILURE;
async function cleanupStep(
  failures: string[],
  name: string,
  fn: () => Promise<unknown>
): Promise<void> {
  try {
    if (INJECTED_CLEANUP_FAILURE === name) throw new Error(`injected cleanup failure at step ${name}`);
    await fn();
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
async function cleanupRunFixtures(
  db: { query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> },
  scope: RunScope
): Promise<void> {
  // Preflight-abort path: only RETURNING-created channels can exist (no
  // observation committed), so remove just those and never resolve or delete
  // term-scoped rows that belong to another run.
  if (!scope.preflightPassed) {
    if (scope.createdChannels.length > 0) {
      await db.query(`DELETE FROM channels WHERE channel_id = ANY($1)`, [scope.createdChannels])
        .then(() => console.log('cleanup: removed created channels after preflight abort'))
        .catch(error => { throw new Error(`cleanup incomplete (preflight-abort channel removal failed: ${error instanceof Error ? error.message : String(error)})`); });
    } else {
      console.log('cleanup: nothing created before preflight abort');
    }
    return;
  }
  const failures: string[] = [];
  {
    let termIds: number[] = [];
    let vocabIds: number[] = [];
    try {
      const termRows = await db.query(
        `SELECT id FROM canonical_trading_terms WHERE normalized_term = ANY($1) AND country = ANY($2)`,
        [scope.normPhrases, scope.countries]
      );
      termIds = termRows.rows.map(row => Number(row.id));
      const vocabRows = await db.query(
        `SELECT id FROM extracted_trading_vocabulary WHERE term = ANY($1) AND country = ANY($2)`,
        [scope.rawPhrases, scope.countries]
      );
      vocabIds = vocabRows.rows.map(row => Number(row.id));
    } catch (error) {
      failures.push(`resolve: ${error instanceof Error ? error.message : String(error)}`);
    }
    const byTerm = (table: string) => `DELETE FROM ${table} WHERE canonical_term_id = ANY($1)`;
    if (termIds.length > 0) {
      await cleanupStep(failures, 'observations', () => db.query(byTerm('terminology_observations'), [termIds]));
      await cleanupStep(failures, 'performance', () => db.query(byTerm('terminology_performance'), [termIds]));
      await cleanupStep(failures, 'lifecycle', () => db.query(byTerm('terminology_lifecycle_events'), [termIds]));
      await cleanupStep(failures, 'snapshots', () => db.query(byTerm('terminology_score_snapshots'), [termIds]));
      await cleanupStep(failures, 'aliases', () => db.query(byTerm('trading_term_aliases'), [termIds]));
      await cleanupStep(failures, 'projections', () => db.query(byTerm('country_native_evidence_projections'), [termIds]));
      await cleanupStep(failures, 'attribution', () => db.query(byTerm('country_native_performance_attribution'), [termIds]));
    }
    if (vocabIds.length > 0) {
      await cleanupStep(failures, 'links', () => db.query(`DELETE FROM extracted_vocabulary_sources WHERE term_id = ANY($1)`, [vocabIds]));
      await cleanupStep(failures, 'vocab', () => db.query(`DELETE FROM extracted_trading_vocabulary WHERE id = ANY($1)`, [vocabIds]));
    }
    if (termIds.length > 0) {
      await cleanupStep(failures, 'canonical', () => db.query(`DELETE FROM canonical_trading_terms WHERE id = ANY($1)`, [termIds]));
    }
    if (scope.createdChannels.length > 0) {
      await cleanupStep(failures, 'channels', () => db.query(`DELETE FROM channels WHERE channel_id = ANY($1)`, [scope.createdChannels]));
    }
    const residue = await db.query(
      `SELECT (SELECT COUNT(*) FROM extracted_trading_vocabulary WHERE term = ANY($1) AND country = ANY($2)) AS vocab,
              (SELECT COUNT(*) FROM canonical_trading_terms WHERE normalized_term = ANY($3) AND country = ANY($2)) AS terms,
              (SELECT COUNT(*) FROM channels WHERE channel_id = ANY($4)) AS channels`,
      [scope.rawPhrases, scope.countries, scope.normPhrases, scope.createdChannels]
    ).catch(() => ({ rows: [] as Array<Record<string, unknown>> }));
    const leftovers = residue.rows[0] as Record<string, unknown> | undefined;
    const remaining = leftovers ? Number(leftovers.vocab ?? 0) + Number(leftovers.terms ?? 0) + Number(leftovers.channels ?? 0) : -1;
    if (failures.length > 0 || remaining !== 0) {
      throw new Error(`cleanup incomplete (failures=[${failures.join('; ')}] remaining=${remaining})`);
    }
    console.log('cleanup: removed run fixtures, residue verified 0');
  }
}

// Durable run ownership: every run registers itself AFTER the novelty
// preflight passes, and marks completion at the end. A process crash between
// those points leaves an unfinished row; `--recover` cleans runs abandoned
// for over an hour (younger rows may still be alive) by re-resolving their
// run-unique fixture identity — the same scoping rules as normal cleanup,
// never broader. The registry table is staging-only tooling state.
type RunDb = { query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> };

async function ensureRunRegistry(db: RunDb): Promise<void> {
  await db.query(
    `CREATE TABLE IF NOT EXISTS staging_proof_runs(run_id TEXT PRIMARY KEY, kind TEXT NOT NULL, started_at TIMESTAMPTZ NOT NULL DEFAULT now(), finished_at TIMESTAMPTZ, status TEXT NOT NULL DEFAULT 'started')`
  );
}

async function registerRun(db: RunDb, runId: string, kind: string): Promise<void> {
  await ensureRunRegistry(db);
  await db.query(`INSERT INTO staging_proof_runs(run_id, kind) VALUES($1,$2) ON CONFLICT(run_id) DO NOTHING`, [runId, kind]);
}

async function finishRun(db: RunDb, runId: string, status: 'complete' | 'failed' | 'recovered' | 'recovery-failed'): Promise<void> {
  await db
    .query(`UPDATE staging_proof_runs SET finished_at=now(), status=$2 WHERE run_id=$1`, [runId, status])
    .catch(error => console.warn('run registry update failed (non-fatal)', error instanceof Error ? error.message : String(error)));
}

// Recovery entry point for `--recover` runs: abandoned run ids (unfinished
// for over an hour — younger rows may still be alive). Never throws for a
// missing registry (a staging database without it simply has nothing).
async function findAbandonedRuns(db: RunDb, kind: string): Promise<Array<{ runId: string }>> {
  const rows = await db
    .query(
      `SELECT run_id FROM staging_proof_runs WHERE kind=$1 AND finished_at IS NULL AND started_at < now() - interval '1 hour'`,
      [kind]
    )
    .catch(() => ({ rows: [] as Array<Record<string, unknown>> }));
  return (rows.rows as Array<Record<string, unknown>>)
    .map(row => String(row.run_id ?? ''))
    .filter(runId => runId.length >= 8)
    .map(runId => ({ runId }));
}

// Resolve one abandoned run's fixtures by its run-unique identity and remove
// them through the same scoped cleanup as normal runs, then mark it
// recovered. Returns leftover row counts for reporting.
async function recoverProofRun(db: RunDb, runId: string): Promise<number> {
  const terms = await db.query(
    `SELECT normalized_term, country FROM canonical_trading_terms WHERE normalized_term LIKE $1`, [`%${runId.toLowerCase()}%`]
  );
  const vocabs = await db.query(`SELECT term, country FROM extracted_trading_vocabulary WHERE term ILIKE $1`, [`%${runId}%`]);
  const chans = await db.query(`SELECT channel_id FROM channels WHERE channel_id LIKE $1`, [`%${runId}%`]);
  const scope: RunScope = {
    createdChannels: (chans.rows as Array<Record<string, unknown>>).map(row => String(row.channel_id)),
    rawPhrases: (vocabs.rows as Array<Record<string, unknown>>).map(row => String(row.term)),
    normPhrases: (terms.rows as Array<Record<string, unknown>>).map(row => String(row.normalized_term)),
    countries: [...new Set([
      ...(terms.rows as Array<Record<string, unknown>>).map(row => String(row.country)),
      ...(vocabs.rows as Array<Record<string, unknown>>).map(row => String(row.country)),
    ])],
    preflightPassed: true,
  };
  try {
    await cleanupRunFixtures(db, scope);
  } catch (error) {
    console.error(`recovery of run ${runId} incomplete`, error instanceof Error ? error.message : String(error));
  }
  const residue = await db.query(
    `SELECT (SELECT COUNT(*) FROM extracted_trading_vocabulary WHERE term ILIKE $1) AS vocab,
            (SELECT COUNT(*) FROM canonical_trading_terms WHERE normalized_term LIKE $2) AS terms,
            (SELECT COUNT(*) FROM channels WHERE channel_id LIKE $1) AS channels`,
    [`%${runId}%`, `%${runId.toLowerCase()}%`]
  ).catch(() => ({ rows: [] as Array<Record<string, unknown>> }));
  const leftovers = residue.rows[0] as Record<string, unknown> | undefined;
  const remaining = leftovers ? Number(leftovers.vocab ?? 0) + Number(leftovers.terms ?? 0) + Number(leftovers.channels ?? 0) : -1;
  await finishRun(db, runId, remaining === 0 ? 'recovered' : 'recovery-failed');
  return remaining;
}
const COUNTRY = 'Germany';
const ALIAS_COUNTRY = 'US';
// Full-uuid run identity (32 hex): an 8-hex suffix leaves a 2^-32 birthday
// collision across runs sharing one staging database; full uuids make fixture
// identity unique in practice as well as by construction (RETURNING-gated).
const RUN = randomUUID().replace(/-/g, '');
const PHRASE = `e2e probe ${RUN}`;
const DEMOTE_PHRASE = `e2e demote probe ${RUN}`;
const ALIAS_PHRASE = `e2e alias probe ${RUN}`;
const SCOPE_PHRASE = `e2e scope probe ${RUN}`;
const NATIVE_PHRASE = `e2e handelsstrategie ${RUN}`;
// Unique fixture IDs per run: no existing record is ever modified, and reruns
// never collide with prior fixtures on a reused staging database.
const CHANNELS = [1, 2, 3].map(i => `e2e-${RUN}-ch-${i}`);

function funnel(overrides: Record<string, number>): Record<string, number> {
  return {
    rawResults: 0, distinctResults: 0, duplicateResults: 0, knownChannels: 0, newChannels: 0,
    countryRejected: 0, nonTrading: 0, uncertain: 0, needsReview: 0, tradingConfirmed: 0,
    qualityChannels: 0, communitiesDiscovered: 0, averageQualityScore: 0, noveltyRatio: 0,
    countryPrecision: 0, tradingPrecision: 0, performanceScore: 0, ...overrides,
  };
}

let passed = 0;
// Set by the SIGINT/SIGTERM handler below: legs abort at the next check so
// an interrupted run stops writing before scoped cleanup runs.
let signalAborting = false;
// Fail fast: a failed leg throws, so dependent legs never run and no
// cascading writes follow a broken prerequisite.
function check(name: string, cond: boolean, evidence: unknown) {
  if (signalAborting) throw new Error('aborting: process signal received');
  if (!cond) throw new Error(`LEG FAILED: ${name} ${JSON.stringify(evidence)}`);
  passed += 1;
  console.log(`PASS ${name} ${JSON.stringify(evidence)}`);
}

function evidenceFor(channelId: string, videoId: string, phrase: string) {
  return {
    extractor: 'GEMINI', qualityVersion: 'native-v1', literal: true,
    sourceRef: { kind: 'VIDEO_TITLE', index: 0, span: phrase, videoId, sourceHash: `e2e-${videoId}` },
    novel: true, knownAs: null, generic: false, spamConfirmed: false, spamSignals: [],
    translationRisk: null,
  };
}

async function main() {
  const connectionString = targetConnectionString();
  const target = await verifyStagingTargetOrThrow(connectionString);
  // Script-owned pool on the PINNED connection string: every connection this
  // run opens carries the verified TLS configuration, and getDb() (with its
  // own SSL semantics plus migrations/seeds) is never touched.
  const pool = stagingPool(target.connectionString, target.tls, { connectionTimeoutMillis: 15_000, statement_timeout: 60_000 });
  // Endpoint re-verification: a DNS/routing change between the probe and this
  // pool would otherwise write to an unprobed database.
  await assertStagingIdentity(pool, target.identity);
  const db = pool;
  if (process.argv.includes('--recover')) {
    // Recovery mode: clean abandoned runs only, then exit. Full target
    // verification above still applies — recovery deletes data.
    try {
      const abandoned = await findAbandonedRuns(db, 'proof');
      let leftovers = 0;
      for (const run of abandoned) {
        leftovers += Math.max(0, await recoverProofRun(db, run.runId));
      }
      console.log(`recovery complete: ${abandoned.length} abandoned runs, ${leftovers} leftover rows`);
      process.exitCode = leftovers === 0 ? 0 : 1;
    } finally {
      await pool.end().catch(() => undefined);
    }
    return;
  }
  let shuttingDown = false;
  // First signal stops scheduling new writes: legs abort at the next check
  // and the main finally below runs the single scoped cleanup — the handler
  // itself never cleans up, so cleanup runs exactly once. A second signal
  // forces immediate exit (documented escape hatch if teardown itself hangs).
  const onSignal = (signal: 'SIGINT' | 'SIGTERM') => {
    if (shuttingDown) {
      console.error(`second ${signal}; forcing immediate exit`);
      process.exit(1);
    }
    shuttingDown = true;
    signalAborting = true;
    console.warn(`${signal} received; aborting legs — scoped cleanup runs in the main finally path`);
  };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));
  const scope: RunScope = {
    createdChannels: [],
    rawPhrases: [PHRASE, DEMOTE_PHRASE, ALIAS_PHRASE, SCOPE_PHRASE, NATIVE_PHRASE],
    normPhrases: [normalizeTerm(PHRASE), normalizeTerm(DEMOTE_PHRASE), normalizeTerm(ALIAS_PHRASE), normalizeTerm(SCOPE_PHRASE), normalizeTerm(NATIVE_PHRASE)],
    countries: [COUNTRY, 'United States'],
    preflightPassed: false,
  };
  let legError: unknown = null;
  try {
  // Fixture identities must be novel for their intended countries: abort
  // when any pre-exists rather than reusing (and later deleting) another
  // run's rows. Checked BEFORE any fixture insert so no unregistered row can
  // exist if this aborts — registration immediately follows, so every later
  // write belongs to a registered run. Covers canonical terms AND vocabulary
  // rows: an orphan vocab row (no canonical term) would otherwise be claimed
  // by the recovery leg and deleted by cleanup.
  const pre = await db.query(
    `SELECT normalized_term, country FROM canonical_trading_terms WHERE (normalized_term = ANY($1) AND country = ANY($2))`,
    [scope.normPhrases, scope.countries]
  );
  const preVocab = await db.query(
    `SELECT term, country FROM extracted_trading_vocabulary WHERE term = ANY($1) AND country = ANY($2)`,
    [scope.rawPhrases, scope.countries]
  );
  check('fixture identities novel', pre.rows.length === 0 && preVocab.rows.length === 0, { clashes: pre.rows, vocabClashes: preVocab.rows });
  scope.preflightPassed = true;
  await registerRun(db, RUN, 'proof');
  // Fixture creators: confirmed traders eligible for links, retry and trial.
  // Only ids whose insert actually creates a row are registered for cleanup,
  // so a pre-existing channel is never removed.
  for (const channelId of CHANNELS) {
    const inserted = await db.query(
      `INSERT INTO channels(channel_id,channel_name,youtube_url,country,country_status,discord_status,scan_status,discovery_source,first_seen,quality_score,trading_status)
       VALUES($1,$1,$2,$3,'CONFIRMED','UNKNOWN','PENDING','e2e-proof',now(),90,'TRADING_CONFIRMED')
       ON CONFLICT(channel_id) DO NOTHING RETURNING channel_id`,
      [channelId, `https://youtube.com/channel/${channelId}`, COUNTRY]
    );
    if (inserted.rows.length > 0) scope.createdChannels.push(channelId);
  }

  // Leg 1: observation + save.
  const first = await observeTerminologyDetailed({
    term: PHRASE, country: COUNTRY, termType: 'TERMINOLOGY', observationType: 'VIDEO_TITLE',
    channelId: CHANNELS[0], videoId: 'e2e-v1', communityFingerprint: 'e2e-fp-A', evidence: evidenceFor(CHANNELS[0], 'e2e-v1', PHRASE),
  }, pool);
  check('first observation inserted', first !== null && first.observationInserted === true, first);
  const termId = Number(first!.termId);
  await saveExtractedTerm(COUNTRY, PHRASE, 'terminology', CHANNELS[0], pool);
  let vocab = await db.query(`SELECT country,occurrences FROM extracted_trading_vocabulary WHERE term=$1`, [PHRASE]);
  check('vocab row under canonical country with count 1', vocab.rows[0]?.country === COUNTRY && Number(vocab.rows[0]?.occurrences) === 1, vocab.rows[0]);

  // Leg 2: dedupe — a replayed observation reconciles, never double-counts.
  const dup = await observeTerminologyDetailed({
    term: PHRASE, country: COUNTRY, termType: 'TERMINOLOGY', observationType: 'VIDEO_TITLE',
    channelId: CHANNELS[0], videoId: 'e2e-v1', communityFingerprint: 'e2e-fp-A', evidence: evidenceFor(CHANNELS[0], 'e2e-v1', PHRASE),
  }, pool);
  check('duplicate observation not re-inserted', dup !== null && dup.observationInserted === false, dup);
  const repair = await defaultReconcileExtractedTerm(COUNTRY, PHRASE, 'terminology', CHANNELS[0], pool);
  check('replay repair is a no-op on complete rows', repair.rowInserted === false && repair.linkInserted === false, repair);
  vocab = await db.query(`SELECT occurrences FROM extracted_trading_vocabulary WHERE term=$1`, [PHRASE]);
  check('occurrences still exact', Number(vocab.rows[0]?.occurrences) === 1, vocab.rows[0]);

  // Leg 3: trial — 5 more observations across 3 creators / 2 fingerprints.
  const extra: Array<[string, string, string]> = [
    [CHANNELS[0], 'e2e-v2', 'e2e-fp-A'], [CHANNELS[1], 'e2e-v3', 'e2e-fp-A'],
    [CHANNELS[1], 'e2e-v4', 'e2e-fp-A'], [CHANNELS[2], 'e2e-v5', 'e2e-fp-B'],
    [CHANNELS[2], 'e2e-v6', 'e2e-fp-B'],
  ];
  for (const [ch, vid, fp] of extra) {
    const obs = await observeTerminologyDetailed({
      term: PHRASE, country: COUNTRY, termType: 'TERMINOLOGY', observationType: 'VIDEO_TITLE',
      channelId: ch, videoId: vid, communityFingerprint: fp, evidence: evidenceFor(ch, vid, PHRASE),
    }, pool);
    // Production admit() persists the extracted row after every newly
    // inserted observation; the derived occurrence count converges there.
    if (obs !== null && obs.observationInserted) await saveExtractedTerm(COUNTRY, PHRASE, 'terminology', ch, pool);
  }
  await refreshTerminologyLifecycle(termId, undefined, pool);
  const term = await db.query(`SELECT lifecycle_status,search_eligible FROM canonical_trading_terms WHERE id=$1`, [termId]);
  check('term reaches SEARCH_TRIAL and is eligible', term.rows[0]?.lifecycle_status === 'SEARCH_TRIAL' && term.rows[0]?.search_eligible === true, term.rows[0]);
  vocab = await db.query(`SELECT occurrences FROM extracted_trading_vocabulary WHERE term=$1`, [PHRASE]);
  check('occurrences converged to 6', Number(vocab.rows[0]?.occurrences) === 6, vocab.rows[0]);

  // Leg 4: attribution + promotion + planner surfacing.
  const query = { generation_metadata: { learnedTerm: PHRASE }, country: COUNTRY } as unknown as QueryRecord;
  // inScopeNewChannels (6) below newChannels (10): expected credit is 6/12.
  // Quota 300/run keeps the promotion bar margin identical to the unscoped
  // fixture (1.5/900*1000 = 1.667 against MIN_YIELD_PER_1000_QUOTA=1.0).
  const goodRun = funnel({ rawResults: 20, distinctResults: 12, knownChannels: 2, newChannels: 10, inScopeNewChannels: 6, tradingConfirmed: 10, qualityChannels: 8, communitiesDiscovered: 2, averageQualityScore: 80, noveltyRatio: 0.8, countryPrecision: 1, tradingPrecision: 0.9, performanceScore: 85 });
  for (let i = 0; i < 3; i++) {
    await attributeTerminologyPerformance(query, goodRun as never, 300, undefined, undefined, pool);
  }
  // Scoped-yield probe on an isolated term: a fully out-of-scope run
  // (inScope 0 of 10 new) must earn exactly zero credit, and the good runs
  // above must carry scoped credit (0.5) rather than the newChannels
  // fallback (0.833) — a scope-weighting regression fails these checks.
  await observeTerminologyDetailed({
    term: SCOPE_PHRASE, country: COUNTRY, termType: 'TERMINOLOGY', observationType: 'VIDEO_TITLE',
    channelId: CHANNELS[0], videoId: 'e2e-scope-v1', evidence: evidenceFor(CHANNELS[0], 'e2e-scope-v1', SCOPE_PHRASE),
  }, pool);
  const scopeQuery = { generation_metadata: { learnedTerm: SCOPE_PHRASE }, country: COUNTRY } as unknown as QueryRecord;
  await attributeTerminologyPerformance(scopeQuery, funnel({ rawResults: 10, distinctResults: 10, newChannels: 10, inScopeNewChannels: 0 }) as never, 100, undefined, undefined, pool);
  const scopePerf = await db.query(
    `SELECT decayed_yield_score FROM terminology_performance WHERE canonical_term_id=(SELECT id FROM canonical_trading_terms WHERE normalized_term=$1 AND country=$2)`,
    [normalizeTerm(SCOPE_PHRASE), COUNTRY]
  );
  check('out-of-scope discoveries earn zero yield', Number(scopePerf.rows[0]?.decayed_yield_score) === 0, scopePerf.rows[0]);
  const goodPerf = await db.query(`SELECT decayed_yield_score FROM terminology_performance WHERE canonical_term_id=$1 ORDER BY id`, [termId]);
  const goodYields = goodPerf.rows.map(row => Number((row as Record<string, unknown>).decayed_yield_score));
  check('good runs carry scoped credit', goodYields.length === 3 && goodYields.every(y => Math.abs(y - 0.5) < 1e-4), goodYields);
  const promoted = await db.query(`SELECT lifecycle_status FROM canonical_trading_terms WHERE id=$1`, [termId]);
  check('term promotes to PROVEN_SEARCH_TERM', promoted.rows[0]?.lifecycle_status === 'PROVEN_SEARCH_TERM', promoted.rows[0]);
  const plannerTerms = await getPlannerTerminology(COUNTRY, pool);
  check('planner surfaces the proven term', plannerTerms.some(entry => entry.id === termId), { count: plannerTerms.length });

  // Leg 5: demotion on sustained poor yield (history retained). A fresh
  // term isolates demotion from the promotion ledger above: zero-result
  // attributions carry yield 0, so six executions must demote per policy.
  const demoteVids = ['e2e-d1', 'e2e-d2', 'e2e-d3', 'e2e-d4', 'e2e-d5', 'e2e-d6'];
  for (let i = 0; i < demoteVids.length; i++) {
    const ch = CHANNELS[i % CHANNELS.length];
    await observeTerminologyDetailed({
      term: DEMOTE_PHRASE, country: COUNTRY, termType: 'TERMINOLOGY', observationType: 'VIDEO_TITLE',
      channelId: ch, videoId: demoteVids[i], communityFingerprint: i % 2 === 0 ? 'e2e-fp-A' : 'e2e-fp-B',
      evidence: evidenceFor(ch, demoteVids[i], DEMOTE_PHRASE),
    }, pool);
  }
  const demoteTermRow = await db.query(`SELECT id FROM canonical_trading_terms WHERE normalized_term=$1 AND country=$2`, [DEMOTE_PHRASE.toLowerCase(), COUNTRY]);
  const demoteTermId = Number(demoteTermRow.rows[0]?.id);
  const demoteQuery = { generation_metadata: { learnedTerm: DEMOTE_PHRASE }, country: COUNTRY } as unknown as QueryRecord;
  const zeroRun = funnel({ averageQualityScore: 5, performanceScore: 2 });
  for (let i = 0; i < 6; i++) {
    await attributeTerminologyPerformance(demoteQuery, zeroRun as never, 1000, undefined, undefined, pool);
  }
  const demoted = await db.query(`SELECT lifecycle_status,search_eligible FROM canonical_trading_terms WHERE id=$1`, [demoteTermId]);
  check('term demotes and loses eligibility', demoted.rows[0]?.lifecycle_status === 'DEMOTED' && demoted.rows[0]?.search_eligible === false, demoted.rows[0]);
  const obsCount = await db.query(`SELECT COUNT(*)::int n FROM terminology_observations WHERE canonical_term_id=$1`, [demoteTermId]);
  check('observations retained after demotion', Number(obsCount.rows[0]?.n) >= 6, obsCount.rows[0]);

  // Leg 6: retry recovery — observation committed, save lost (crash window
  // simulated by removing the vocab row); the production retry repair must
  // restore the exact derived count. No mocks in the repair itself.
  const mainObs = await db.query(`SELECT COUNT(*)::int n FROM terminology_observations WHERE canonical_term_id=$1`, [termId]);
  await db.query(`DELETE FROM extracted_trading_vocabulary WHERE term=$1 AND country=$2`, [PHRASE, COUNTRY]);
  // Every observing channel reconciles: the lost row took all of its links.
  for (const ch of [CHANNELS[0], CHANNELS[1], CHANNELS[2]]) {
    await defaultReconcileExtractedTerm(COUNTRY, PHRASE, 'terminology', ch, pool);
  }
  const links = await db.query(
    `SELECT COUNT(*)::int n FROM extracted_vocabulary_sources WHERE term_id=(SELECT id FROM extracted_trading_vocabulary WHERE term=$1)`,
    [PHRASE]
  );
  check('all source-channel links restored', Number(links.rows[0]?.n) === 3, links.rows[0]);
  vocab = await db.query(`SELECT COUNT(*)::int rows, MAX(occurrences)::int occurrences FROM extracted_trading_vocabulary WHERE term=$1`, [PHRASE]);
  check('recovered occurrences exact and singular', Number(vocab.rows[0]?.rows) === 1 && Number(vocab.rows[0]?.occurrences) === Number(mainObs.rows[0]?.n), vocab.rows[0]);

  // Leg 7: country-alias write/read identity on live PostgreSQL.
  const aliasObs = await observeTerminologyDetailed({
    term: ALIAS_PHRASE, country: ALIAS_COUNTRY, termType: 'TERMINOLOGY', observationType: 'VIDEO_TITLE',
    channelId: CHANNELS[0], videoId: 'e2e-alias-v1', evidence: evidenceFor(CHANNELS[0], 'e2e-alias-v1', ALIAS_PHRASE),
  }, pool);
  check('alias observation inserted', aliasObs !== null && aliasObs.observationInserted === true, aliasObs);
  await saveExtractedTerm(ALIAS_COUNTRY, ALIAS_PHRASE, 'terminology', CHANNELS[0], pool);
  const viaAlias = await getExtractedVocabulary(ALIAS_COUNTRY, pool);
  const aliasEntry = viaAlias.find(entry => entry.term === ALIAS_PHRASE);
  check('alias read finds canonical row with count 1', aliasEntry?.country === 'United States' && aliasEntry?.occurrences === 1, aliasEntry ?? null);

  // Leg 8: native-evidence inference. A German-language observation from a
  // German creator must persist NATIVE_OBSERVED provenance (not merely
  // survive classification), with a matching evidence projection row.
  const nativeObs = await observeTerminologyDetailed({
    term: NATIVE_PHRASE, country: COUNTRY, termType: 'TERMINOLOGY', observationType: 'VIDEO_TITLE',
    channelId: CHANNELS[0], videoId: 'e2e-native-v1', language: 'de', locale: 'de-DE',
    sourceCreatorCountry: COUNTRY, evidence: evidenceFor(CHANNELS[0], 'e2e-native-v1', NATIVE_PHRASE),
  }, pool);
  check('native observation inserted', nativeObs !== null && nativeObs.observationInserted === true, nativeObs);
  const nativeTermId = Number(nativeObs!.termId);
  const nativeRow = await db.query(
    `SELECT native_evidence_status, source_provenance_family FROM terminology_observations WHERE canonical_term_id=$1 ORDER BY id DESC LIMIT 1`,
    [nativeTermId]
  );
  check('native provenance persisted', nativeRow.rows[0]?.native_evidence_status === 'NATIVE_OBSERVED' && nativeRow.rows[0]?.source_provenance_family === 'CREATOR_METADATA', nativeRow.rows[0]);
  const nativeProj = await db.query(
    `SELECT native_observed_count, native_evidence_status, source_provenance_family FROM country_native_evidence_projections WHERE canonical_term_id=$1`, [nativeTermId]
  );
  check(
    'native projection recomputed',
    nativeProj.rows.length === 1 && Number(nativeProj.rows[0]?.native_observed_count ?? 0) >= 1 && nativeProj.rows[0]?.native_evidence_status === 'NATIVE_OBSERVED',
    nativeProj.rows[0] ?? null
  );

  // End-quiescence: no queue worker may have acted mid-run. Active work now
  // fails the run loudly instead of passing silently.
  const endJobs = await db.query(`SELECT count(*)::int n FROM jobs WHERE status NOT IN ('COMPLETED','FAILED')`);
  check('staging stayed worker-free', Number(endJobs.rows[0]?.n) === 0, endJobs.rows[0]);

  console.log(`E2E PROOF COMPLETE (${passed} legs)`);
  } catch (error) {
    // A leg/check failure is captured, not lost: cleanup still runs below,
    // and the original error propagates after pool shutdown instead of being
    // replaced by a cleanup failure (both are reported).
    legError = error;
  }
  let cleanupError: unknown = null;
  try {
    await cleanupRunFixtures(db, scope);
  } catch (error) {
    console.error('cleanup failed', error);
    cleanupError = error;
  }
  // Registry marking happens while the pool is still open (finishRun would
  // silently fail after pool.end), and 'complete' is recorded only when both
  // legs and cleanup succeeded — otherwise the run stays recoverable.
  if (legError === null && cleanupError === null) {
    await finishRun(db, RUN, 'complete');
  } else {
    await finishRun(db, RUN, 'failed');
  }
  await pool.end().catch(() => undefined);
  if (legError !== null) throw legError;
  if (cleanupError !== null) throw cleanupError;
}

main().then(
  () => { process.exitCode = 0; },
  error => { console.error('E2E PROOF ERROR', error); process.exitCode = 1; }
);
