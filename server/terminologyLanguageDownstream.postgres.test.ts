import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './db';
import { observeTerminologyDetailed, readNativeQualityEvidence } from './terminologyIntelligence';

const databaseUrl = process.env.PHASE10_POSTGRES_URL;

/**
 * Disposable-database TLS policy: TLS is disabled only for explicit local
 * loopback databases (the approved disposable-container pattern). Remote
 * URLs keep the default TLS behavior so test traffic stays encrypted.
 */
function configureTestTls(databaseUrl: string): void {
  // Optional userinfo (user:pass@) precedes the host and carries no signal.
  if (/^postgres(ql)?:\/\/(?:[^@/]*@)?(localhost|127\.0\.0\.1|\[?::1\]?)([:/]|$)/i.test(databaseUrl)) {
    process.env.PGSSL = 'disable';
    return;
  }
  // Remote test databases keep TLS: only explicit sslmode=require (or
  // stronger) in the URL is accepted, letting the driver negotiate it.
  // Anything else fails closed instead of sending credentials in plaintext.
  const sslmode = /[?&]sslmode=([^&]*)/i.exec(databaseUrl)?.[1]?.toLowerCase();
  if (sslmode === 'require' || sslmode === 'verify-ca' || sslmode === 'verify-full') {
    delete process.env.PGSSL;
    return;
  }
  throw new Error('Refusing remote test database without explicit TLS (append ?sslmode=require or use a local disposable container).');
}

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
  configureTestTls(databaseUrl!);
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
    language: 'de', locale: 'de-DE',
    evidence: { extractor: 'TEST', qualityVersion: 'native-v1', literal: true, novel: true, knownAs: null, generic: false, spamConfirmed: false, spamSignals: [] }
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
    language: 'de', locale: 'de-DE',
    evidence: { extractor: 'KNOWN_INSTRUMENT_V1', qualityVersion: 'native-v1', literal: true, novel: false, knownAs: 'instrument:DAX', generic: true, spamConfirmed: false, spamSignals: [] }
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
    language: 'de', locale: 'de-DE',
    evidence: { extractor: 'TEST', qualityVersion: 'native-v1', literal: true, novel: true, knownAs: null, generic: false, spamConfirmed: false, spamSignals: [] }
  });
  assert.ok(cs && cs.observationInserted, 'code-switched observation not inserted');
  const csRow = (await db.query(
    `SELECT term_language, native_evidence_status, is_code_switched FROM terminology_observations WHERE canonical_term_id=$1`,
    [cs.termId]
  )).rows[0];
  assert.equal(csRow.term_language, 'en');
  assert.equal(csRow.is_code_switched, true);
  assert.equal(csRow.native_evidence_status, null);

  // (e) Trial-entry gate, eligible outcome: novel native-v1 evidence across
  // three creators and two communities (5 ENRICHMENT observations at weight
  // 1.25 clear the trial-evidence bar of 5 with margin for decay between
  // writes) enters SEARCH_TRIAL eligible.
  const trialChannels = [`TRIAL_A_${suffix}`, `TRIAL_B_${suffix}`, `TRIAL_C_${suffix}`];
  for (const trialChannel of trialChannels) {
    await db.query(
      `INSERT INTO channels(channel_id,channel_name,youtube_url,country,country_status,discord_status,scan_status,discovery_source,first_seen,quality_score,trading_status)
       VALUES($1,$1,$2,'Germany','CONFIRMED','UNKNOWN','PENDING','language-downstream',now(),90,'TRADING_CONFIRMED')`,
      [trialChannel, `https://youtube.com/channel/${trialChannel}`]
    );
  }
  const trialTerm = `Trialzugriff ${suffix}`;
  const trialPrints = ['comm-a', 'comm-a', 'comm-b', 'comm-b', 'comm-b'];
  const trialVideos = [1, 2, 3, 4, 5].map(n => `v-trial-${n}-${suffix}`);
  let trialTermId = 0;
  for (let i = 0; i < 5; i++) {
    const observed = await observeTerminologyDetailed({
      term: trialTerm, country: 'Germany', termType: 'TERMINOLOGY',
      observationType: 'ENRICHMENT', channelId: trialChannels[Math.min(i, 2)], videoId: trialVideos[i],
      communityFingerprint: trialPrints[i], language: 'de', locale: 'de-DE',
      evidence: { extractor: 'TEST', qualityVersion: 'native-v1', literal: true, novel: true, knownAs: null, generic: false, spamConfirmed: false, spamSignals: [] }
    });
    assert.ok(observed && observed.observationInserted, `trial observation ${i} not inserted`);
    trialTermId = observed.termId;
  }
  const trialQuality = await readNativeQualityEvidence(trialTermId, db);
  assert.equal(trialQuality.v1Observations, 5);
  assert.equal(trialQuality.novel, true);
  assert.equal(trialQuality.spamConfirmed, false);
  const trialLife = (await db.query(
    `SELECT lifecycle_status, search_eligible FROM canonical_trading_terms WHERE id=$1`, [trialTermId]
  )).rows[0];
  assert.equal(trialLife.lifecycle_status, 'SEARCH_TRIAL');
  assert.equal(trialLife.search_eligible, true);

  // (f) Trial-entry gate, ineligible outcome: identical evidence shape with
  // spam confirmation is blocked from trial despite meeting legacy bars.
  const spamTerm = `Spamzugriff ${suffix}`;
  let spamTermId = 0;
  for (let i = 0; i < 5; i++) {
    const observed = await observeTerminologyDetailed({
      term: spamTerm, country: 'Germany', termType: 'TERMINOLOGY',
      observationType: 'ENRICHMENT', channelId: trialChannels[Math.min(i, 2)], videoId: `v-spam-${i}-${suffix}`,
      communityFingerprint: trialPrints[i], language: 'de', locale: 'de-DE',
      evidence: { extractor: 'TEST', qualityVersion: 'native-v1', literal: true, novel: true, knownAs: null, generic: false, spamConfirmed: true, spamSignals: ['promotional'] }
    });
    assert.ok(observed && observed.observationInserted, `spam observation ${i} not inserted`);
    spamTermId = observed.termId;
  }
  const spamQuality = await readNativeQualityEvidence(spamTermId, db);
  assert.equal(spamQuality.v1Observations, 5);
  assert.equal(spamQuality.spamConfirmed, true);
  const spamLife = (await db.query(
    `SELECT lifecycle_status, search_eligible FROM canonical_trading_terms WHERE id=$1`, [spamTermId]
  )).rows[0];
  assert.equal(spamLife.search_eligible, false);
  assert.ok(spamLife.lifecycle_status !== 'SEARCH_TRIAL', 'spam-confirmed term must not trial');

  // (g) Reclassification converges: the same source (term, channel, video,
  // evidence substance) re-observed with unknown language and another
  // provider label updates the one row instead of inserting a duplicate, and
  // the projection drops the stale native count back to zero.
  const relocal = await observeTerminologyDetailed({
    term: `Saisonalität ${suffix}`, country: 'Germany', termType: 'TERMINOLOGY',
    observationType: 'VIDEO_TITLE', channelId, videoId: `v-local-${suffix}`,
    evidence: { extractor: 'OTHER', qualityVersion: 'native-v1', literal: true, novel: true, knownAs: null, generic: false, spamConfirmed: false, spamSignals: [] }
  });
  assert.ok(relocal, 're-observation failed');
  assert.equal(relocal.observationInserted, false);
  const relocalCount = await db.query(
    `SELECT count(*)::int n, max(native_evidence_status) AS status FROM terminology_observations WHERE canonical_term_id=$1`,
    [local.termId]
  );
  assert.equal(Number(relocalCount.rows[0]?.n), 1);
  assert.equal(relocalCount.rows[0]?.status, null);
  const relocalProj = await db.query(
    `SELECT native_observed_count FROM country_native_evidence_projections WHERE canonical_term_id=$1`,
    [local.termId]
  );
  // Zero-native projections are deleted outright: absence is the strongest
  // proof that no stale native evidence is retained.
  assert.ok(
    !relocalProj.rows[0] || Number(relocalProj.rows[0].native_observed_count) === 0,
    'stale native projection retained'
  );

  // (h) Canonical language reconciles forward from unknown, never backward
  // from concrete: und -> de on new evidence, then stays de on conflict.
  const nachTerm = `Nachzugriff ${suffix}`;
  await observeTerminologyDetailed({
    term: nachTerm, country: 'Germany', termType: 'TERMINOLOGY',
    observationType: 'VIDEO_TITLE', channelId, videoId: `v-und-${suffix}`,
    evidence: { extractor: 'TEST' }
  });
  const undCanon = (await db.query(
    `SELECT language FROM canonical_trading_terms WHERE normalized_term=$1 AND country='Germany'`,
    [nachTerm.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en')]
  )).rows[0];
  assert.equal(undCanon?.language, 'und');
  await observeTerminologyDetailed({
    term: nachTerm, country: 'Germany', termType: 'TERMINOLOGY',
    observationType: 'VIDEO_TITLE', channelId, videoId: `v-und2-${suffix}`,
    language: 'de', locale: 'de-DE',
    evidence: { extractor: 'TEST', qualityVersion: 'native-v1', literal: true, novel: true, knownAs: null, generic: false, spamConfirmed: false, spamSignals: [] }
  });
  const deCanon = (await db.query(
    `SELECT language FROM canonical_trading_terms WHERE normalized_term=$1 AND country='Germany'`,
    [nachTerm.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en')]
  )).rows[0];
  assert.equal(deCanon?.language, 'de');
  await observeTerminologyDetailed({
    term: nachTerm, country: 'Germany', termType: 'TERMINOLOGY',
    observationType: 'VIDEO_TITLE', channelId, videoId: `v-und3-${suffix}`,
    language: 'en', locale: 'en-US',
    evidence: { extractor: 'TEST' }
  });
  const keptCanon = (await db.query(
    `SELECT language FROM canonical_trading_terms WHERE normalized_term=$1 AND country='Germany'`,
    [nachTerm.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en')]
  )).rows[0];
  assert.equal(keptCanon?.language, 'de');
});

test('configureTestTls encrypts remote traffic by default', () => {
  const saved = process.env.PGSSL;
  try {
    configureTestTls('postgresql://u:p@127.0.0.1:5432/db');
    assert.equal(process.env.PGSSL, 'disable');
    configureTestTls('postgresql://u:p@localhost/db');
    assert.equal(process.env.PGSSL, 'disable');
    configureTestTls('postgresql://u:p@[::1]:5432/db');
    assert.equal(process.env.PGSSL, 'disable');
    configureTestTls('postgresql://u:p@db.example.com/db?sslmode=require');
    assert.equal(process.env.PGSSL, undefined);
    configureTestTls('postgresql://u:p@db.example.com/db?sslmode=verify-full');
    assert.equal(process.env.PGSSL, undefined);
    assert.throws(() => configureTestTls('postgresql://u:p@db.example.com/db'), /explicit TLS/);
    assert.throws(() => configureTestTls('postgresql://u:p@10.0.0.5/db?sslmode=disable'), /explicit TLS/);
  } finally {
    if (saved === undefined) delete process.env.PGSSL;
    else process.env.PGSSL = saved;
  }
});
