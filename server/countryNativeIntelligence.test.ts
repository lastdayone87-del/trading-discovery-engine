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
import { observeTerminology } from './terminologyIntelligence';
import { getDb } from './db';
import fs from 'node:fs';
import { buildFrontierProposal, effectiveProjectionProposalEvidence, generateCountryNativeProposals, projectionProposalProvenance, selectFairCountryNativeProposals, settleBeforeDeadline, type DiscoveryFrontierProposal } from './discoveryProposalGenerators';
import { QUALITY_CREATOR_SCORE_THRESHOLD } from './queryPerformance';
import { planCountryNativeProposalQuery } from './queryPlanner';
import { evaluateAutonomousQueryAuthority } from './autonomousQueryAuthority';

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

test('Phase 10: computeEvidenceChecksum recursively canonicalizes nested evidence objects regardless of key order', () => {
  const objA = {
    metadata: { author: 'Trader1', score: 90 },
    tags: ['dax', 'futures']
  };

  const objB = {
    tags: ['dax', 'futures'],
    metadata: { score: 90, author: 'Trader1' }
  };

  const checkA = computeEvidenceChecksum(objA);
  const checkB = computeEvidenceChecksum(objB);

  assert.ok(checkA.length > 0);
  assert.equal(checkA, checkB, 'Semantically identical evidence objects with different key insertion order must produce identical checksums');
});

test('Phase 10: projection proposal provenance preserves all governed native evidence families', () => {
  assert.equal(projectionProposalProvenance('NATIVE_OBSERVED', 'CREATOR_METADATA', 1).sourceProvenance,
    'observed_native_evidence:creator_metadata:canonical_projection:1');
  assert.equal(projectionProposalProvenance('BOOTSTRAP_SEED', 'COUNTRY_VOCABULARY', 2).sourceProvenance,
    'bootstrap_vocabulary:country_vocabulary:canonical_projection:2');
  assert.equal(projectionProposalProvenance('BOOTSTRAP_SEED', 'STATIC_BOOTSTRAP', 3).sourceProvenance,
    'bootstrap_vocabulary:static_bootstrap:canonical_projection:3');
  assert.equal(projectionProposalProvenance('TRANSLATED_SEED', 'TRANSLATED_QUERY', 4).sourceProvenance,
    'translated_seed:translated_query:canonical_projection:4');
});

test('Phase 10: canonical country identities and ISO aliases resolve localized static seeds', async () => {
  for (const [country, expected] of [
    ['Germany', 'DAX trading'], ['DE', 'DAX trading'],
    ['Japan', '日経平均'], ['JP', '日経平均'],
    ['United States', 'S&P 500 futures'], ['US', 'S&P 500 futures']
  ] as const) {
    const proposals = await generateCountryNativeProposals(country, 1);
    assert.equal(proposals[0]?.concept, expected, `${country} must use its localized authoritative alias seed set`);
  }
  const generic = await generateCountryNativeProposals('Atlantis', 1);
  assert.equal(generic[0]?.concept, 'local exchange trading');
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
          return { rows: [] }; // ON CONFLICT DO NOTHING
        } else {
          const id = nextTermId++;
          const initialTime = '2026-08-01T00:00:00.000Z';
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
            first_observed_at: initialTime,
            last_observed_at: initialTime
          };
          canonicalTerms.set(id, row);
          return { rows: [{ id }] };
        }
      }

      if (sqlNorm === 'SELECT id FROM canonical_trading_terms WHERE country = $1 AND normalized_term = $2') {
        const country = params[0];
        const normTerm = params[1];
        for (const t of canonicalTerms.values()) {
          if (t.country === country && t.normalized_term === normTerm) {
            return { rows: [{ id: t.id }] };
          }
        }
        return { rows: [] };
      }

      if (sqlNorm.startsWith('SELECT country FROM channels WHERE channel_id = $1')) {
        const ch = channels.get(params[0]);
        return { rows: ch ? [{ country: ch.country }] : [] };
      }

      if (sqlNorm.startsWith('UPDATE canonical_trading_terms SET last_observed_at = $2 WHERE id = $1')) {
        const id = Number(params[0]);
        const term = canonicalTerms.get(id);
        if (term) {
          term.last_observed_at = params[1];
        }
        return { rows: [] };
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
        const obsKey = params[18];
        if (obsKey && observations.some(o => o.observation_key === obsKey)) {
          // ON CONFLICT (observation_key) DO NOTHING -> Returns empty rows
          return { rows: [] };
        }

        const obsAt = '2026-08-01T12:00:00.000Z';
        const obs = {
          id: observations.length + 1,
          canonical_term_id: Number(params[0]),
          source_channel_id: params[1],
          source_video_id: params[2],
          observation_type: params[3],
          source_creator_country: params[9],
          target_market_country: params[10],
          locale: params[11],
          is_code_switched: params[12],
          native_language: params[13],
          term_language: params[14],
          native_evidence_status: params[15],
          source_provenance_family: params[16],
          code_switch_type: params[17],
          observation_key: obsKey,
          evidence: params[8],
          observed_at: obsAt
        };
        observations.push(obs);
        return { rows: [{ id: obs.id, observed_at: obsAt }] };
      }

      if (sqlNorm.includes('FROM terminology_observations o')) {
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
        const parseArr = (p: any) => typeof p === 'string' ? JSON.parse(p) : p || [];
        projections.set(termId, {
          canonical_term_id: termId,
          concept_id: params[1],
          country: params[2],
          dominant_locale: params[3],
          observedCreatorCountries: parseArr(params[4]),
          observedMarketCountries: parseArr(params[5]),
          codeSwitchRatio: params[6],
          isCodeSwitched: params[7],
          codeSwitchType: params[8],
          codeSwitchTypes: parseArr(params[9]),
          codeSwitchTypeCounts: typeof params[10] === 'string' ? JSON.parse(params[10]) : params[10],
          rawObservationCount: params[11],
          nativeObservedCount: params[12],
          bootstrapSeedCount: params[13],
          translatedSeedCount: params[14],
          nativeObservedRatio: params[15],
          distinctCreatorCount: params[16],
          qualityCreatorCount: params[17],
          nativeQualityCreatorCount: params[18],
          distinctCommunityCount: params[19],
          structuredEntityMatched: params[20],
          evidenceRevision: params[21],
          nativeEvidenceStatus: params[22],
          sourceProvenanceFamily: params[23],
          sourceProvenanceFamilies: parseArr(params[24]),
          sourceProvenanceCounts: typeof params[25] === 'string' ? JSON.parse(params[25]) : params[25],
          nativeConfidenceScore: params[26],
          nativeProposalEligible: params[27],
          lastObservedAt: params[28],
          updatedAt: params[29]
        });
        return { rows: [] };
      }

      if (sqlNorm.startsWith('DELETE FROM country_native_evidence_projections')) {
        projections.delete(Number(params[0]));
        return { rows: [] };
      }

      if (sqlNorm.startsWith('INSERT INTO terminology_lifecycle_events') || sqlNorm.startsWith('INSERT INTO terminology_score_snapshots')) {
        return { rows: [] };
      }

      return { rows: [] };
    }
  };
}

test('Phase 10: observeTerminology automatically feeds Phase 10 native evidence and projections', async () => {
  const runner = createMockRunner();
  runner.channels.set('UC_INGESTION_1', { country: 'DE', trading_status: 'TRADING_CONFIRMED', quality_score: 85 });

  const termStr = 'hebelprodukte aktien';

  // observeTerminology is the production metadata ingestion boundary
  const termId = await observeTerminology({
    term: termStr,
    country: 'DE',
    termType: 'TERMINOLOGY',
    observationType: 'VIDEO_TITLE',
    channelId: 'UC_INGESTION_1',
    videoId: 'VID_INGEST_100'
  }, runner);

  assert.ok(termId);

  // Check that Phase 10 observation was created
  const termObs = runner.observations.filter(o => o.canonical_term_id === termId);
  assert.ok(termObs.length >= 1, 'observeTerminology must feed Phase 10 native evidence');

  // Check that Phase 10 projection was populated
  const proj = runner.projections.get(termId!);
  assert.ok(proj, 'observeTerminology must generate Phase 10 projection');
});

test('Phase 10: canonical country casing cannot create a parallel canonical term', async () => {
  const runner = createMockRunner();
  runner.canonicalTerms.set(77, {
    id: 77, canonical_term: 'options flow', normalized_term: 'options flow',
    country: 'United States', language: 'en', term_type: 'TERMINOLOGY',
    lifecycle_status: 'CANDIDATE', search_eligible: false,
    first_observed_at: '2026-08-01T00:00:00.000Z', last_observed_at: '2026-08-01T00:00:00.000Z'
  });
  const termId = await observeTerminology({
    term: 'options flow', country: 'UNITED STATES', termType: 'TERMINOLOGY',
    observationType: 'VIDEO_TITLE', videoId: 'country-case-video'
  }, runner);
  assert.equal(termId, 77);
  assert.equal(runner.canonicalTerms.size, 1);
});

test('Phase 10: Separate creator geography, market geography, and code-switching languages', async () => {
  const runner = createMockRunner();

  // 1. German creator trading US market
  const deTermId = await observeTerminology({
    term: 'dax opening range breakout',
    country: 'DE',
    termType: 'TERMINOLOGY',
    observationType: 'VIDEO_TITLE',
    videoId: 'VID_DE_US_1',
    sourceCreatorCountry: 'DE',
    targetMarketCountry: 'US',
    locale: 'de-DE'
  }, runner);

  const deObs = runner.observations.find(o => o.canonical_term_id === deTermId);
  assert.ok(deObs);
  assert.equal(deObs.source_creator_country, 'Germany');
  assert.equal(deObs.target_market_country, 'United States');
  assert.equal(deObs.is_code_switched, true);
  assert.equal(deObs.native_language, 'de', 'native_language must represent context language de');
  assert.equal(deObs.term_language, 'en', 'term_language must represent embedded term language en');

  // 2. Brazilian creator with UNKNOWN market (must be NULL, not defaulted to BR)
  const brTermId = await observeTerminology({
    term: 'investimentos em acoes',
    country: 'BR',
    termType: 'TERMINOLOGY',
    observationType: 'VIDEO_TITLE',
    videoId: 'VID_BR_1',
    locale: 'pt-BR'
  }, runner);

  const brObs = runner.observations.find(o => o.canonical_term_id === brTermId);
  assert.ok(brObs);
  assert.equal(brObs.target_market_country, null, 'Unspecified target market country must be NULL, not defaulted');
});

test('Phase 10: Non-video observations fail closed when stable source evidence identity is missing', async () => {
  const runner = createMockRunner();

  // Non-video observation without videoId, sourceEvidenceId, or evidence payload MUST fail closed (return null)
  const rejected = await observeTerminology({
    term: 'mini indice acoes',
    country: 'BR',
    termType: 'TERMINOLOGY',
    channelId: 'UC_TEST_01',
    observationType: 'DESCRIPTION', // Non-video
    nativeEvidenceStatus: 'NATIVE_OBSERVED',
    sourceProvenanceFamily: 'CREATOR_METADATA'
  }, runner);

  assert.equal(rejected, null, 'Non-video observation missing evidence identity must fail closed');

  // Non-video observation WITH evidence payload succeeds
  const accepted = await observeTerminology({
    term: 'mini indice acoes',
    country: 'BR',
    termType: 'TERMINOLOGY',
    channelId: 'UC_TEST_01',
    observationType: 'DESCRIPTION',
    nativeEvidenceStatus: 'NATIVE_OBSERVED',
    sourceProvenanceFamily: 'CREATOR_METADATA',
    evidence: { channelDescriptionSnippet: 'mini indice acoes no Brasil' }
  }, runner);

  assert.ok(accepted, 'Non-video observation with evidence payload must be accepted');

  // Video-backed observation WITHOUT explicit evidence payload succeeds because videoId provides identity
  const videoAccepted = await observeTerminology({
    term: 'mini indice acoes',
    country: 'BR',
    termType: 'TERMINOLOGY',
    channelId: 'UC_TEST_01',
    videoId: 'VID_9999',
    observationType: 'VIDEO_TITLE',
    nativeEvidenceStatus: 'NATIVE_OBSERVED',
    sourceProvenanceFamily: 'CREATOR_METADATA'
  }, runner);

  assert.ok(videoAccepted, 'Video-backed observation must use videoId as identity');
});

test('Phase 10: Source evidence identity binds payload and changed descriptions create new observations while exact retries deduplicate', async () => {
  const runner = createMockRunner();
  runner.channels.set('UC_EVIDENCE_1', { country: 'BR', trading_status: 'TRADING_CONFIRMED', quality_score: 80 });

  const termStr = 'operacoes mini indice';
  const channelId = 'UC_EVIDENCE_1';

  // 1. Exact retry of the SAME description evidence payload
  const desc1 = { text: 'Canal de operacoes mini indice e day trade no Brasil' };
  for (let i = 0; i < 3; i++) {
    await observeTerminology({
      term: termStr,
      country: 'BR',
      termType: 'TERMINOLOGY',
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
  await observeTerminology({
    term: termStr,
    country: 'BR',
    termType: 'TERMINOLOGY',
    channelId,
    observationType: 'DESCRIPTION',
    nativeEvidenceStatus: 'NATIVE_OBSERVED',
    sourceProvenanceFamily: 'CREATOR_METADATA',
    evidence: desc1
  }, runner);

  assert.equal(runner.lifecycleRefreshCount, initialRefreshCount, 'Exact retry must skip lifecycle refresh on conflict');

  // 2. CHANGED description evidence snapshot from the SAME creator creates a NEW observation
  const desc2 = { text: 'Novo treinamento de operacoes mini indice e mini dolar na B3' };
  await observeTerminology({
    term: termStr,
    country: 'BR',
    termType: 'TERMINOLOGY',
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

  await observeTerminology({
    term: termStr,
    country: 'BR',
    termType: 'TERMINOLOGY',
    observationType: 'ENRICHMENT',
    nativeEvidenceStatus: 'NATIVE_OBSERVED',
    sourceProvenanceFamily: 'STRUCTURED_LOCAL_ENTITY',
    evidence: enrich1
  }, runner);

  await observeTerminology({
    term: termStr,
    country: 'BR',
    termType: 'TERMINOLOGY',
    observationType: 'ENRICHMENT',
    nativeEvidenceStatus: 'NATIVE_OBSERVED',
    sourceProvenanceFamily: 'STRUCTURED_LOCAL_ENTITY',
    evidence: enrich2
  }, runner);

  assert.equal(runner.observations.length, 4, 'Distinct enrichment evidence snapshots must remain distinct');
});

test('Phase 10: Exact observation replay does NOT advance canonical term last_observed_at timestamp', async () => {
  const runner = createMockRunner();
  runner.channels.set('UC_RECENCY_1', { country: 'BR', trading_status: 'TRADING_CONFIRMED', quality_score: 80 });

  const termStr = 'mini indice recency';
  const evidence = { text: 'snapshot for recency test' };

  // First insertion
  const termId = await observeTerminology({
    term: termStr,
    country: 'BR',
    termType: 'TERMINOLOGY',
    channelId: 'UC_RECENCY_1',
    observationType: 'DESCRIPTION',
    nativeEvidenceStatus: 'NATIVE_OBSERVED',
    sourceProvenanceFamily: 'CREATOR_METADATA',
    evidence
  }, runner);

  assert.ok(termId);
  const termBefore = runner.canonicalTerms.get(termId!);
  assert.ok(termBefore);
  const firstLastObservedAt = termBefore.last_observed_at;

  // Replay exact same observation multiple times
  for (let i = 0; i < 3; i++) {
    await observeTerminology({
      term: termStr,
      country: 'BR',
      termType: 'TERMINOLOGY',
      channelId: 'UC_RECENCY_1',
      observationType: 'DESCRIPTION',
      nativeEvidenceStatus: 'NATIVE_OBSERVED',
      sourceProvenanceFamily: 'CREATOR_METADATA',
      evidence
    }, runner);
  }

  const termAfter = runner.canonicalTerms.get(termId!);
  assert.equal(termAfter.last_observed_at, firstLastObservedAt, 'Duplicate observation replay must NOT advance last_observed_at');
});

test('Phase 10: Projection lastObservedAt is derived from MAX(observed_at) and remains invariant across recomputations', async () => {
  const runner = createMockRunner();
  runner.channels.set('UC_PROJ_1', { country: 'DE', trading_status: 'TRADING_CONFIRMED', quality_score: 80 });

  const termStr = 'hebelprodukte test';
  const termId = (await observeTerminology({
    term: termStr,
    country: 'DE',
    termType: 'TERMINOLOGY',
    channelId: 'UC_PROJ_1',
    videoId: 'VID_DE_01',
    observationType: 'VIDEO_TITLE',
    nativeEvidenceStatus: 'NATIVE_OBSERVED',
    sourceProvenanceFamily: 'CREATOR_METADATA'
  }, runner))!;

  const proj1 = await recomputeNativeEvidenceProjection(termId, runner);
  const proj2 = await recomputeNativeEvidenceProjection(termId, runner);

  assert.ok(proj1);
  assert.ok(proj2);

  // Derived lastObservedAt MUST be invariant and match max observation timestamp
  assert.equal(proj1.lastObservedAt, proj2.lastObservedAt);
  assert.equal(proj1.lastObservedAt, '2026-08-01T12:00:00.000Z');

  // Array fields MUST be sorted in stable alphabetical order
  assert.deepEqual(proj1.observedCreatorCountries, ['Germany']);
  assert.deepEqual(proj1.sourceProvenanceFamilies, ['CREATOR_METADATA']);
});

test('Phase 10: legacy NULL evidence remains neutral and cannot manufacture a native projection', async () => {
  const runner = createMockRunner();
  const termId = await observeTerminology({
    term: 'legacy neutral term',
    country: 'US',
    termType: 'TERMINOLOGY',
    observationType: 'CHANNEL_NAME',
    channelId: 'LEGACY_WITHOUT_COUNTRY'
  }, runner);

  assert.ok(termId);
  assert.equal(runner.observations[0].native_evidence_status, null);
  assert.equal(runner.observations[0].source_provenance_family, null);
  assert.equal(await recomputeNativeEvidenceProjection(termId!, runner), null);
  assert.equal(runner.projections.has(termId!), false);
});

test('Phase 10: projection primary provenance is selected only from the winning evidence status', async () => {
  const runner = createMockRunner();
  for (let index = 0; index < 3; index++) {
    await observeTerminology({
      term: 'mixed evidence term', country: 'Germany', termType: 'TERMINOLOGY', observationType: 'VIDEO_TITLE',
      videoId: `translated-${index}`, channelId: `translated-creator-${index}`,
      nativeEvidenceStatus: 'TRANSLATED_SEED', sourceProvenanceFamily: 'TRANSLATED_QUERY'
    }, runner);
  }
  const termId = await observeTerminology({
    term: 'mixed evidence term', country: 'Germany', termType: 'TERMINOLOGY', observationType: 'VIDEO_TITLE',
    videoId: 'native-1', channelId: 'native-creator',
    nativeEvidenceStatus: 'NATIVE_OBSERVED', sourceProvenanceFamily: 'CREATOR_METADATA'
  }, runner);
  const projection = await recomputeNativeEvidenceProjection(termId!, runner);
  assert.equal(projection?.nativeEvidenceStatus, 'NATIVE_OBSERVED');
  assert.equal(projection?.sourceProvenanceFamily, 'CREATOR_METADATA');
  assert.deepEqual(projection?.sourceProvenanceFamilies, ['CREATOR_METADATA', 'TRANSLATED_QUERY']);
});

test('Phase 10: governed bootstrap eligibility survives mixed weak native evidence without overstating native validation', async () => {
  const runner = createMockRunner();
  const bootstrapId = await observeTerminology({
    term: 'governed mixed term', country: 'Germany', termType: 'TERMINOLOGY', observationType: 'VIDEO_TITLE',
    videoId: 'governed-bootstrap', nativeEvidenceStatus: 'BOOTSTRAP_SEED', sourceProvenanceFamily: 'COUNTRY_VOCABULARY'
  }, runner);
  let projection = await recomputeNativeEvidenceProjection(bootstrapId!, runner);
  assert.equal(projection?.nativeProposalEligible, true, 'governed vocabulary alone is eligible');
  assert.equal(projection?.nativeEvidenceStatus, 'BOOTSTRAP_SEED');

  await observeTerminology({
    term: 'governed mixed term', country: 'Germany', termType: 'TERMINOLOGY', observationType: 'VIDEO_TITLE',
    videoId: 'weak-native', channelId: 'weak-native-creator',
    nativeEvidenceStatus: 'NATIVE_OBSERVED', sourceProvenanceFamily: 'CREATOR_METADATA'
  }, runner);
  projection = await recomputeNativeEvidenceProjection(bootstrapId!, runner);
  assert.equal(projection?.nativeProposalEligible, true, 'governed eligibility survives one weak native creator');
  assert.equal(projection?.nativeEvidenceStatus, 'NATIVE_OBSERVED');
  assert.equal(projection?.qualityCreatorCount, 0, 'the native evidence itself remains below validation gate');

  runner.channels.set('quality-native-1', { country: 'Germany', trading_status: 'TRADING_CONFIRMED', quality_score: 80 });
  runner.channels.set('quality-native-2', { country: 'Germany', trading_status: 'TRADING_CONFIRMED', quality_score: 80 });
  for (const channelId of ['quality-native-1', 'quality-native-2']) {
    await observeTerminology({
      term: 'governed mixed term', country: 'Germany', termType: 'TERMINOLOGY', observationType: 'VIDEO_TITLE',
      videoId: `video-${channelId}`, channelId,
      nativeEvidenceStatus: 'NATIVE_OBSERVED', sourceProvenanceFamily: 'CREATOR_METADATA'
    }, runner);
  }
  projection = await recomputeNativeEvidenceProjection(bootstrapId!, runner);
  assert.equal(projection?.nativeProposalEligible, true);
  assert.ok((projection?.qualityCreatorCount || 0) >= 2, 'qualifying native evidence independently meets the native gate');

  const translatedRunner = createMockRunner();
  const translatedId = await observeTerminology({
    term: 'translated only term', country: 'Germany', termType: 'TERMINOLOGY', observationType: 'VIDEO_TITLE',
    videoId: 'translated-only', nativeEvidenceStatus: 'TRANSLATED_SEED', sourceProvenanceFamily: 'TRANSLATED_QUERY'
  }, translatedRunner);
  const translated = await recomputeNativeEvidenceProjection(translatedId!, translatedRunner);
  assert.equal(translated?.nativeProposalEligible, false, 'translated seed cannot inherit governed-bootstrap eligibility');
});

test('Phase 10: mixed projection proposal labeling distinguishes governed fallback from validated native evidence', () => {
  assert.deepEqual(effectiveProjectionProposalEvidence({
    native_evidence_status: 'BOOTSTRAP_SEED', source_provenance_family: 'COUNTRY_VOCABULARY',
    source_provenance_families: ['COUNTRY_VOCABULARY'], bootstrap_seed_count: 1, quality_creator_count: 0
  }), { nativeEvidenceStatus: 'BOOTSTRAP_SEED', sourceProvenanceFamily: 'COUNTRY_VOCABULARY', nativeGateSatisfied: false });
  assert.deepEqual(effectiveProjectionProposalEvidence({
    native_evidence_status: 'NATIVE_OBSERVED', source_provenance_family: 'CREATOR_METADATA',
    source_provenance_families: ['COUNTRY_VOCABULARY', 'CREATOR_METADATA'], bootstrap_seed_count: 1, quality_creator_count: 1
  }), { nativeEvidenceStatus: 'BOOTSTRAP_SEED', sourceProvenanceFamily: 'COUNTRY_VOCABULARY', nativeGateSatisfied: false });
  assert.deepEqual(effectiveProjectionProposalEvidence({
    native_evidence_status: 'NATIVE_OBSERVED', source_provenance_family: 'CREATOR_METADATA',
    source_provenance_families: ['COUNTRY_VOCABULARY', 'CREATOR_METADATA'], bootstrap_seed_count: 1,
    quality_creator_count: 2, native_quality_creator_count: 2
  }), { nativeEvidenceStatus: 'NATIVE_OBSERVED', sourceProvenanceFamily: 'CREATOR_METADATA', nativeGateSatisfied: true });
  assert.deepEqual(effectiveProjectionProposalEvidence({
    native_evidence_status: 'TRANSLATED_SEED', source_provenance_family: 'TRANSLATED_QUERY',
    source_provenance_families: ['TRANSLATED_QUERY'], bootstrap_seed_count: 0, quality_creator_count: 0
  }), { nativeEvidenceStatus: 'TRANSLATED_SEED', sourceProvenanceFamily: 'TRANSLATED_QUERY', nativeGateSatisfied: false });
  assert.deepEqual(effectiveProjectionProposalEvidence({
    native_evidence_status: 'NATIVE_OBSERVED', source_provenance_family: 'CREATOR_METADATA',
    source_provenance_families: ['COUNTRY_VOCABULARY', 'CREATOR_METADATA', 'STRUCTURED_LOCAL_ENTITY'],
    bootstrap_seed_count: 1, quality_creator_count: 1, native_quality_creator_count: 0, structured_entity_matched: true
  }), { nativeEvidenceStatus: 'NATIVE_OBSERVED', sourceProvenanceFamily: 'CREATOR_METADATA', nativeGateSatisfied: true });
});

test('Phase 10: non-native quality creators cannot satisfy the native multi-creator gate', async () => {
  const runner = createMockRunner();
  for (const channelId of ['translated-quality-1', 'translated-quality-2', 'bootstrap-quality-1']) {
    runner.channels.set(channelId, { country: 'Germany', trading_status: 'TRADING_CONFIRMED', quality_score: 90 });
    await observeTerminology({
      term: 'native scoped quality', country: 'Germany', termType: 'TERMINOLOGY', observationType: 'VIDEO_TITLE',
      videoId: `video-${channelId}`, channelId,
      nativeEvidenceStatus: channelId.startsWith('translated') ? 'TRANSLATED_SEED' : 'BOOTSTRAP_SEED',
      sourceProvenanceFamily: channelId.startsWith('translated') ? 'TRANSLATED_QUERY' : 'STATIC_BOOTSTRAP'
    }, runner);
  }
  runner.channels.set('weak-native-quality', { country: 'Germany', trading_status: 'TRADING_CONFIRMED', quality_score: 90 });
  const termId = await observeTerminology({
    term: 'native scoped quality', country: 'Germany', termType: 'TERMINOLOGY', observationType: 'VIDEO_TITLE',
    videoId: 'video-weak-native', channelId: 'weak-native-quality',
    nativeEvidenceStatus: 'NATIVE_OBSERVED', sourceProvenanceFamily: 'CREATOR_METADATA'
  }, runner);
  const projection = await recomputeNativeEvidenceProjection(termId!, runner);
  assert.equal(projection?.qualityCreatorCount, 4);
  assert.equal(projection?.nativeQualityCreatorCount, 1);
  assert.equal(projection?.nativeEvidenceStatus, 'NATIVE_OBSERVED');
  assert.equal(projection?.structuredEntityMatched, false);
});

test('Phase 10: native gating reuses the authoritative production quality threshold', async () => {
  const runner = createMockRunner();
  for (const [channelId, score] of [['native-50', 50], ['native-54', 54], ['native-55', QUALITY_CREATOR_SCORE_THRESHOLD]] as const) {
    runner.channels.set(channelId, { country: 'Germany', trading_status: 'TRADING_CONFIRMED', quality_score: score });
    await observeTerminology({
      term: 'authoritative quality threshold', country: 'Germany', termType: 'TERMINOLOGY', observationType: 'VIDEO_TITLE',
      videoId: `video-${channelId}`, channelId, nativeEvidenceStatus: 'NATIVE_OBSERVED', sourceProvenanceFamily: 'CREATOR_METADATA'
    }, runner);
  }
  const termId = runner.observations[0].canonical_term_id;
  let projection = await recomputeNativeEvidenceProjection(termId, runner);
  assert.equal(projection?.nativeQualityCreatorCount, 1, 'scores 50-54 must not count as production quality');
  assert.equal(projection?.nativeProposalEligible, false, 'one qualifying native creator cannot satisfy the two-creator gate');

  runner.channels.set('native-56', { country: 'Germany', trading_status: 'TRADING_CONFIRMED', quality_score: QUALITY_CREATOR_SCORE_THRESHOLD + 1 });
  await observeTerminology({
    term: 'authoritative quality threshold', country: 'Germany', termType: 'TERMINOLOGY', observationType: 'VIDEO_TITLE',
    videoId: 'video-native-56', channelId: 'native-56', nativeEvidenceStatus: 'NATIVE_OBSERVED', sourceProvenanceFamily: 'CREATOR_METADATA'
  }, runner);
  projection = await recomputeNativeEvidenceProjection(termId, runner);
  assert.equal(projection?.nativeQualityCreatorCount, 2);
  assert.equal(projection?.qualityCreatorCount, 2);
  assert.equal(projection?.nativeProposalEligible, true, 'two creators at or above the shared threshold satisfy the gate');
});

test('Phase 10: persisted structured native match survives dominant creator provenance and governed bootstrap', async () => {
  const runner = createMockRunner();
  let termId: number | null = null;
  for (let index = 0; index < 3; index++) {
    termId = await observeTerminology({
      term: 'structured mixed native', country: 'Brazil', termType: 'TERMINOLOGY', observationType: 'VIDEO_TITLE',
      videoId: `creator-metadata-${index}`, channelId: `ordinary-creator-${index}`,
      nativeEvidenceStatus: 'NATIVE_OBSERVED', sourceProvenanceFamily: 'CREATOR_METADATA'
    }, runner);
  }
  await observeTerminology({
    term: 'structured mixed native', country: 'Brazil', termType: 'TERMINOLOGY', observationType: 'ENRICHMENT',
    sourceEvidenceId: 'structured-b3-entity', nativeEvidenceStatus: 'NATIVE_OBSERVED', sourceProvenanceFamily: 'STRUCTURED_LOCAL_ENTITY'
  }, runner);
  await observeTerminology({
    term: 'structured mixed native', country: 'Brazil', termType: 'TERMINOLOGY', observationType: 'VIDEO_TITLE',
    videoId: 'governed-vocabulary', nativeEvidenceStatus: 'BOOTSTRAP_SEED', sourceProvenanceFamily: 'COUNTRY_VOCABULARY'
  }, runner);
  const projection = await recomputeNativeEvidenceProjection(termId!, runner);
  assert.equal(projection?.sourceProvenanceFamily, 'CREATOR_METADATA', 'creator metadata remains the dominant same-status family');
  assert.equal(projection?.structuredEntityMatched, true, 'structured native evidence is persisted independently of dominance');
  assert.equal(projection?.nativeProposalEligible, true);
  assert.deepEqual(effectiveProjectionProposalEvidence({
    native_evidence_status: projection!.nativeEvidenceStatus,
    source_provenance_family: projection!.sourceProvenanceFamily,
    source_provenance_families: projection!.sourceProvenanceFamilies,
    bootstrap_seed_count: projection!.bootstrapSeedCount,
    quality_creator_count: projection!.qualityCreatorCount,
    native_quality_creator_count: projection!.nativeQualityCreatorCount,
    structured_entity_matched: projection!.structuredEntityMatched
  }), { nativeEvidenceStatus: 'NATIVE_OBSERVED', sourceProvenanceFamily: 'CREATOR_METADATA', nativeGateSatisfied: true });
});

test('Phase 10: persisted-cursor round robin preserves generator ranking and has a bounded fairness guarantee', () => {
  const countries = Array.from({ length: 12 }, (_, index) => `Country ${index}`);
  const groups = countries.map(country => ({
    country,
    proposals: Array.from({ length: 3 }, (_, index) => ({
      proposalFamily: 'COUNTRY_NATIVE', country, dedupKey: `${country}:${2 - index}`, concept: index === 0 ? 'highest-ranked' : 'lower-ranked'
    } as DiscoveryFrontierProposal))
  }));
  const first = selectFairCountryNativeProposals(groups, 5, 0);
  assert.deepEqual(selectFairCountryNativeProposals(groups, 5, 0), first);
  assert.equal(first.length, 5);
  assert.equal(new Set(first.map(proposal => proposal.country)).size, 5);
  assert.ok(first.every(proposal => proposal.concept === 'highest-ranked'));
  const served = new Set<string>();
  for (let cursor = 0; cursor < countries.length; cursor += 5) {
    const selected = selectFairCountryNativeProposals(groups, 5, cursor);
    assert.ok(selected.length <= 5);
    selected.forEach(proposal => served.add(proposal.country));
  }
  assert.deepEqual([...served].sort(), [...countries].sort());
});

test('Phase 10: the existing autonomous producer materializes only bounded native proposals before Phase 8 allocation', () => {
  const source = fs.readFileSync(new URL('./autonomousDiscovery.ts', import.meta.url), 'utf8');
  assert.match(source, /materializeBoundedCountryNativeProposals/);
  assert.doesNotMatch(source, /generateFrontierProposalsForCountry/);
  assert.match(source, /country_native_materialization_cursor/);
  assert.match(source, /fairnessCursor: nativeFairnessCursor/);
  assert.ok(
    source.indexOf('materializeBoundedCountryNativeProposals') < source.indexOf('evaluateShadowFrontierAllocation({ opportunityKey'),
    'proposal materialization must precede the existing Phase 8 allocation boundary'
  );
});

test('Phase 10: a hung optional materializer is bounded and native neighborhoods are executable identities', async () => {
  const started = Date.now();
  const never = new Promise<string>(() => undefined);
  assert.equal(await settleBeforeDeadline(never, 20, 'legacy-continues'), 'legacy-continues');
  assert.ok(Date.now() - started < 500, 'deadline must release the producer promptly');
  const proposal = buildFrontierProposal({
    proposalFamily: 'COUNTRY_NATIVE', country: 'Japan', concept: '日経平均',
    sourceProvenance: 'native:test', supportingEvidence: { nativeTerm: '日経平均' },
    noveltyRationale: 'test'
  });
  assert.equal(proposal.targetDimensions.retrievalLane, 'VIDEO');
  assert.equal(proposal.targetDimensions.searchOrdering, 'RELEVANCE');
  assert.equal(proposal.targetDimensions.sourceFamily, 'automated_query');
});

test('Phase 10: every scheduler skip has an explicit reservation disposition and successful scheduling consumes once', () => {
  const scheduler = fs.readFileSync(new URL('./autonomousDiscovery.ts', import.meta.url), 'utf8');
  const allocator = fs.readFileSync(new URL('./discoveryFrontierAllocator.ts', import.meta.url), 'utf8');
  const db = fs.readFileSync(new URL('./db.ts', import.meta.url), 'utf8');
  assert.match(scheduler, /Batch diversity guard skipped reserved allocation/);
  assert.match(scheduler, /quarantineUnexecutableAllocation/);
  assert.match(allocator, /trial_status='EXPIRED'/);
  assert.match(allocator, /STALE_RESERVATION_RECOVERED/);
  assert.match(db, /SET trial_status='TRIED'/);
  assert.match(db, /p\.trial_status='PENDING'/);
  assert.match(db, /WHERE id=\$1 AND status<>'COMPLETED'/);
});

test('Phase 10: authoritative query completion attributes native outcomes through persisted allocation lineage', () => {
  const source = fs.readFileSync(new URL('./db.ts', import.meta.url), 'utf8');
  assert.match(source, /attributeCompletedCountryNativeRun\(client,runId,metrics\)/);
  assert.match(source, /proposal_evidence_snapshot/);
  assert.doesNotMatch(source, /JOIN frontier_discovery_proposals p ON p\.proposal_id=d\.proposal_id/);
  assert.match(source, /attributeCountryNativePerformance/);
});

test('Phase 10: a novel native proposal is represented by the governed Query Intelligence plan', () => {
  const planned = planCountryNativeProposalQuery({
    country: 'United States',
    nativeTerm: 'fluxograma',
    targetIntent: 'strategy',
    allocationLineage: { decisionId: 'decision-1', proposalId: 'proposal-1', evidenceChecksum: 'abc' }
  });
  assert.ok(planned);
  assert.match(planned.query.toLowerCase(), /fluxograma/);
  assert.equal(planned.primaryTerm, 'fluxograma');
  assert.equal((planned.metadata.countryNativeAllocation as any).decisionId, 'decision-1');
  const governed = evaluateAutonomousQueryAuthority({
    id: 1, query: planned.query, country: 'United States', collection: 'EXPERIMENTAL',
    intent: planned.intent, times_executed: 0, total_channels_found: 0,
    unique_channels_found: 0, quality_channels_found: 0, community_channels_found: 0,
    avg_quality_score: 0, performance_score: 0, created_at: new Date(0).toISOString(),
    status: 'ACTIVE', primary_term: planned.primaryTerm, generation_metadata: planned.metadata
  });
  assert.equal(governed.eligible, true);
  assert.equal(planCountryNativeProposalQuery({ country: 'Unknown', nativeTerm: 'novel', targetIntent: 'strategy', allocationLineage: {} }), null,
    'an unconstructable native proposal fails closed without a generic query');
});
