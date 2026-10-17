import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './db';
import { observeTerminologyDetailed, readNativeQualityEvidence } from './terminologyIntelligence';
import { computeObservationKey } from './countryNativeIntelligence';

const databaseUrl = process.env.PHASE10_POSTGRES_URL;

// Run-scoped identity for every row this file creates: teardown deletes by
// suffix, and the shape guard below keeps a future suffix change from ever
// widening into a broad delete.
const runSuffix = `lng${Date.now().toString(36)}${process.pid}`;
if (!/^[a-z0-9]+$/.test(runSuffix)) throw new Error('Unsafe test-run suffix');

/**
 * Disposable-database TLS policy: TLS is disabled only for explicit local
 * loopback databases (the approved disposable-container pattern). Remote
 * URLs keep the default TLS behavior so test traffic stays encrypted.
 */
function configureTestTls(databaseUrl: string): void {
  // Test databases must never inherit production TLS overrides: under
  // NODE_ENV=production getDb() forces rejectUnauthorized:false, which would
  // silently disable verification even for verify-full URLs.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to run integration tests under NODE_ENV=production (pool TLS verification would be disabled).');
  }
  // Optional userinfo (user:pass@) precedes the host and carries no signal.
  if (/^postgres(ql)?:\/\/(?:[^@/]*@)?(localhost|127\.0\.0\.1|\[?::1\]?)([:/]|$)/i.test(databaseUrl)) {
    process.env.PGSSL = 'disable';
    return;
  }
  // Remote test databases require VERIFIED TLS: bare sslmode=require (or
  // weaker) negotiates encryption without authenticating the server, so a
  // network attacker could impersonate the database and capture credentials.
  // Only verify-ca / verify-full are accepted (the driver verifies against
  // configured trust roots); anything else fails closed.
  const sslmode = /[?&]sslmode=([^&]*)/i.exec(databaseUrl)?.[1]?.toLowerCase();
  if (sslmode === 'verify-ca' || sslmode === 'verify-full') {
    delete process.env.PGSSL;
    return;
  }
  throw new Error('Refusing remote test database without verified TLS (use ?sslmode=verify-full with a trusted CA, or a local disposable container).');
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
  const suffix = runSuffix;
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
  // The superseded classification survives inside the row's revision log.
  const revRow = await db.query(
    `SELECT evidence->'revisions' AS revs FROM terminology_observations WHERE canonical_term_id=$1`,
    [local.termId]
  );
  const revs = revRow.rows[0]?.revs as Array<Record<string, unknown>> | null;
  assert.ok(Array.isArray(revs) && revs.length >= 1, 'no revision preserved');
  assert.equal(revs[revs.length - 1]?.native_evidence_status, 'NATIVE_OBSERVED');

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

  // (i) Legacy reconciliation: a row still keyed in the pre-change format
  // (the exact state of production rows: old key, NULL status) is rekeyed
  // in place on re-observation instead of duplicating.
  const altTerm = `Altlast ${suffix}`;
  const altEvidence = { extractor: 'TEST', qualityVersion: 'native-v1', literal: true, novel: true, knownAs: null, generic: false, spamConfirmed: false, spamSignals: [] };
  const altFirst = await observeTerminologyDetailed({
    term: altTerm, country: 'Germany', termType: 'TERMINOLOGY',
    observationType: 'VIDEO_TITLE', channelId, videoId: `v-alt-${suffix}`,
    evidence: altEvidence
  });
  assert.ok(altFirst && altFirst.observationInserted);
  // Simulate a pre-change production row: a non-current key with NULL
  // status. Reconciliation matches by source identity plus evidence
  // substance, so any key vintage heals the same way.
  const legacyKey = `legacy-simulated-${suffix}`;
  await db.query(`UPDATE terminology_observations SET observation_key=$1, native_evidence_status=NULL WHERE canonical_term_id=$2`, [legacyKey, altFirst.termId]);
  const altSecond = await observeTerminologyDetailed({
    term: altTerm, country: 'Germany', termType: 'TERMINOLOGY',
    observationType: 'VIDEO_TITLE', channelId, videoId: `v-alt-${suffix}`,
    language: 'de', locale: 'de-DE',
    evidence: altEvidence
  });
  assert.ok(altSecond);
  assert.equal(altSecond.observationInserted, false);
  const altRows = await db.query(
    `SELECT observation_key, native_evidence_status FROM terminology_observations WHERE canonical_term_id=$1`,
    [altFirst.termId]
  );
  assert.equal(altRows.rows.length, 1);
  assert.equal(altRows.rows[0]?.native_evidence_status, 'NATIVE_OBSERVED');
  assert.equal(
    altRows.rows[0]?.observation_key,
    computeObservationKey({
      canonicalTermId: altFirst.termId, channelId, videoId: `v-alt-${suffix}`,
      observationType: 'VIDEO_TITLE',
      evidence: altEvidence
    })
  );

  // (j) Country attribution refreshes on reclassification: a moved creator
  // is reported under the current country, not first-write values.
  const umzugChannel = `UMZUG_CH_${suffix}`;
  await db.query(
    `INSERT INTO channels(channel_id,channel_name,youtube_url,country,country_status,discord_status,scan_status,discovery_source,first_seen,quality_score,trading_status)
     VALUES($1,$1,$2,'Germany','CONFIRMED','UNKNOWN','PENDING','language-downstream',now(),90,'TRADING_CONFIRMED')`,
    [umzugChannel, `https://youtube.com/channel/${umzugChannel}`]
  );
  const umzugTerm = `Umzug ${suffix}`;
  await observeTerminologyDetailed({
    term: umzugTerm, country: 'Germany', termType: 'TERMINOLOGY',
    observationType: 'VIDEO_TITLE', channelId: umzugChannel, videoId: `v-umzug-${suffix}`,
    language: 'de', locale: 'de-DE',
    evidence: { extractor: 'TEST', qualityVersion: 'native-v1', literal: true, novel: true, knownAs: null, generic: false, spamConfirmed: false, spamSignals: [] }
  });
  await db.query(`UPDATE channels SET country='France' WHERE channel_id=$1`, [umzugChannel]);
  await observeTerminologyDetailed({
    term: umzugTerm, country: 'Germany', termType: 'TERMINOLOGY',
    observationType: 'VIDEO_TITLE', channelId: umzugChannel, videoId: `v-umzug-${suffix}`,
    language: 'de', locale: 'de-DE',
    evidence: { extractor: 'TEST', qualityVersion: 'native-v1', literal: true, novel: true, knownAs: null, generic: false, spamConfirmed: false, spamSignals: [] }
  });
  const umzugRows = await db.query(
    `SELECT source_creator_country FROM terminology_observations WHERE canonical_term_id=(SELECT id FROM canonical_trading_terms WHERE normalized_term=$1 AND country='Germany')`,
    [umzugTerm.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en')]
  );
  assert.equal(umzugRows.rows.length, 1);
  assert.equal(umzugRows.rows[0]?.source_creator_country, 'France');

  // (k) Superseded residue merges: a legacy-keyed duplicate alongside a live
  // new-format row folds its classification into the survivor's revisions
  // and is removed, so aggregates count one row per source.
  const dupeTerm = `Dupe ${suffix}`;
  const dupeFirst = await observeTerminologyDetailed({
    term: dupeTerm, country: 'Germany', termType: 'TERMINOLOGY',
    observationType: 'VIDEO_TITLE', channelId, videoId: `v-dupe-${suffix}`,
    language: 'de', locale: 'de-DE',
    evidence: { extractor: 'TEST', qualityVersion: 'native-v1', literal: true, novel: true, knownAs: null, generic: false, spamConfirmed: false, spamSignals: [] }
  });
  assert.ok(dupeFirst && dupeFirst.observationInserted);
  const dupeKey = `legacy-dupe-key-${suffix}`;
  await db.query(
    `INSERT INTO terminology_observations(canonical_term_id, source_channel_id, source_video_id, observation_type,
       human_approved, evidence_weight, evidence, source_creator_country, locale, term_language,
       native_evidence_status, observation_key)
     VALUES($1,$2,$3,'VIDEO_TITLE',false,1.0,$4,'Germany','de-DE','de','NATIVE_OBSERVED',$5)`,
    [dupeFirst.termId, channelId, `v-dupe-${suffix}`,
     JSON.stringify({ extractor: 'OLD', qualityVersion: 'native-v1', literal: true, novel: true, knownAs: null, generic: false, spamConfirmed: false, spamSignals: [] }),
     dupeKey]
  );
  await observeTerminologyDetailed({
    term: dupeTerm, country: 'Germany', termType: 'TERMINOLOGY',
    observationType: 'VIDEO_TITLE', channelId, videoId: `v-dupe-${suffix}`,
    language: 'de', locale: 'de-DE',
    evidence: { extractor: 'TEST', qualityVersion: 'native-v1', literal: true, novel: true, knownAs: null, generic: false, spamConfirmed: false, spamSignals: [] }
  });
  const dupeRows = await db.query(
    `SELECT id, observation_key, evidence->'revisions' AS revs FROM terminology_observations WHERE canonical_term_id=$1`,
    [dupeFirst.termId]
  );
  assert.equal(dupeRows.rows.length, 1);
  const dupeRevs = dupeRows.rows[0]?.revs as Array<Record<string, unknown>> | null;
  assert.ok(Array.isArray(dupeRevs) && dupeRevs.some(r => r?.superseded_legacy_key === dupeKey));
  // The merged entry preserves the complete prior evidence payload.
  const merged = dupeRevs.find(r => r?.superseded_legacy_key === dupeKey) as Record<string, any> | undefined;
  assert.ok(merged);
  assert.equal((merged.evidence as any)?.extractor, 'OLD');
  assert.equal(merged.native_evidence_status, 'NATIVE_OBSERVED');

  // (l) Keyless rows heal by source identity: a NULL-keyed observation for
  // the same source is rekeyed in place instead of duplicating.
  const nullTerm = `Nullkey ${suffix}`;
  const nullFirst = await observeTerminologyDetailed({
    term: nullTerm, country: 'Germany', termType: 'TERMINOLOGY',
    observationType: 'VIDEO_TITLE', channelId, videoId: `v-null-${suffix}`,
    evidence: { extractor: 'TEST' }
  });
  assert.ok(nullFirst && nullFirst.observationInserted);
  await db.query(`UPDATE terminology_observations SET observation_key=NULL WHERE canonical_term_id=$1`, [nullFirst.termId]);
  await observeTerminologyDetailed({
    term: nullTerm, country: 'Germany', termType: 'TERMINOLOGY',
    observationType: 'VIDEO_TITLE', channelId, videoId: `v-null-${suffix}`,
    evidence: { extractor: 'TEST' }
  });
  const nullRows = await db.query(
    `SELECT observation_key FROM terminology_observations WHERE canonical_term_id=$1`, [nullFirst.termId]
  );
  assert.equal(nullRows.rows.length, 1);
  assert.ok(typeof nullRows.rows[0]?.observation_key === 'string' && nullRows.rows[0]?.observation_key.length > 0);
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
    configureTestTls('postgresql://u:p@db.example.com/db?sslmode=verify-ca');
    assert.equal(process.env.PGSSL, undefined);
    configureTestTls('postgresql://u:p@db.example.com/db?sslmode=verify-full');
    assert.equal(process.env.PGSSL, undefined);
    assert.throws(() => configureTestTls('postgresql://u:p@db.example.com/db'), /verified TLS/);
    assert.throws(() => configureTestTls('postgresql://u:p@db.example.com/db?sslmode=require'), /verified TLS/);
    assert.throws(() => configureTestTls('postgresql://u:p@10.0.0.5/db?sslmode=disable'), /verified TLS/);
  } finally {
    if (saved === undefined) delete process.env.PGSSL;
    else process.env.PGSSL = saved;
  }
});

test('teardown removes every row created by this run', async () => {
  if (!databaseUrl) return;
  process.env.DATABASE_URL = databaseUrl;
  const db = await getDb();
  const like = `%${runSuffix}`;
  await db.query(`DELETE FROM terminology_observations WHERE canonical_term_id IN (SELECT id FROM canonical_trading_terms WHERE normalized_term LIKE $1)`, [like]);
  await db.query(`DELETE FROM terminology_lifecycle_events WHERE canonical_term_id IN (SELECT id FROM canonical_trading_terms WHERE normalized_term LIKE $1)`, [like]);
  await db.query(`DELETE FROM country_native_evidence_projections WHERE canonical_term_id IN (SELECT id FROM canonical_trading_terms WHERE normalized_term LIKE $1)`, [like]);
  await db.query(`DELETE FROM terminology_score_snapshots WHERE canonical_term_id IN (SELECT id FROM canonical_trading_terms WHERE normalized_term LIKE $1)`, [like]);
  await db.query(`DELETE FROM canonical_trading_terms WHERE normalized_term LIKE $1`, [like]);
  await db.query(`DELETE FROM channels WHERE channel_id LIKE $1`, [like]);
  const leftovers = await db.query(
    `SELECT (SELECT count(*) FROM canonical_trading_terms WHERE normalized_term LIKE $1)::int AS terms,
            (SELECT count(*) FROM channels WHERE channel_id LIKE $1)::int AS channels`,
    [like]
  );
  assert.equal(Number(leftovers.rows[0]?.terms), 0);
  assert.equal(Number(leftovers.rows[0]?.channels), 0);
});
