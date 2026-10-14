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
import { sanitizedConnectionString, verifyStagingTarget } from './stagingTargetGuard';

// Single pool constructor for this script: the connection string is stripped
// of every TLS parameter first (proven: node-postgres lets URL parameters
// override an explicit `ssl` object), then paired with the verdict's explicit
// TLS configuration — no other TLS input can reach the opened connection.
function stagingPool(
  connectionString: string,
  ssl: false | { rejectUnauthorized: boolean } | undefined,
  extra?: Record<string, unknown>
) {
  return new pg.Pool({ connectionString: sanitizedConnectionString(connectionString), ssl, ...extra });
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
async function verifyStagingTargetOrThrow(connectionString: string): Promise<false | { rejectUnauthorized: boolean } | undefined> {
  const expectedToken = process.env.STAGING_PROOF_TOKEN;
  if (!expectedToken) throw new Error('Refusing to run: STAGING_PROOF_TOKEN is required (pairing token from staging provisioning).');
  const verdict = verifyStagingTarget(connectionString);
  if (!verdict.ok) throw new Error(`Refusing to run: ${verdict.reason} — never production.`);
  const probe = stagingPool(connectionString, verdict.ssl, { connectionTimeoutMillis: 15_000, query_timeout: 30_000 });
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

interface RunScope {
  createdChannels: string[];
  rawPhrases: string[];
  normPhrases: string[];
  countries: string[];
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
  const failures: string[] = [];
  {
    const termRows = await db.query(
      `SELECT id FROM canonical_trading_terms WHERE normalized_term = ANY($1) AND country = ANY($2)`,
      [scope.normPhrases, scope.countries]
    );
    const termIds = termRows.rows.map(row => Number(row.id));
    const vocabRows = await db.query(
      `SELECT id FROM extracted_trading_vocabulary WHERE term = ANY($1) AND country = ANY($2)`,
      [scope.rawPhrases, scope.countries]
    );
    const vocabIds = vocabRows.rows.map(row => Number(row.id));
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
const COUNTRY = 'Germany';
const ALIAS_COUNTRY = 'US';
const PHRASE = `e2e probe ${randomUUID().slice(0, 8)}`;
const DEMOTE_PHRASE = `e2e demote probe ${randomUUID().slice(0, 8)}`;
const ALIAS_PHRASE = `e2e alias probe ${randomUUID().slice(0, 8)}`;
const SCOPE_PHRASE = `e2e scope probe ${randomUUID().slice(0, 8)}`;
// Full-uuid run identity (32 hex): an 8-hex suffix leaves a 2^-32 birthday
// collision across runs sharing one staging database; full uuids make fixture
// identity unique in practice as well as by construction (RETURNING-gated).
const RUN = randomUUID().replace(/-/g, '');
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
// Fail fast: a failed leg throws, so dependent legs never run and no
// cascading writes follow a broken prerequisite.
function check(name: string, cond: boolean, evidence: unknown) {
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
  const targetSsl = await verifyStagingTargetOrThrow(connectionString);
  // Script-owned pool: every connection this run opens carries the verified
  // TLS configuration, and getDb() (with its own SSL semantics plus
  // migrations/seeds) is never touched.
  const pool = stagingPool(connectionString, targetSsl, { connectionTimeoutMillis: 15_000 });
  const db = pool;
  const scope: RunScope = {
    createdChannels: [],
    rawPhrases: [PHRASE, DEMOTE_PHRASE, ALIAS_PHRASE, SCOPE_PHRASE],
    normPhrases: [normalizeTerm(PHRASE), normalizeTerm(DEMOTE_PHRASE), normalizeTerm(ALIAS_PHRASE), normalizeTerm(SCOPE_PHRASE)],
    countries: [COUNTRY, 'United States'],
  };
  try {
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
  // Fixture identities must be novel for their intended countries: abort
  // when any pre-exists rather than reusing (and later deleting) another run's rows.
  const pre = await db.query(
    `SELECT normalized_term, country FROM canonical_trading_terms WHERE (normalized_term = ANY($1) AND country = ANY($2))`,
    [scope.normPhrases, scope.countries]
  );
  check('fixture identities novel', pre.rows.length === 0, { clashes: pre.rows });

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
  await db.query(`DELETE FROM extracted_trading_vocabulary WHERE term=$1`, [PHRASE]);
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

  console.log(`E2E PROOF COMPLETE (${passed} legs)`);
  } finally {
    try {
      await cleanupRunFixtures(db, scope);
    } finally {
      await pool.end().catch(() => undefined);
    }
  }
}

main().then(
  () => { process.exitCode = 0; },
  error => { console.error('E2E PROOF ERROR', error); process.exitCode = 1; }
);
