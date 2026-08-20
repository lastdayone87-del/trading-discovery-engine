import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeNativeTerm,
  isNoiseOrBoilerplate,
  detectCodeSwitching,
  recordNativeTerminologyObservation,
  recomputeNativeEvidenceProjection,
  computeObservationKey,
  computeEvidenceChecksum
} from './countryNativeIntelligence';
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

/**
 * Mock Queryable Runner for isolated unit testing when PostgreSQL database is not connected.
 */
function createMockRunner() {
  const canonicalTerms = new Map<number, any>();
  const observations: any[] = [];
  const channels = new Map<string, any>();
  const projections = new Map<number, any>();
  let nextTermId = 1;
  let lifecycleRefreshCount = 0;

  return {
    canonicalTerms,
    observations,
    channels,
    projections,
    get lifecycleRefreshCount() { return lifecycleRefreshCount; },
    async query(sql: string, params: any[] = []) {
      const sqlNorm = sql.trim().replace(/\s+/g, ' ');

      if (sqlNorm.startsWith('INSERT INTO canonical_trading_terms')) {
        const canonicalTerm = params[0];
        const normalizedTerm = params[1];
        const country = params[2];

        let existing: any = null;
        for (const t of canonicalTerms.values()) {
          if (t.country === country && t.normalized_term === normalizedTerm) {
            existing = t;
            break;
          }
        }

        if (existing) {
          existing.last_observed_at = new Date().toISOString();
          return { rows: [{ id: existing.id }] };
        } else {
          const id = nextTermId++;
          const row = {
            id,
            canonical_term: canonicalTerm,
            normalized_term: normalizedTerm,
            country,
            language: params[3],
            script: params[4],
            term_type: params[5],
            lifecycle_status: 'CANDIDATE',
            search_eligible: false,
            first_observed_at: new Date().toISOString(),
            last_observed_at: new Date().toISOString()
          };
          canonicalTerms.set(id, row);
          return { rows: [{ id }] };
        }
      }

      if (sqlNorm.startsWith('SELECT id, canonical_term, normalized_term, country, language, concept_id FROM canonical_trading_terms')) {
        const id = Number(params[0]);
        const term = canonicalTerms.get(id);
        return { rows: term ? [term] : [] };
      }

      if (sqlNorm.startsWith('SELECT t.*,')) {
        lifecycleRefreshCount++;
        const id = Number(params[0]);
        const term = canonicalTerms.get(id);
        if (!term) return { rows: [] };

        const termObs = observations.filter(o => o.canonical_term_id === id);
        const creators = new Set(termObs.map(o => o.source_channel_id).filter(Boolean));
        const communities = new Set(termObs.map(o => o.community_fingerprint).filter(Boolean));

        return {
          rows: [{
            ...term,
            distinct_creators: creators.size,
            distinct_communities: communities.size,
            human_approved: 0,
            decayed_evidence: termObs.length,
            executions: 0,
            decayed_yield: 0
          }]
        };
      }

      if (sqlNorm.startsWith('UPDATE canonical_trading_terms SET lifecycle_status=$2,search_eligible=$3')) {
        const id = Number(params[0]);
        const term = canonicalTerms.get(id);
        if (term) {
          term.lifecycle_status = params[1];
          term.search_eligible = Boolean(params[2]);
        }
        return { rows: [] };
      }

      if (sqlNorm.startsWith('INSERT INTO terminology_observations')) {
        const obsKey = params[12];
        if (obsKey && observations.some(o => o.observation_key === obsKey)) {
          // ON CONFLICT (observation_key) DO NOTHING -> Returns empty rows
          return { rows: [] };
        }

        const obs = {
          canonical_term_id: Number(params[0]),
          source_channel_id: params[1],
          source_video_id: params[2],
          observation_type: params[3],
          source_creator_country: params[4],
          target_market_country: params[5],
          locale: params[6],
          is_code_switched: params[7],
          native_language: params[8],
          native_evidence_status: params[9],
          source_provenance_family: params[10],
          code_switch_type: params[11],
          observation_key: obsKey,
          evidence: params[13]
        };
        observations.push(obs);
        return { rows: [{ id: observations.length }] };
      }

      if (sqlNorm.startsWith('SELECT o.source_creator_country,')) {
        const termId = Number(params[0]);
        const termObs = observations.filter(o => o.canonical_term_id === termId);
        const rows = termObs.map(o => {
          const ch = o.source_channel_id ? channels.get(o.source_channel_id) : null;
          return {
            ...o,
            trading_status: ch ? ch.trading_status : 'UNCERTAIN',
            quality_score: ch ? ch.quality_score : 0
          };
        });
        return { rows };
      }

      if (sqlNorm.startsWith('INSERT INTO country_native_evidence_projections')) {
        const termId = Number(params[0]);
        projections.set(termId, { canonical_term_id: termId, ...params });
        return { rows: [] };
      }

      if (sqlNorm.startsWith('INSERT INTO terminology_lifecycle_events') || sqlNorm.startsWith('INSERT INTO terminology_score_snapshots')) {
        return { rows: [] };
      }

      return { rows: [] };
    }
  };
}

test('Phase 10: Source evidence identity binds payload and changed descriptions create new observations while exact retries deduplicate', async () => {
  const runner = createMockRunner();
  runner.channels.set('UC_EVIDENCE_1', { trading_status: 'TRADING_CONFIRMED', quality_score: 80 });

  const termStr = 'operacoes mini indice';
  const channelId = 'UC_EVIDENCE_1';

  // 1. Exact retry of the SAME description evidence payload
  const desc1 = { text: 'Canal de operacoes mini indice e day trade no Brasil' };
  for (let i = 0; i < 3; i++) {
    await recordNativeTerminologyObservation({
      term: termStr,
      country: 'BR',
      channelId,
      observationType: 'DESCRIPTION',
      nativeEvidenceStatus: 'NATIVE_OBSERVED',
      sourceProvenanceFamily: 'CREATOR_METADATA',
      evidence: desc1
    }, runner);
  }

  assert.equal(runner.observations.length, 1, 'Exact retry of description evidence must produce 1 observation row');
  const initialRefreshCount = runner.lifecycleRefreshCount;

  // Re-running exact retry MUST NOT trigger lifecycle refresh
  await recordNativeTerminologyObservation({
    term: termStr,
    country: 'BR',
    channelId,
    observationType: 'DESCRIPTION',
    nativeEvidenceStatus: 'NATIVE_OBSERVED',
    sourceProvenanceFamily: 'CREATOR_METADATA',
    evidence: desc1
  }, runner);

  assert.equal(runner.lifecycleRefreshCount, initialRefreshCount, 'Exact retry must skip lifecycle refresh on conflict');

  // 2. CHANGED description evidence snapshot from the SAME creator creates a NEW observation
  const desc2 = { text: 'Novo treinamento de operacoes mini indice e mini dolar na B3' };
  await recordNativeTerminologyObservation({
    term: termStr,
    country: 'BR',
    channelId,
    observationType: 'DESCRIPTION',
    nativeEvidenceStatus: 'NATIVE_OBSERVED',
    sourceProvenanceFamily: 'CREATOR_METADATA',
    evidence: desc2
  }, runner);

  assert.equal(runner.observations.length, 2, 'Genuinely changed description evidence must create a new observation');

  // 3. Two distinct ENRICHMENT evidence snapshots without videoId do NOT collapse
  const enrich1 = { source: 'entity_linker_v1', matchedEntity: 'B3_INDICE' };
  const enrich2 = { source: 'entity_linker_v2', matchedEntity: 'B3_FUTURES' };

  await recordNativeTerminologyObservation({
    term: termStr,
    country: 'BR',
    observationType: 'ENRICHMENT',
    nativeEvidenceStatus: 'STRUCTURED_LOCAL_ENTITY' as any,
    sourceProvenanceFamily: 'STRUCTURED_LOCAL_ENTITY',
    evidence: enrich1
  }, runner);

  await recordNativeTerminologyObservation({
    term: termStr,
    country: 'BR',
    observationType: 'ENRICHMENT',
    nativeEvidenceStatus: 'STRUCTURED_LOCAL_ENTITY' as any,
    sourceProvenanceFamily: 'STRUCTURED_LOCAL_ENTITY',
    evidence: enrich2
  }, runner);

  assert.equal(runner.observations.length, 4, 'Distinct enrichment evidence snapshots must remain distinct');
});

test('Phase 10: Phase 10 native observations route through authoritative terminology lifecycle', async () => {
  const runner = createMockRunner();

  runner.channels.set('UC_AUTHORITATIVE_1', { trading_status: 'TRADING_CONFIRMED', quality_score: 80 });
  runner.channels.set('UC_AUTHORITATIVE_2', { trading_status: 'TRADING_CONFIRMED', quality_score: 85 });
  runner.channels.set('UC_AUTHORITATIVE_3', { trading_status: 'TRADING_CONFIRMED', quality_score: 90 });

  const termStr = 'mini indice operacoes';

  // Record observations across 3 distinct creators
  const termId1 = await recordNativeTerminologyObservation({
    term: termStr,
    country: 'BR',
    channelId: 'UC_AUTHORITATIVE_1',
    observationType: 'VIDEO_TITLE',
    nativeEvidenceStatus: 'NATIVE_OBSERVED'
  }, runner);

  await recordNativeTerminologyObservation({
    term: termStr,
    country: 'BR',
    channelId: 'UC_AUTHORITATIVE_2',
    observationType: 'DESCRIPTION',
    nativeEvidenceStatus: 'NATIVE_OBSERVED'
  }, runner);

  await recordNativeTerminologyObservation({
    term: termStr,
    country: 'BR',
    channelId: 'UC_AUTHORITATIVE_3',
    observationType: 'DESCRIPTION',
    nativeEvidenceStatus: 'NATIVE_OBSERVED'
  }, runner);

  assert.ok(termId1);
  const termRow = runner.canonicalTerms.get(termId1!);
  assert.ok(termRow);
  // Authoritative lifecycle MUST be refreshed and set status to OBSERVED or higher
  assert.equal(termRow.lifecycle_status, 'OBSERVED');
});

test('Phase 10: Mixed native evidence provenance preserves status and source family distributions', async () => {
  const runner = createMockRunner();

  runner.channels.set('UC_NATIVE_01', { trading_status: 'TRADING_CONFIRMED', quality_score: 80 });

  const termStr = 'dax krypto trading';

  // 1 Native observation + 3 Translated seed observations
  const termId = await recordNativeTerminologyObservation({
    term: termStr,
    country: 'DE',
    channelId: 'UC_NATIVE_01',
    observationType: 'VIDEO_TITLE',
    nativeEvidenceStatus: 'NATIVE_OBSERVED',
    sourceProvenanceFamily: 'CREATOR_METADATA'
  }, runner);

  for (let i = 0; i < 3; i++) {
    await recordNativeTerminologyObservation({
      term: termStr,
      country: 'DE',
      videoId: `TRANS_${i}`,
      observationType: 'ENRICHMENT',
      nativeEvidenceStatus: 'TRANSLATED_SEED',
      sourceProvenanceFamily: 'TRANSLATED_QUERY'
    }, runner);
  }

  const proj = await recomputeNativeEvidenceProjection(termId!, runner);
  assert.ok(proj);

  // MUST preserve distributions without erasing translated or native counts
  assert.equal(proj.rawObservationCount, 4);
  assert.equal(proj.nativeObservedCount, 1);
  assert.equal(proj.translatedSeedCount, 3);
  assert.equal(proj.nativeObservedRatio, 0.25);

  assert.deepEqual(proj.sourceProvenanceFamilies.sort(), ['CREATOR_METADATA', 'TRANSLATED_QUERY'].sort());
  assert.equal(proj.sourceProvenanceCounts['CREATOR_METADATA'], 1);
  assert.equal(proj.sourceProvenanceCounts['TRANSLATED_QUERY'], 3);
});
