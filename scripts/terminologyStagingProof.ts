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
 *   CREATE TABLE staging_proof_marker(note text PRIMARY KEY);
 *   INSERT INTO staging_proof_marker(note) VALUES('terminology-e2e-staging');
 *
 * Non-coverage note: this proof exercises duplicate-observation suppression
 * (Leg 2), not removal of rule-admitted instruments from overlapping AI
 * candidates. That extraction-to-admission handoff has no automated coverage
 * (the extractor offers no AI seam), so it is tracked as a separate
 * unverified requirement and is not proven here.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { getDb } from '../server/db';
import {
  attributeTerminologyPerformance,
  getPlannerTerminology,
  observeTerminologyDetailed,
  refreshTerminologyLifecycle,
} from '../server/terminologyIntelligence';
import { saveExtractedTerm, getExtractedVocabulary } from '../server/dbCore';
import { defaultReconcileExtractedTerm } from '../server/queryIntelligence';
import type { QueryRecord } from '../src/types';

function stagingSsl() {
  // Identical to the application pool (server/dbCore.ts getDb): PGSSL=disable
  // forces plaintext for tunnel-local staging; production negotiates TLS.
  return process.env.PGSSL === 'disable' ? false : process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined;
}

function targetConnectionString(): string {
  if (process.env.STAGING_OK !== 'true' || !process.env.DATABASE_URL) {
    throw new Error('Refusing to run: set STAGING_OK=true and DATABASE_URL=<staging postgres> (never production).');
  }
  return process.env.DATABASE_URL;
}

// Target verification BEFORE any initializing connection: getDb() runs
// migrations and seedDefaults() (both write), so the staging marker is
// checked here through a one-shot non-initializing pool. Any failure
// (including a missing marker table) refuses to run — fail closed.
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

const COUNTRY = 'Germany';
const ALIAS_COUNTRY = 'US';
const PHRASE = `e2e probe ${randomUUID().slice(0, 8)}`;
const DEMOTE_PHRASE = `e2e demote probe ${randomUUID().slice(0, 8)}`;
const ALIAS_PHRASE = `e2e alias probe ${randomUUID().slice(0, 8)}`;
const RUN = randomUUID().slice(0, 8);
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
  targetConnectionString();
  await verifyStagingTarget(process.env.DATABASE_URL!);
  const pool = await getDb();
  const db = pool;
  try {
  // Fixture creators: confirmed traders eligible for links, retry and trial.
  for (const channelId of CHANNELS) {
    await db.query(
      `INSERT INTO channels(channel_id,channel_name,youtube_url,country,country_status,discord_status,scan_status,discovery_source,first_seen,quality_score,trading_status)
       VALUES($1,$1,$2,$3,'CONFIRMED','UNKNOWN','PENDING','e2e-proof',now(),90,'TRADING_CONFIRMED')
       ON CONFLICT(channel_id) DO NOTHING`,
      [channelId, `https://youtube.com/channel/${channelId}`, COUNTRY]
    );
  }
  // Phrase must be genuinely novel on this database.
  const pre = await db.query(`SELECT id FROM canonical_trading_terms WHERE normalized_term=$1`, [PHRASE.toLowerCase()]);
  check('phrase novel', pre.rows.length === 0, { phrase: PHRASE });

  // Leg 1: observation + save.
  const first = await observeTerminologyDetailed({
    term: PHRASE, country: COUNTRY, termType: 'TERMINOLOGY', observationType: 'VIDEO_TITLE',
    channelId: CHANNELS[0], videoId: 'e2e-v1', communityFingerprint: 'e2e-fp-A', evidence: evidenceFor(CHANNELS[0], 'e2e-v1', PHRASE),
  });
  check('first observation inserted', first !== null && first.observationInserted === true, first);
  const termId = Number(first!.termId);
  await saveExtractedTerm(COUNTRY, PHRASE, 'terminology', CHANNELS[0]);
  let vocab = await db.query(`SELECT country,occurrences FROM extracted_trading_vocabulary WHERE term=$1`, [PHRASE]);
  check('vocab row under canonical country with count 1', vocab.rows[0]?.country === COUNTRY && Number(vocab.rows[0]?.occurrences) === 1, vocab.rows[0]);

  // Leg 2: dedupe — a replayed observation reconciles, never double-counts.
  const dup = await observeTerminologyDetailed({
    term: PHRASE, country: COUNTRY, termType: 'TERMINOLOGY', observationType: 'VIDEO_TITLE',
    channelId: CHANNELS[0], videoId: 'e2e-v1', communityFingerprint: 'e2e-fp-A', evidence: evidenceFor(CHANNELS[0], 'e2e-v1', PHRASE),
  });
  check('duplicate observation not re-inserted', dup !== null && dup.observationInserted === false, dup);
  const repair = await defaultReconcileExtractedTerm(COUNTRY, PHRASE, 'terminology', CHANNELS[0]);
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
    });
    // Production admit() persists the extracted row after every newly
    // inserted observation; the derived occurrence count converges there.
    if (obs !== null && obs.observationInserted) await saveExtractedTerm(COUNTRY, PHRASE, 'terminology', ch);
  }
  await refreshTerminologyLifecycle(termId);
  const term = await db.query(`SELECT lifecycle_status,search_eligible FROM canonical_trading_terms WHERE id=$1`, [termId]);
  check('term reaches SEARCH_TRIAL and is eligible', term.rows[0]?.lifecycle_status === 'SEARCH_TRIAL' && term.rows[0]?.search_eligible === true, term.rows[0]);
  vocab = await db.query(`SELECT occurrences FROM extracted_trading_vocabulary WHERE term=$1`, [PHRASE]);
  check('occurrences converged to 6', Number(vocab.rows[0]?.occurrences) === 6, vocab.rows[0]);

  // Leg 4: attribution + promotion + planner surfacing.
  const query = { generation_metadata: { learnedTerm: PHRASE }, country: COUNTRY } as unknown as QueryRecord;
  const goodRun = funnel({ rawResults: 20, distinctResults: 12, knownChannels: 2, newChannels: 10, tradingConfirmed: 10, qualityChannels: 8, communitiesDiscovered: 2, averageQualityScore: 80, noveltyRatio: 0.8, countryPrecision: 1, tradingPrecision: 0.9, performanceScore: 85 });
  for (let i = 0; i < 3; i++) {
    await attributeTerminologyPerformance(query, goodRun as never, 500);
  }
  const promoted = await db.query(`SELECT lifecycle_status FROM canonical_trading_terms WHERE id=$1`, [termId]);
  check('term promotes to PROVEN_SEARCH_TERM', promoted.rows[0]?.lifecycle_status === 'PROVEN_SEARCH_TERM', promoted.rows[0]);
  const plannerTerms = await getPlannerTerminology(COUNTRY);
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
    });
  }
  const demoteTermRow = await db.query(`SELECT id FROM canonical_trading_terms WHERE normalized_term=$1 AND country=$2`, [DEMOTE_PHRASE.toLowerCase(), COUNTRY]);
  const demoteTermId = Number(demoteTermRow.rows[0]?.id);
  const demoteQuery = { generation_metadata: { learnedTerm: DEMOTE_PHRASE }, country: COUNTRY } as unknown as QueryRecord;
  const zeroRun = funnel({ averageQualityScore: 5, performanceScore: 2 });
  for (let i = 0; i < 6; i++) {
    await attributeTerminologyPerformance(demoteQuery, zeroRun as never, 1000);
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
  const recovered = await defaultReconcileExtractedTerm(COUNTRY, PHRASE, 'terminology', CHANNELS[0]);
  check('retry repair restores row and link', recovered.rowInserted === true && recovered.linkInserted === true, recovered);
  vocab = await db.query(`SELECT COUNT(*)::int rows, MAX(occurrences)::int occurrences FROM extracted_trading_vocabulary WHERE term=$1`, [PHRASE]);
  check('recovered occurrences exact and singular', Number(vocab.rows[0]?.rows) === 1 && Number(vocab.rows[0]?.occurrences) === Number(mainObs.rows[0]?.n), vocab.rows[0]);

  // Leg 7: country-alias write/read identity on live PostgreSQL.
  const aliasObs = await observeTerminologyDetailed({
    term: ALIAS_PHRASE, country: ALIAS_COUNTRY, termType: 'TERMINOLOGY', observationType: 'VIDEO_TITLE',
    channelId: CHANNELS[0], videoId: 'e2e-alias-v1', evidence: evidenceFor(CHANNELS[0], 'e2e-alias-v1', ALIAS_PHRASE),
  });
  check('alias observation inserted', aliasObs !== null && aliasObs.observationInserted === true, aliasObs);
  await saveExtractedTerm(ALIAS_COUNTRY, ALIAS_PHRASE, 'terminology', CHANNELS[0]);
  const viaAlias = await getExtractedVocabulary(ALIAS_COUNTRY);
  const aliasEntry = viaAlias.find(entry => entry.term === ALIAS_PHRASE);
  check('alias read finds canonical row with count 1', aliasEntry?.country === 'United States' && aliasEntry?.occurrences === 1, aliasEntry ?? null);

  console.log(`E2E PROOF COMPLETE (${passed} legs)`);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main().then(
  () => { process.exitCode = 0; },
  error => { console.error('E2E PROOF ERROR', error); process.exitCode = 1; }
);
