/**
 * Staging E2E proof for the terminology native-discovery loop (PR #522).
 *
 * Runs ONLY against a disposable staging database. Requires DATABASE_URL to
 * point at staging (refuses to run when STAGING_OK is not 'true' as a guard
 * against accidental production execution). Every leg executes production
 * functions against live PostgreSQL and asserts persisted evidence.
 *
 * Run: STAGING_OK=true DATABASE_URL=<staging> npx tsx scripts/terminologyStagingProof.ts
 */
import { randomUUID } from 'node:crypto';
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

if (process.env.STAGING_OK !== 'true' || !process.env.DATABASE_URL) {
  console.error('Refusing to run: set STAGING_OK=true and DATABASE_URL=<staging postgres> (never production).');
  process.exit(2);
}

const COUNTRY = 'Germany';
const ALIAS_COUNTRY = 'US';
const PHRASE = `e2e probe ${randomUUID().slice(0, 8)}`;
const ALIAS_PHRASE = `e2e alias probe ${randomUUID().slice(0, 8)}`;
const CHANNELS = ['e2e-ch-1', 'e2e-ch-2', 'e2e-ch-3'];

let failures = 0;
function check(name: string, cond: boolean, evidence: unknown) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(evidence)}`);
  if (!cond) failures += 1;
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
  const db = await getDb();
  // Fixture creators: confirmed traders eligible for links, retry and trial.
  for (const channelId of CHANNELS) {
    await db.query(
      `INSERT INTO channels(channel_id,channel_name,youtube_url,country,country_status,discord_status,scan_status,discovery_source,first_seen,quality_score,trading_status)
       VALUES($1,$1,$2,$3,'CONFIRMED','UNKNOWN','PENDING','e2e-proof',now(),90,'TRADING_CONFIRMED')
       ON CONFLICT(channel_id) DO UPDATE SET trading_status='TRADING_CONFIRMED',quality_score=90,country_status='CONFIRMED'`,
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
    await observeTerminologyDetailed({
      term: PHRASE, country: COUNTRY, termType: 'TERMINOLOGY', observationType: 'VIDEO_TITLE',
      channelId: ch, videoId: vid, communityFingerprint: fp, evidence: evidenceFor(ch, vid, PHRASE),
    });
  }
  await refreshTerminologyLifecycle(termId);
  const term = await db.query(`SELECT lifecycle_status,search_eligible FROM canonical_trading_terms WHERE id=$1`, [termId]);
  check('term reaches SEARCH_TRIAL and is eligible', term.rows[0]?.lifecycle_status === 'SEARCH_TRIAL' && term.rows[0]?.search_eligible === true, term.rows[0]);
  vocab = await db.query(`SELECT occurrences FROM extracted_trading_vocabulary WHERE term=$1`, [PHRASE]);
  check('occurrences converged to 6', Number(vocab.rows[0]?.occurrences) === 6, vocab.rows[0]);

  // Leg 4: attribution + promotion + planner surfacing.
  const query = { generation_metadata: { learnedTerm: PHRASE }, country: COUNTRY } as unknown as QueryRecord;
  for (let i = 0; i < 3; i++) {
    await attributeTerminologyPerformance(query, { rawResults: 20, distinctResults: 12, duplicateResults: 0, knownChannels: 2, newChannels: 10 }, 500);
  }
  const promoted = await db.query(`SELECT lifecycle_status FROM canonical_trading_terms WHERE id=$1`, [termId]);
  check('term promotes to PROVEN_SEARCH_TERM', promoted.rows[0]?.lifecycle_status === 'PROVEN_SEARCH_TERM', promoted.rows[0]);
  const plannerTerms = await getPlannerTerminology(COUNTRY);
  check('planner surfaces the proven term', plannerTerms.some(entry => entry.id === termId), { count: plannerTerms.length });

  // Leg 5: demotion on sustained poor yield (history retained).
  for (let i = 0; i < 6; i++) {
    await attributeTerminologyPerformance(query, { rawResults: 10, distinctResults: 10, duplicateResults: 0, knownChannels: 10, newChannels: 0 }, 1000);
  }
  const demoted = await db.query(`SELECT lifecycle_status,search_eligible FROM canonical_trading_terms WHERE id=$1`, [termId]);
  check('term demotes and loses eligibility', demoted.rows[0]?.lifecycle_status === 'DEMOTED' && demoted.rows[0]?.search_eligible === false, demoted.rows[0]);
  const obsCount = await db.query(`SELECT COUNT(*)::int n FROM terminology_observations WHERE canonical_term_id=$1`, [termId]);
  check('observations retained after demotion', Number(obsCount.rows[0]?.n) >= 6, obsCount.rows[0]);

  // Leg 6: retry recovery — observation committed, save lost (crash window
  // simulated by removing the vocab row); the production retry repair must
  // restore the exact derived count. No mocks in the repair itself.
  await db.query(`DELETE FROM extracted_trading_vocabulary WHERE term=$1`, [PHRASE]);
  const recovered = await defaultReconcileExtractedTerm(COUNTRY, PHRASE, 'terminology', CHANNELS[0]);
  check('retry repair restores row and link', recovered.rowInserted === true && recovered.linkInserted === true, recovered);
  vocab = await db.query(`SELECT COUNT(*)::int rows, MAX(occurrences)::int occurrences FROM extracted_trading_vocabulary WHERE term=$1`, [PHRASE]);
  check('recovered occurrences exact and singular', Number(vocab.rows[0]?.rows) === 1 && Number(vocab.rows[0]?.occurrences) === Number(obsCount.rows[0]?.n), vocab.rows[0]);

  // Leg 7: country-alias write/read identity on live PostgreSQL.
  const aliasObs = await observeTerminologyDetailed({
    term: ALIAS_PHRASE, country: ALIAS_COUNTRY, termType: 'TERMINOLOGY', observationType: 'VIDEO_TITLE',
    channelId: CHANNELS[0], videoId: 'e2e-alias-v1', evidence: evidenceFor(CHANNELS[0], 'e2e-alias-v1', ALIAS_PHRASE),
  });
  check('alias observation inserted', aliasObs !== null && aliasObs.observationInserted === true, aliasObs);
  await saveExtractedTerm(ALIAS_COUNTRY, ALIAS_PHRASE, 'terminology', CHANNELS[0]);
  const viaAlias = await getExtractedVocabulary(ALIAS_COUNTRY);
  check('alias read finds canonical row with count 1', viaAlias.length === 1 && viaAlias[0].country === 'United States' && viaAlias[0].occurrences === 1, viaAlias[0]);

  console.log(failures === 0 ? 'E2E PROOF COMPLETE' : `E2E PROOF FAILED (${failures} legs)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(error => { console.error('E2E PROOF ERROR', error); process.exit(1); });
