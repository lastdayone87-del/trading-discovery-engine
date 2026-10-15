/**
 * Staging E2E proof for the terminology native-discovery loop (PR #522).
 *
 * Runs ONLY against a freshly provisioned disposable database: one
 * single-purpose Postgres container per run, migrated, verified, exercised,
 * then destroyed with proof of absence. Requires DATABASE_URL to point at
 * that database plus STAGING_OK=true as an explicit intent guard.
 *
 * Provisioning (per run, on the VPS host):
 *   PASS=$(openssl rand -hex 24); printf '%s' "$PASS" > /root/.term-run-pass; chmod 600 /root/.term-run-pass
 *   PORT=<free high port, 127.0.0.1 only>
 *   docker run -d --name term-proof-<id> -p 127.0.0.1:$PORT:5432 \
 *     -e POSTGRES_USER=postgres -e POSTGRES_DB=postgres \
 *     -e POSTGRES_PASSWORD_FILE=/run/secrets/pgpass \
 *     --mount type=bind,source=/root/.term-run-pass,target=/run/secrets/pgpass,readonly \
 *     -v term-proof-<id>-data:/var/lib/postgresql postgres:18-alpine
 *  Tunnel local $PORT to the VPS, then:
 *   DATABASE_URL=postgresql://postgres:$PASS@127.0.0.1:$PORT/postgres \
 *     npx tsx scripts/runMigrations.ts
 *   STAGING_OK=true DATABASE_URL=<same> npx tsx scripts/terminologyStagingProof.ts
 * Teardown (proof of absence required):
 *   docker rm -f term-proof-<id>; docker volume rm term-proof-<id>-data;
 *   shred -u /root/.term-run-pass; docker inspect fails; port refused.
 *  (Named volumes survive `docker rm -v`: remove them explicitly.)
 *
 * Why this is safe without marker/token/registry machinery: the target must
 * be an EMPTY freshly-migrated database (the probe refuses any terms or
 * channels), reachable only via an operator-created localhost tunnel with a
 * random single-run password. No queue worker can address it (workers point
 * at production; nothing else knows the port or password), so no quiescence
 * checks are needed — documented here instead of asserted. Fixture identity
 * is run-unique for log correlation, not for collision safety: a duplicate
 * fails loudly on plain inserts instead of being silently reconciled.
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
  // Fresh-database proof: a disposable staging database, migrated moments
  // ago by the operator, contains no terminology rows and no channels. Any
  // other content means this is NOT the disposable target — refuse before
  // writing anything. Queries that fail (e.g. unmigrated target) refuse via
  // the probe error below, never as an empty result.
  let serverAddr: string | null = null;
  let dbName = '';
  let probeError: unknown = null;
  let populated = -1;
  let nonce = '';
  try {
    const endpoint = await probe.query(`SELECT inet_server_addr()::text AS addr, current_database() AS db`);
    serverAddr = (endpoint.rows[0] as Record<string, unknown> | undefined)?.addr as string | null ?? null;
    dbName = String((endpoint.rows[0] as Record<string, unknown> | undefined)?.db ?? '');
    // Every table the legs write: terms, channels, vocabulary (orphans
    // included), observations, and links. Anything present means this is not
    // a fresh disposable database.
    const terms = await probe.query(`SELECT count(*)::int n FROM canonical_trading_terms`);
    const channels = await probe.query(`SELECT count(*)::int n FROM channels`);
    const vocab = await probe.query(`SELECT count(*)::int n FROM extracted_trading_vocabulary`);
    const observations = await probe.query(`SELECT count(*)::int n FROM terminology_observations`);
    const links = await probe.query(`SELECT count(*)::int n FROM extracted_vocabulary_sources`);
    populated = Number(terms.rows[0]?.n ?? -1) + Number(channels.rows[0]?.n ?? -1) + Number(vocab.rows[0]?.n ?? -1) + Number(observations.rows[0]?.n ?? -1) + Number(links.rows[0]?.n ?? -1);
    if (populated !== 0) {
      throw new Error('TARGET-POPULATED');
    }
    // Run nonce: re-checked on every work pool before its first write, so a
    // mid-run DNS flip lands on a database without the nonce and aborts
    // instead of writing elsewhere.
    nonce = randomUUID().replace(/-/g, '');
    await probe.query(`CREATE TABLE IF NOT EXISTS staging_run_nonce(run_id TEXT PRIMARY KEY)`);
    await probe.query(`INSERT INTO staging_run_nonce(run_id) VALUES($1) ON CONFLICT DO NOTHING`, [nonce]);
  } catch (error) {
    probeError = error;
  } finally {
    await probe.end().catch(() => undefined);
  }
  // Distinguish refusal causes so a dead tunnel is never misreported: real
  // connectivity/schema failures name themselves, while a populated target
  // gets the explicit freshness refusal.
  if (probeError !== null) {
    if (probeError instanceof Error && probeError.message === 'TARGET-POPULATED') {
      throw new Error(`Refusing to run: target database is not a fresh disposable database (terms/channels present) — refusing to write.`);
    }
    const detail = probeError instanceof Error ? `${probeError.name}: ${probeError.message}` : String(probeError);
    throw new Error(`Refusing to run: staging probe failed (${detail}) — verify the tunnel, migration, and staging database instead of retrying blindly.`);
  }
  return {
    connectionString: pinned,
    tls: { ssl: verdict.ssl, caFile: verdict.caFile },
    identity: { nonce, serverAddr, dbName },
  };
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
    console.warn(`${signal} received; aborting legs — pools close in the main finally path`);
  };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));
  let legError: unknown = null;
  try {
  // Fresh-database sanity: a disposable target holds no terminology rows at
  // all. This aborts before any write if the database is not fresh.
  const pre = await db.query(
    `SELECT normalized_term, country FROM canonical_trading_terms WHERE (normalized_term = ANY($1) AND country = ANY($2))`,
    [[normalizeTerm(PHRASE), normalizeTerm(DEMOTE_PHRASE), normalizeTerm(ALIAS_PHRASE), normalizeTerm(SCOPE_PHRASE), normalizeTerm(NATIVE_PHRASE)], [COUNTRY, 'United States']]
  );
  const preVocab = await db.query(
    `SELECT term, country FROM extracted_trading_vocabulary WHERE term = ANY($1) AND country = ANY($2)`,
    [[PHRASE, DEMOTE_PHRASE, ALIAS_PHRASE, SCOPE_PHRASE, NATIVE_PHRASE], [COUNTRY, 'United States']]
  );
  check('fixture identities novel', pre.rows.length === 0 && preVocab.rows.length === 0, { clashes: pre.rows, vocabClashes: preVocab.rows });
  // Fixture creators: confirmed traders eligible for links, retry and trial.
  // Plain inserts: a duplicate fails loudly — there is nothing legitimate to
  // conflict with on a disposable database.
  for (const channelId of CHANNELS) {
    await db.query(
      `INSERT INTO channels(channel_id,channel_name,youtube_url,country,country_status,discord_status,scan_status,discovery_source,first_seen,quality_score,trading_status)
       VALUES($1,$1,$2,$3,'CONFIRMED','UNKNOWN','PENDING','e2e-proof',now(),90,'TRADING_CONFIRMED')`,
      [channelId, `https://youtube.com/channel/${channelId}`, COUNTRY]
    );
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

  // (No end-quiescence check by design: no worker can address this
  // disposable database — see the header. The planner leg above already
  // proves the term reached a searchable lifecycle state.)

  console.log(`E2E PROOF COMPLETE (${passed} legs)`);
  } catch (error) {
    // A leg/check failure is captured, not lost: pool shutdown still runs
    // below, and the original error propagates after it instead of being
    // replaced (both are reported).
    legError = error;
  } finally {
    await pool.end().catch(() => undefined);
  }
  // No fixture cleanup here by design: every row this run wrote lives in its
  // disposable database, which the operator destroys after the run (verified
  // gone: container absent, port refused, volume removed).
  if (legError !== null) throw legError;
}

main().then(
  () => { process.exitCode = 0; },
  error => { console.error('E2E PROOF ERROR', error); process.exitCode = 1; }
);
