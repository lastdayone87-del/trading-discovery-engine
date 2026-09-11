import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichmentOperationalFailure, hasDecisionGradeEvidenceWithoutFailedProviders, isFallbackCovered, isProviderDeferredEnrichmentError, manualRecheckDegradedError } from './enrichmentOperationalFailure';
import { decideJobFailure } from './db';
import { resolveUncertainLifecycle } from './enrichmentLifecycle';
import { evaluateReviewEligibilityV2 } from './reviewEligibility/policy';
import type { EvidenceCollectionReport, VerificationDecision } from './evidenceEngine';

function report(degraded:boolean, reasonCodes:string[]=[], sufficiency:EvidenceCollectionReport['sufficiency']='SUFFICIENT'):EvidenceCollectionReport {
  return {
    sufficiency, sparseMetadata:false, degraded, fieldsPresent:['video_titles'], reasonCodes:[],
    providers:[{provider:'gemini_semantic',availability:degraded?'FAILED':'AVAILABLE',evidenceCount:0,outcome:degraded?'FAILED_PROVIDER':'EXECUTED_NO_MATCH',reasonCodes}],
    terminalNegativeSufficiency:{status:'INSUFFICIENT',creatorLevelCoverage:false,independentSourceFamilies:0,independentObservations:0,reasonCodes:['TERMINAL_NEGATIVE_EVIDENCE_INSUFFICIENT']}
  };
}

function decision(args:{lifecycle:'CONFIRM'|'REJECT'|'ENRICH'|'REVIEW'; source?:'video_metadata'|'gemini_semantic'; degraded?:boolean; status?:VerificationDecision['status']}):VerificationDecision {
  const source=args.source||'video_metadata';
  const positive={id:'p1',source,polarity:'POSITIVE' as const,category:'METHODOLOGY_CONCEPT' as const,fact:'trading',rawMatches:['trading'],confidence:90,reliability:'HIGH' as const,reliabilityMultiplier:1,rawWeight:10,finalWeight:9,timestamp:new Date(0).toISOString()};
  const negative={...positive,id:'n1',polarity:'NEGATIVE' as const,category:'IRRELEVANT_DOMAIN' as const,finalWeight:-9};
  const stages=args.lifecycle==='CONFIRM'
    ? [{stage:'CANDIDATE_DETECTION' as const,disposition:'PASS' as const,reasonCodes:[],evidenceIds:['p1'],fields:[],metrics:{}},{stage:'CORROBORATION' as const,disposition:'PASS' as const,reasonCodes:[],evidenceIds:['p1'],fields:[],metrics:{}}]
    : args.lifecycle==='REJECT'
      ? [{stage:'CONTRADICTION' as const,disposition:'FAIL' as const,reasonCodes:[],evidenceIds:['n1'],fields:[],metrics:{}}]
      : [{stage:'CANDIDATE_DETECTION' as const,disposition:'ABSTAIN' as const,reasonCodes:[],evidenceIds:[],fields:[],metrics:{}}];
  return {
    status:args.status??(args.lifecycle==='CONFIRM'?'TRADING_CONFIRMED':args.lifecycle==='REJECT'?'NON_TRADING':'UNCERTAIN'),confidenceScore:50,category:'OTHER',multiVideoConsistencyRatio:0,
    positiveEvidence:[positive],negativeEvidence:args.lifecycle==='REJECT'?[negative]:[],totalPositiveWeight:9,totalNegativeWeight:args.lifecycle==='REJECT'?9:0,
    countryContextUsed:{country:'US',language:'en',matchedTerms:[],matchedNegativeTerms:[]},
    versions:{evidenceEngineVersion:'t',decisionEngineVersion:'t',scoringEngineVersion:'t',knowledgePackVersion:'t',geminiModelVersion:'t'},
    mathematicalJustification:'test',evidenceCollection:report(args.degraded??true,['PROVIDER_RATE_LIMIT'],'SUFFICIENT'),
    stagedClassification:{pipelineVersion:'test',stages,lifecycleAction:args.lifecycle},timestamp:new Date(0).toISOString()
  };
}

test('coarse SUFFICIENT metadata still retries when Gemini failed and no decision-grade stage is resolved',()=>{
  const d=decision({lifecycle:'ENRICH'});
  const ready=hasDecisionGradeEvidenceWithoutFailedProviders(d);
  assert.equal(ready,false);
  const error=enrichmentOperationalFailure(d.evidenceCollection,true,ready);
  assert.ok(error);
  assert.equal(decideJobFailure(error!,4,4,1_700_000_000_000).disposition,'RETRYING_WITHOUT_ATTEMPT');
});

test('independent confirm evidence may proceed despite optional Gemini degradation',()=>{
  const d=decision({lifecycle:'CONFIRM',source:'video_metadata'});
  const ready=hasDecisionGradeEvidenceWithoutFailedProviders(d);
  assert.equal(ready,true);
  assert.equal(enrichmentOperationalFailure(d.evidenceCollection,true,ready),null);
});

test('stage CONFIRM without a terminal confirmed decision still retries provider degradation',()=>{
  const d=decision({lifecycle:'CONFIRM',source:'video_metadata',status:'UNCERTAIN'});
  const ready=hasDecisionGradeEvidenceWithoutFailedProviders(d);
  assert.equal(ready,false);
  assert.ok(enrichmentOperationalFailure(d.evidenceCollection,true,ready));
});

test('stage REJECT without a terminal non-trading decision still retries provider degradation',()=>{
  const d=decision({lifecycle:'REJECT',source:'video_metadata',status:'UNCERTAIN'});
  const ready=hasDecisionGradeEvidenceWithoutFailedProviders(d);
  assert.equal(ready,false);
  assert.ok(enrichmentOperationalFailure(d.evidenceCollection,true,ready));
});

test('failed-provider evidence never qualifies as independent decision-grade support',()=>{
  const d=decision({lifecycle:'CONFIRM',source:'gemini_semantic'});
  assert.equal(hasDecisionGradeEvidenceWithoutFailedProviders(d),false);
  assert.ok(enrichmentOperationalFailure(d.evidenceCollection,true,false));
});

test('insufficient degraded enrichment remains an attempt-free infrastructure retry',()=>{
  const error=enrichmentOperationalFailure(report(true,['PROVIDER_TIMEOUT'],'INSUFFICIENT'),true,false);
  assert.ok(error);
  assert.equal(error!.name,'OperationalEnrichmentProviderError');
  assert.equal(error!.retryable,true);
  assert.equal(error!.errorClass,'TRANSIENT');
});

test('all governed operational provider failure classes remain retryable without decision-grade support',()=>{
  for(const reason of ['PROVIDER_TIMEOUT','PROVIDER_RATE_LIMIT','PROVIDER_TRANSIENT_FAILURE','PROVIDER_CREDENTIALS_EXHAUSTED','PROVIDER_CANCELLED','PROVIDER_EXECUTION_FAILED']) {
    const error=enrichmentOperationalFailure(report(true,[reason]),true,false);
    assert.ok(error,reason);
  }
});

test('non-enrichment and permanent-input degradation are not rewritten by this guard',()=>{
  assert.equal(enrichmentOperationalFailure(report(true,['PROVIDER_TIMEOUT']),false,false),null);
  assert.equal(enrichmentOperationalFailure(report(true,['PROVIDER_PERMANENT_INPUT']),true,false),null);
});

test('fully observed genuine ambiguity can still reach human review when providers are healthy',()=>{
  assert.equal(enrichmentOperationalFailure(report(false),true,false),null);
  const eligibility=evaluateReviewEligibilityV2({classificationStatus:'UNCERTAIN',investigationState:'UNRESOLVED',plausibleTradingHypothesis:true,evidenceSufficient:true,independentEvidence:true,countryAllowed:true,operationalFailure:false,providerDegraded:false,unsupportedLanguage:false,terminalDecision:false});
  assert.deepEqual(resolveUncertainLifecycle(true,eligibility),{scanStatus:'NEEDS_REVIEW',tradingStatus:'NEEDS_REVIEW',shouldEnqueue:false});
});


test('only machine-owned operational provider errors project PROVIDER_DEFERRED',()=>{
  const error=enrichmentOperationalFailure(report(true,['PROVIDER_RATE_LIMIT']),true,false);
  assert.ok(error);
  assert.equal(isProviderDeferredEnrichmentError(error),true);
  assert.equal(isProviderDeferredEnrichmentError(new Error('ordinary pipeline failure')),false);
  assert.equal(isProviderDeferredEnrichmentError({name:'ProviderCallError',errorClass:'RATE_LIMIT',retryable:true}),false);
});

function fallbackReport(): EvidenceCollectionReport {
  return {
    sufficiency: 'SUFFICIENT', sparseMetadata: false, degraded: true,
    fieldsPresent: ['video_titles'], reasonCodes: ['PROVIDER_COVERAGE_DEGRADED'],
    providers: [
      { provider: 'gemini_semantic', availability: 'FAILED', evidenceCount: 0, outcome: 'FAILED_PROVIDER', reasonCodes: ['PROVIDER_RATE_LIMIT'], durationMs: 5 },
      { provider: 'groq_semantic', availability: 'AVAILABLE', evidenceCount: 0, outcome: 'ABSTAINED_LOW_CONFIDENCE', reasonCodes: ['SEMANTIC_MODEL_ABSTAINED', 'SEMANTIC_FALLBACK_SUCCEEDED'], durationMs: 9 },
    ],
    terminalNegativeSufficiency: { status: 'INSUFFICIENT', creatorLevelCoverage: false, independentSourceFamilies: 0, independentObservations: 0, reasonCodes: ['TERMINAL_NEGATIVE_EVIDENCE_INSUFFICIENT'] }
  };
}

test('served Groq fallback is operationally successful even for non-terminal decisions', () => {
  const collection = fallbackReport();
  // The Gemini outage stays visible in telemetry...
  assert.ok(collection.providers.some(p => p.provider === 'gemini_semantic' && p.availability === 'FAILED'));
  // ...but the served fallback result is accepted instead of defer-retrying.
  assert.equal(enrichmentOperationalFailure(collection, true, false), null);
  assert.equal(isFallbackCovered(collection), true);
});

test('uncovered Gemini failure still retries on enrichment passes', () => {
  const d = decision({ lifecycle: 'ENRICH' });
  assert.equal(isFallbackCovered(d.evidenceCollection), false);
  assert.ok(enrichmentOperationalFailure(d.evidenceCollection, true, false));
});

test('non-semantic operational failure still throws despite semantic fallback coverage', () => {
  const collection = fallbackReport();
  collection.providers.push({
    provider: 'discord_metadata', availability: 'FAILED', evidenceCount: 0, outcome: 'FAILED_PROVIDER',
    reasonCodes: ['PROVIDER_TIMEOUT'], durationMs: 3,
  });
  const error = enrichmentOperationalFailure(collection, true, false);
  assert.ok(error);
  assert.match(String(error && (error as Error).message), /discord/);
});

test('manual recheck gate accepts fallback-covered semantic failures', () => {
  assert.equal(manualRecheckDegradedError(fallbackReport()), null);
});

test('manual recheck gate still rejects uncovered degradation', () => {
  const d = decision({ lifecycle: 'ENRICH' });
  const error = manualRecheckDegradedError(d.evidenceCollection);
  assert.ok(error);
  assert.equal((error as { code?: string }).code, 'MANUAL_RESCAN_CLASSIFICATION_DEGRADED');
  assert.equal((error as { retryable?: boolean }).retryable, true);
});

test('manual recheck gate still rejects non-semantic failures despite coverage', () => {
  const collection = fallbackReport();
  collection.providers.push({
    provider: 'discord_metadata', availability: 'FAILED', evidenceCount: 0, outcome: 'FAILED_PROVIDER',
    reasonCodes: ['PROVIDER_TIMEOUT'], durationMs: 3,
  });
  assert.ok(manualRecheckDegradedError(collection));
});

test('uncoveredFailedProviders exempts only covered semantic failures', async () => {
  const { uncoveredFailedProviders } = await import('./enrichmentOperationalFailure');
  const coveredOnly = fallbackReport();
  assert.deepEqual(uncoveredFailedProviders(coveredOnly), []);
  const withDiscord = fallbackReport();
  withDiscord.providers.push({
    provider: 'discord_metadata', availability: 'FAILED', evidenceCount: 0, outcome: 'FAILED_PROVIDER',
    reasonCodes: ['PROVIDER_TIMEOUT'], durationMs: 3,
  });
  assert.deepEqual(uncoveredFailedProviders(withDiscord), ['discord_metadata']);
  const plain = report(true, ['PROVIDER_RATE_LIMIT']);
  assert.deepEqual(uncoveredFailedProviders(plain), ['gemini_semantic']);
  assert.deepEqual(uncoveredFailedProviders(report(false)), []);
});

test('failed semantic report preserves its quota org into the operational wrapper', () => {
  const r = report(true, ['PROVIDER_RATE_LIMIT'], 'SUFFICIENT');
  r.providers[0].provider = 'groq_semantic';
  (r.providers[0] as { orgId?: string }).orgId = 'slot-2';
  const error = enrichmentOperationalFailure(r, true, false);
  assert.ok(error, 'degraded enrichment without decision-grade support must throw');
  const failures = (error as unknown as { providerFailures: Array<{ provider: string; reasonCodes: string[]; orgId?: string }> }).providerFailures;
  assert.equal(failures[0].orgId, 'slot-2');
  assert.match(error!.message, /groq_semantic\[PROVIDER_RATE_LIMIT\]/, 'message shape unchanged by org tracking');
});

test('reports without an org produce wrapper entries without an org', () => {
  const r = report(true, ['PROVIDER_RATE_LIMIT'], 'SUFFICIENT');
  const error = enrichmentOperationalFailure(r, true, false);
  assert.ok(error);
  const failures = (error as unknown as { providerFailures: Array<{ orgId?: string }> }).providerFailures;
  assert.equal('orgId' in failures[0], false);
});

test('failedProviderOrg prefers wrapper entries, then sidecars, then undefined', async () => {
  const { failedProviderOrg } = await import('./dbCore');
  assert.equal(
    failedProviderOrg({ providerFailures: [{ provider: 'groq_semantic', reasonCodes: ['PROVIDER_RATE_LIMIT', 'GROQ_RATE_LIMITED'], orgId: 'slot-2' }] }, ['GROQ_RATE_LIMITED']),
    'slot-2'
  );
  assert.equal(
    failedProviderOrg({ providerFailures: [{ provider: 'groq_semantic', reasonCodes: ['PROVIDER_RATE_LIMIT', 'GROQ_RATE_LIMITED'], orgId: 'slot-2' }], groqOrg: 'slot-9' }, ['GROQ_RATE_LIMITED']),
    'slot-2',
    'wrapper entry wins over a stale sidecar'
  );
  assert.equal(
    failedProviderOrg({ providerReasons: ['GROQ_RATE_LIMITED'], groqOrg: 'slot-3' }, ['GROQ_RATE_LIMITED']),
    'slot-3'
  );
  assert.equal(
    failedProviderOrg({ providerFailures: [{ provider: 'gemini_semantic', reasonCodes: ['PROVIDER_RATE_LIMIT', 'SEMANTIC_DEFERRED_RATE_PRESSURE'], orgId: 'slot-1' }] }, ['SEMANTIC_DEFERRED_RATE_PRESSURE']),
    'slot-1'
  );
  assert.equal(failedProviderOrg({ providerReasons: ['GROQ_RATE_LIMITED'] }, ['GROQ_RATE_LIMITED']), undefined);
  assert.equal(failedProviderOrg({ providerFailures: [{ provider: 'groq_semantic', reasonCodes: ['PROVIDER_RATE_LIMIT'] }] }, ['GROQ_RATE_LIMITED']), undefined);
});

test('semantic chain FAILED reports carry the failed quota org', async () => {
  const { executeSemanticChain } = await import('./evidenceEngine');
  const { ProviderCallError } = await import('./providerResilience');
  const failing = {
    name: 'groq_semantic',
    availability: () => ({ availability: 'AVAILABLE' as const }),
    collectEvidence: async () => {
      throw Object.assign(new ProviderCallError('Rate limit reached.', 'RATE_LIMIT', true), { groqOrg: 'slot-2', providerReasons: ['GROQ_RATE_LIMITED'] });
    },
  };
  const { reports } = await executeSemanticChain([failing] as any, {} as any, {} as any);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].availability, 'FAILED');
  assert.equal((reports[0] as { orgId?: string }).orgId, 'slot-2');
});

test('per-org cooldown resolvers scope by org label, not route', async () => {
  const groq = await import('./evidenceEngine/providers/GroqSemanticProvider') as unknown as Record<string, unknown>;
  assert.equal(groq.resolveGroqOrgCooldownExpiryMs, undefined, 'resolvers live in dbCore, not the provider module');
  const dbCore = await import('./dbCore');
  assert.equal(typeof dbCore.resolveGroqOrgCooldownExpiryMs, 'function');
  assert.equal(typeof dbCore.resolveGeminiOrgSemanticCooldownExpiryMs, 'function');
  const groqFn = dbCore.resolveGroqOrgCooldownExpiryMs.toString();
  assert.ok(groqFn.includes("request_metadata->>'groqOrg'"), 'groq resolver must scope by org tag');
  const geminiFn = dbCore.resolveGeminiOrgSemanticCooldownExpiryMs.toString();
  assert.ok(geminiFn.includes("request_metadata->>'geminiOrg'"), 'gemini resolver must scope by org tag');
});

test('exhausted groq org survives wrapping with its rate-limit reason for org-scoped retry', async () => {
  const { failedProviderOrg } = await import('./dbCore');
  const r = report(true, ['PROVIDER_RATE_LIMIT', 'GROQ_RATE_LIMITED'], 'SUFFICIENT');
  r.providers[0].provider = 'groq_semantic';
  (r.providers[0] as { orgId?: string }).orgId = 'slot-2';
  const error = enrichmentOperationalFailure(r, true, false);
  assert.ok(error, 'groq outage without decision-grade support must throw');
  assert.ok(error!.providerReasons.includes('GROQ_RATE_LIMITED'), 'rate-limit reason must survive wrapping for retry alignment');
  assert.equal(
    failedProviderOrg(error, ['GROQ_RATE_LIMITED']),
    'slot-2',
    'retry scheduling must resolve the failed org, not a pool-wide window'
  );
});

test('org resolvers scope strictly by org tag: untagged rows cool no account', async () => {
  const dbCore = await import('./dbCore');
  for (const fn of [dbCore.resolveGeminiOrgSemanticCooldownExpiryMs, dbCore.resolveGroqOrgCooldownExpiryMs]) {
    const source = fn.toString();
    assert.ok(source.includes('request_metadata->>'), 'resolver must scope by metadata tag');
  }
  const gemini = dbCore.resolveGeminiOrgSemanticCooldownExpiryMs.toString();
  assert.ok(gemini.includes("request_metadata->>'geminiOrg'=$1"), 'gemini resolver must match the queried org only');
  assert.ok(!gemini.includes('IS NULL'), 'untagged gemini rows must not poison explicitly labelled accounts');
  const groq = dbCore.resolveGroqOrgCooldownExpiryMs.toString();
  assert.ok(groq.includes("request_metadata->>'groqOrg'=$1"), 'groq resolver must match the queried org only');
  assert.ok(!groq.includes("groqOrg' IS NULL"), 'untagged groq rows must not poison explicitly labelled orgs');
});

test('direct gemini PROVIDER_RATE_LIMIT with known org resolves scoped, others do not', async () => {
  const { failedProviderOrg } = await import('./dbCore');
  const codes = ['SEMANTIC_DEFERRED_RATE_PRESSURE', 'GEMINI_CAPACITY_DEFERRED', 'PROVIDER_RATE_LIMIT'];
  const scoped = ['gemini_semantic'];
  assert.equal(
    failedProviderOrg({ providerFailures: [{ provider: 'gemini_semantic', reasonCodes: ['PROVIDER_RATE_LIMIT'], orgId: 'slot-2' }] }, codes, scoped),
    'slot-2',
    'direct upstream gemini 429 must schedule against its own account cooldown'
  );
  assert.equal(
    failedProviderOrg({ providerReasons: ['PROVIDER_RATE_LIMIT'], geminiOrg: 'slot-1' }, codes, scoped),
    'slot-1',
    'raw sidecar path resolves without wrapper entries'
  );
  assert.equal(
    failedProviderOrg({ providerFailures: [{ provider: 'discord_metadata', reasonCodes: ['PROVIDER_RATE_LIMIT'], orgId: 'slot-9' }] }, codes, scoped),
    undefined,
    'non-semantic rate limits must never resolve to a gemini account'
  );
  assert.equal(
    failedProviderOrg({ providerReasons: ['PROVIDER_RATE_LIMIT'] }, codes, scoped),
    undefined,
    'unattributed rate limits keep generic backoff instead of a global gemini window'
  );
});

test('direct gemini rate limit survives the operational wrapper with its org', () => {
  const r = report(true, ['PROVIDER_RATE_LIMIT'], 'SUFFICIENT');
  (r.providers[0] as { provider: unknown }).provider = 'gemini_semantic';
  (r.providers[0] as { orgId?: string }).orgId = 'slot-1';
  const error = enrichmentOperationalFailure(r, true, false);
  assert.ok(error, 'gemini outage without decision-grade support must throw');
  assert.ok(error!.providerReasons.includes('PROVIDER_RATE_LIMIT'));
  assert.equal((error as unknown as { providerFailures: Array<{ orgId?: string }> }).providerFailures[0].orgId, 'slot-1');
});
