import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './db';
import { observeTerminologyDetailed } from './terminologyIntelligence';

const databaseUrl = process.env.PHASE10_POSTGRES_URL;

/**
 * Downstream proof for retained provider language: real language signals
 * reach observation classification, the native-evidence projection, and the
 * lifecycle — while unknown languages, generic instruments, and
 * English-in-foreign-context terms stay out of native/trial states.
 * Runs against a disposable database (drove by PHASE10_POSTGRES_URL); the
 * production database is never touched.
 */
test('provider language reaches native evidence, projection, and lifecycle gates', {
  skip: databaseUrl ? false : 'PHASE10_POSTGRES_URL is required for language-downstream coverage'
}, async () => {
  process.env.DATABASE_URL = databaseUrl!;
  process.env.PGSSL = 'disable';
  const db = await getDb();
  const suffix = `lng${Date.now().toString(36)}${process.pid}`;
  const channelId = `LANG_CH_${suffix}`;
  await db.query(
    `INSERT INTO channels(channel_id,channel_name,youtube_url,country,country_status,discord_status,scan_status,discovery_source,first_seen,quality_score,trading_status)
     VALUES($1,$1,$2,'Germany','CONFIRMED','UNKNOWN','PENDING','language-downstream',now(),90,'TRADING_CONFIRMED')`,
    [channelId, `https://youtube.com/channel/${channelId}`]
  );

  // (a) Genuine local term, German channel, de-DE locale: native evidence.
  const local = await observeTerminologyDetailed({
    term: `Saisonalität ${suffix}`, country: 'Germany', termType: 'TERMINOLOGY',
    observationType: 'VIDEO_TITLE', channelId, videoId: `v-local-${suffix}`,
    language: 'de', locale: 'de-DE', evidence: { extractor: 'TEST' }
  });
  assert.ok(local && local.observationInserted, 'local observation not inserted');
  const localRow = (await db.query(
    `SELECT term_language, native_evidence_status, source_provenance_family, is_code_switched
     FROM terminology_observations WHERE canonical_term_id=$1`, [local.termId]
  )).rows[0];
  assert.equal(localRow.term_language, 'de');
  assert.equal(localRow.native_evidence_status, 'NATIVE_OBSERVED');
  assert.equal(localRow.source_provenance_family, 'CREATOR_METADATA');
  assert.equal(localRow.is_code_switched, false);
  const localProj = (await db.query(
    `SELECT native_observed_count, native_evidence_status, native_proposal_eligible
     FROM country_native_evidence_projections WHERE canonical_term_id=$1`, [local.termId]
  )).rows[0];
  assert.ok(localProj, 'no projection row for native term');
  assert.equal(Number(localProj.native_observed_count), 1);
  assert.equal(localProj.native_evidence_status, 'NATIVE_OBSERVED');
  // Single creator: the proposal gate still requires ≥2 native creators.
  assert.equal(localProj.native_proposal_eligible, false);
  const localLife = (await db.query(
    `SELECT lifecycle_status, search_eligible FROM canonical_trading_terms WHERE id=$1`, [local.termId]
  )).rows[0];
  assert.equal(localLife.lifecycle_status, 'OBSERVED');
  assert.equal(localLife.search_eligible, false);
  const localEvents = await db.query(
    `SELECT count(*)::int n FROM terminology_lifecycle_events WHERE canonical_term_id=$1 AND to_status='OBSERVED'`,
    [local.termId]
  );
  assert.ok(Number(localEvents.rows[0]?.n) >= 1, 'no lifecycle event recorded');

  // (b) Unknown language: classification stays null, projection stays zero.
  const unk = await observeTerminologyDetailed({
    term: `Börsenprobe ${suffix}`, country: 'Germany', termType: 'TERMINOLOGY',
    observationType: 'VIDEO_TITLE', channelId, videoId: `v-unk-${suffix}`,
    evidence: { extractor: 'TEST' }
  });
  assert.ok(unk && unk.observationInserted, 'unknown-language observation not inserted');
  const unkRow = (await db.query(
    `SELECT term_language, native_evidence_status FROM terminology_observations WHERE canonical_term_id=$1`,
    [unk.termId]
  )).rows[0];
  assert.equal(unkRow.term_language, 'und');
  assert.equal(unkRow.native_evidence_status, null);
  const unkProj = (await db.query(
    `SELECT native_observed_count FROM country_native_evidence_projections WHERE canonical_term_id=$1`,
    [unk.termId]
  )).rows[0];
  assert.ok(!unkProj || Number(unkProj.native_observed_count) === 0, 'unknown language must not project native evidence');

  // (c) Known instrument in German context: observed, but stays out of trial.
  const inst = await observeTerminologyDetailed({
    term: `DAX ${suffix}`, country: 'Germany', termType: 'INSTRUMENT',
    observationType: 'VIDEO_TITLE', channelId, videoId: `v-inst-${suffix}`,
    language: 'de', locale: 'de-DE', evidence: { extractor: 'TEST', generic: true }
  });
  assert.ok(inst && inst.observationInserted, 'instrument observation not inserted');
  const instLife = (await db.query(
    `SELECT lifecycle_status, search_eligible FROM canonical_trading_terms WHERE id=$1`, [inst.termId]
  )).rows[0];
  assert.equal(instLife.lifecycle_status, 'OBSERVED');
  assert.equal(instLife.search_eligible, false);

  // (d) English finance term in German context: code-switched, never native.
  const cs = await observeTerminologyDetailed({
    term: `Breakout Wxy9 ${suffix}`, country: 'Germany', termType: 'TERMINOLOGY',
    observationType: 'VIDEO_TITLE', channelId, videoId: `v-cs-${suffix}`,
    language: 'de', locale: 'de-DE', evidence: { extractor: 'TEST' }
  });
  assert.ok(cs && cs.observationInserted, 'code-switched observation not inserted');
  const csRow = (await db.query(
    `SELECT term_language, native_evidence_status, is_code_switched FROM terminology_observations WHERE canonical_term_id=$1`,
    [cs.termId]
  )).rows[0];
  assert.equal(csRow.term_language, 'en');
  assert.equal(csRow.is_code_switched, true);
  assert.equal(csRow.native_evidence_status, null);
});
