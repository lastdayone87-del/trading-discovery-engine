import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeNativeTerm,
  isNoiseOrBoilerplate,
  detectCodeSwitching,
  recordNativeTerminologyObservation,
  recomputeNativeEvidenceProjection
} from './countryNativeIntelligence';
import { generateCountryNativeProposals } from './discoveryProposalGenerators';
import { getDb } from './db';

test('Phase 10: normalizeNativeTerm preserves diacritics, ticker symbols, and multi-word phrases', () => {
  assert.equal(normalizeNativeTerm('  Ações Brasil  '), 'ações brasil');
  assert.equal(normalizeNativeTerm('B3 Bolsa'), 'b3 bolsa');
  assert.equal(normalizeNativeTerm('DAX 40'), 'dax 40');
  assert.equal(normalizeNativeTerm('PETR4'), 'petr4');
  assert.equal(normalizeNativeTerm('^BVSP'), '^bvsp');
});

test('Phase 10: isNoiseOrBoilerplate rejects generic stopwords, URLs, affiliate codes, and sponsor handles', () => {
  assert.equal(isNoiseOrBoilerplate('https://example.com/discount'), true);
  assert.equal(isNoiseOrBoilerplate('subscribe to my channel'), true);
  assert.equal(isNoiseOrBoilerplate('link in bio instagram'), true);
  assert.equal(isNoiseOrBoilerplate('cupom100'), true);
  assert.equal(isNoiseOrBoilerplate('the'), true);
  assert.equal(isNoiseOrBoilerplate('and'), true);
  assert.equal(isNoiseOrBoilerplate('de'), true);

  // Valid native terms must NOT be flagged as noise
  assert.equal(isNoiseOrBoilerplate('day trade acoes'), false);
  assert.equal(isNoiseOrBoilerplate('mini indice'), false);
  assert.equal(isNoiseOrBoilerplate('hebelprodukte'), false);
  assert.equal(isNoiseOrBoilerplate('日経平均'), false);
});

test('Phase 10: detectCodeSwitching accurately identifies mixed-script and English financial vocabulary in native text', () => {
  const deGerman = detectCodeSwitching('DAX Opening Range Breakout Setup', 'de');
  assert.equal(deGerman.isCodeSwitched, true);
  assert.equal(deGerman.codeSwitchType, 'NATIVE_DOMINANT_ENGLISH_FINANCE');

  const jpMixed = detectCodeSwitching('FXトレード Scalping Strategy', 'ja');
  assert.equal(jpMixed.isCodeSwitched, true);
  assert.equal(jpMixed.codeSwitchType, 'MIXED_SCRIPT_TERMINOLOGY');

  const purePt = detectCodeSwitching('investimentos em acoes', 'pt');
  assert.equal(purePt.isCodeSwitched, false);
  assert.equal(purePt.codeSwitchType, 'NONE');
});

test('Phase 10: Single creator unstructured evidence remains evidence-only and capped below proposal eligibility', async () => {
  if (!process.env.DATABASE_URL) return; // DB required for integration assertion

  const db = await getDb();

  // Clean up test channel & term
  const testChannelId = 'UC_TEST_SINGLE_CREATOR_01';
  await db.query(`DELETE FROM channels WHERE channel_id = $1`, [testChannelId]);
  await db.query(`INSERT INTO channels(channel_id, channel_name, youtube_url, country, country_status, discord_status, scan_status, discovery_source, first_seen, quality_score, trading_status)
    VALUES($1, 'Test Trader 1', 'https://youtube.com/c/test1', 'BR', 'CONFIRMED', 'NONE', 'COMPLETED', 'TEST', now(), 70, 'TRADING_CONFIRMED')`, [testChannelId]);

  const termId = await recordNativeTerminologyObservation({
    term: 'single creator unique phrase',
    country: 'BR',
    sourceCreatorCountry: 'BR',
    targetMarketCountry: 'BR',
    locale: 'pt-BR',
    channelId: testChannelId,
    observationType: 'DESCRIPTION',
    nativeEvidenceStatus: 'NATIVE_OBSERVED',
    sourceProvenanceFamily: 'CREATOR_METADATA'
  });

  assert.ok(termId);

  const proj = await recomputeNativeEvidenceProjection(termId!);
  assert.ok(proj);
  assert.equal(proj.qualityCreatorCount, 1);
  assert.equal(proj.structuredEntityMatched, false);
  // MUST remain evidence-only (not proposal eligible) because qualityCreatorCount < 2 and not structured entity
  assert.equal(proj.nativeProposalEligible, false);
  assert.ok(proj.nativeConfidenceScore <= 0.45, `Confidence ${proj.nativeConfidenceScore} must be capped at 0.45`);

  // Clean up
  await db.query(`DELETE FROM canonical_trading_terms WHERE id = $1`, [termId]);
  await db.query(`DELETE FROM channels WHERE channel_id = $1`, [testChannelId]);
});

test('Phase 10: Multi-creator quality evidence aggregates idempotently and qualifies for native proposals', async () => {
  if (!process.env.DATABASE_URL) return; // DB required for integration assertion

  const db = await getDb();

  const c1 = 'UC_TEST_MULTI_01';
  const c2 = 'UC_TEST_MULTI_02';

  await db.query(`DELETE FROM channels WHERE channel_id IN ($1, $2)`, [c1, c2]);
  await db.query(`INSERT INTO channels(channel_id, channel_name, youtube_url, country, country_status, discord_status, scan_status, discovery_source, first_seen, quality_score, trading_status)
    VALUES ($1, 'Trader 1', 'https://yt.com/1', 'DE', 'CONFIRMED', 'NONE', 'COMPLETED', 'TEST', now(), 80, 'TRADING_CONFIRMED'),
           ($2, 'Trader 2', 'https://yt.com/2', 'DE', 'CONFIRMED', 'NONE', 'COMPLETED', 'TEST', now(), 85, 'TRADING_CONFIRMED')`, [c1, c2]);

  const termStr = 'hebelprodukte strategien';

  const termId1 = await recordNativeTerminologyObservation({
    term: termStr,
    country: 'DE',
    sourceCreatorCountry: 'DE',
    targetMarketCountry: 'DE',
    locale: 'de-DE',
    channelId: c1,
    observationType: 'VIDEO_TITLE',
    nativeEvidenceStatus: 'NATIVE_OBSERVED',
    sourceProvenanceFamily: 'CREATOR_METADATA'
  });

  const termId2 = await recordNativeTerminologyObservation({
    term: termStr,
    country: 'DE',
    sourceCreatorCountry: 'DE',
    targetMarketCountry: 'US', // Creator in DE trading US market
    locale: 'de-DE',
    channelId: c2,
    observationType: 'DESCRIPTION',
    nativeEvidenceStatus: 'NATIVE_OBSERVED',
    sourceProvenanceFamily: 'CREATOR_METADATA'
  });

  assert.equal(termId1, termId2, 'Same term in same country must reuse canonical term ID');

  const proj = await recomputeNativeEvidenceProjection(termId1!);
  assert.ok(proj);
  assert.equal(proj.qualityCreatorCount, 2);
  assert.equal(proj.nativeProposalEligible, true, 'Multi-creator quality evidence must become proposal-eligible');

  // Verify creator geography vs market geography separation
  assert.deepEqual(proj.observedCreatorCountries, ['DE']);
  assert.ok(proj.observedMarketCountries.includes('DE') && proj.observedMarketCountries.includes('US'));

  // Test proposal generator emits this term as a COUNTRY_NATIVE proposal
  const proposals = await generateCountryNativeProposals('DE', 10);
  const matched = proposals.find(p => p.concept.toLowerCase() === termStr);
  assert.ok(matched, 'Proposal generator must emit native-eligible projection');
  assert.equal(matched.proposalFamily, 'COUNTRY_NATIVE');
  assert.equal(matched.supportingEvidence.provenanceType, 'observed_native_evidence');
  assert.equal(matched.supportingEvidence.nativeEvidenceStatus, 'NATIVE_OBSERVED');

  // Clean up
  await db.query(`DELETE FROM canonical_trading_terms WHERE id = $1`, [termId1]);
  await db.query(`DELETE FROM channels WHERE channel_id IN ($1, $2)`, [c1, c2]);
});

test('Phase 10: Translated seeds and bootstrap seeds are NEVER classified as NATIVE_OBSERVED', async () => {
  if (!process.env.DATABASE_URL) return; // DB required for integration assertion

  const db = await getDb();

  const termId = await recordNativeTerminologyObservation({
    term: 'translated english seed phrase',
    country: 'JP',
    sourceCreatorCountry: 'JP',
    targetMarketCountry: 'JP',
    locale: 'ja-JP',
    observationType: 'ENRICHMENT',
    nativeEvidenceStatus: 'TRANSLATED_SEED',
    sourceProvenanceFamily: 'TRANSLATED_QUERY'
  });

  assert.ok(termId);

  const proj = await recomputeNativeEvidenceProjection(termId!);
  assert.ok(proj);
  assert.equal(proj.nativeEvidenceStatus, 'TRANSLATED_SEED');
  assert.notEqual(proj.nativeEvidenceStatus, 'NATIVE_OBSERVED');

  // Clean up
  await db.query(`DELETE FROM canonical_trading_terms WHERE id = $1`, [termId]);
});
