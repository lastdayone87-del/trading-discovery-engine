import test from 'node:test'; import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
import { executeProviderCall, classifyProviderError, ProviderCallError, decideGeminiCapacity, isGeminiCapacityDeferral, isGeminiScaleGateDeferral, resolveGeminiRouteId, extractGoogleQuotaFailure, parseProviderRetryDelayMs, nextPacificMidnightMs, providerCooldownExpiryMs, type ProviderCallEvent } from './providerResilience';

test('successful calls emit bounded, payload-free cost telemetry',async()=>{const events:ProviderCallEvent[]=[];const result=await executeProviderCall({context:{provider:'fake',operation:'read',actualCost:3,requestId:'r',runId:'run-1',jobId:'job-1',requestMetadata:{regionCode:'FR',relevanceLanguage:'fr'},attempt:2},timeoutMs:50,call:async()=>({secret:'not logged'}),emit:async e=>{events.push(e)}});assert.equal(result.secret,'not logged');assert.equal(events[0].status,'SUCCESS');assert.equal(events[0].actualCost,3);assert.equal(events[0].requestId,'r');assert.equal(events[0].runId,'run-1');assert.equal(events[0].jobId,'job-1');assert.deepEqual(events[0].requestMetadata,{regionCode:'FR',relevanceLanguage:'fr'});assert.equal(events[0].attempt,2);assert.equal(JSON.stringify(events).includes('not logged'),false)});
test('deadline aborts a fake provider and produces a retryable typed timeout',async()=>{const events:ProviderCallEvent[]=[];await assert.rejects(executeProviderCall({context:{provider:'fake',operation:'hang'},timeoutMs:10,call:signal=>new Promise((_r,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')))),emit:async e=>{events.push(e)}}),(e:any)=>e instanceof ProviderCallError&&e.errorClass==='TIMEOUT'&&e.retryable);assert.equal(events[0].status,'TIMEOUT')});
test('a caller-supplied TIMEOUT abort keeps its class instead of collapsing to CANCELLED',async()=>{const events:ProviderCallEvent[]=[];const controller=new AbortController();await assert.rejects(executeProviderCall({context:{provider:'fake',operation:'read'},timeoutMs:500,signal:controller.signal,call:signal=>new Promise((_resolve,reject)=>{signal.addEventListener('abort',()=>reject(new Error('caller aborted')));controller.abort({errorClass:'TIMEOUT'});}),emit:async event=>{events.push(event)}}),(error:any)=>error instanceof ProviderCallError&&error.errorClass==='TIMEOUT'&&error.retryable);assert.equal(events[0].status,'TIMEOUT')});
test('rate-limit classification preserves provider diagnostics',()=>{const source=Object.assign(new Error('YouTube HTTP 429 RESOURCE_EXHAUSTED (RATE_LIMIT_EXCEEDED)'),{status:429,quotaExceeded:false,providerReasons:['RATE_LIMIT_EXCEEDED']});const error=classifyProviderError(source);assert.equal(error.status,429);assert.equal(error.quotaExceeded,false);assert.deepEqual(error.providerReasons,['RATE_LIMIT_EXCEEDED']);assert.equal(error.cause,source)});
test('permanent input classification preserves safe status metadata',()=>{const source=Object.assign(new Error('bad request'),{status:400,providerReasons:['INVALID_ARGUMENT']});const error=classifyProviderError(source);assert.equal(error.errorClass,'PERMANENT_INPUT');assert.equal(error.status,400);assert.deepEqual(error.providerReasons,['INVALID_ARGUMENT']);assert.equal(error.retryable,false)});
test('cancellation and retry classes are deterministic',()=>{assert.equal(classifyProviderError(Object.assign(new Error('x'),{status:429})).errorClass,'RATE_LIMIT');assert.equal(classifyProviderError(Object.assign(new Error('x'),{status:400})).retryable,false);assert.equal(classifyProviderError(Object.assign(new Error('x'),{status:503})).errorClass,'TRANSIENT')});

test('telemetry sink failure cannot convert provider success into failure',async()=>{const result=await executeProviderCall({context:{provider:'fake',operation:'read'},timeoutMs:50,call:async()=>({ok:true}),emit:async()=>{throw new Error('telemetry unavailable')}});assert.equal(result.ok,true)});

test('vocabulary is deferred during recent Gemini rate pressure',()=>{const now=1_000_000;const decision=decideGeminiCapacity('vocabulary-extraction',{nowMs:now,lastRateLimitAtMs:now-1_000},{globalMinIntervalMs:6_000,semanticRateLimitCooldownMs:90_000,vocabularyRateLimitSuppressionMs:900_000,vocabularySemanticQuietMs:120_000,vocabularyMinIntervalMs:30_000,maxInlineWaitMs:8_000});assert.equal(decision.action,'DEFER');assert.equal(decision.reasonCode,'VOCABULARY_DEFERRED_RATE_PRESSURE')});

test('vocabulary yields to recent semantic classification even without a rate limit',()=>{const now=1_000_000;const decision=decideGeminiCapacity('vocabulary-extraction',{nowMs:now,lastSemanticAtMs:now-30_000},{globalMinIntervalMs:6_000,semanticRateLimitCooldownMs:90_000,vocabularyRateLimitSuppressionMs:900_000,vocabularySemanticQuietMs:120_000,vocabularyMinIntervalMs:30_000,maxInlineWaitMs:8_000});assert.equal(decision.action,'DEFER');assert.equal(decision.reasonCode,'VOCABULARY_DEFERRED_SEMANTIC_PRIORITY')});

test('semantic calls defer long rate-pressure cooldowns instead of sleeping a worker',()=>{const now=1_000_000;const decision=decideGeminiCapacity('multilingual-semantic-classification',{nowMs:now,lastRateLimitAtMs:now-30_000,lastGeminiAtMs:now-2_000},{globalMinIntervalMs:6_000,semanticRateLimitCooldownMs:90_000,vocabularyRateLimitSuppressionMs:900_000,vocabularySemanticQuietMs:120_000,vocabularyMinIntervalMs:30_000,maxInlineWaitMs:8_000});assert.equal(decision.action,'DEFER');assert.equal(decision.reasonCode,'SEMANTIC_DEFERRED_RATE_PRESSURE');assert.equal(decision.waitMs,0)});

test('semantic calls may wait briefly for global spacing',()=>{const now=1_000_000;const decision=decideGeminiCapacity('multilingual-semantic-classification',{nowMs:now,lastGeminiAtMs:now-2_000},{globalMinIntervalMs:6_000,semanticRateLimitCooldownMs:90_000,vocabularyRateLimitSuppressionMs:900_000,vocabularySemanticQuietMs:120_000,vocabularyMinIntervalMs:30_000,maxInlineWaitMs:8_000});assert.equal(decision.action,'WAIT');assert.equal(decision.waitMs,4_000)});

test('vocabulary defers long capacity waits instead of occupying a worker',()=>{const now=1_000_000;const decision=decideGeminiCapacity('vocabulary-extraction',{nowMs:now,lastVocabularyAtMs:now-5_000},{globalMinIntervalMs:6_000,semanticRateLimitCooldownMs:90_000,vocabularyRateLimitSuppressionMs:900_000,vocabularySemanticQuietMs:120_000,vocabularyMinIntervalMs:30_000,maxInlineWaitMs:8_000});assert.equal(decision.action,'DEFER');assert.equal(decision.reasonCode,'VOCABULARY_DEFERRED_CAPACITY_WAIT')});

test('semantic calls run once cooldown and global spacing are clear',()=>{const now=1_000_000;const decision=decideGeminiCapacity('multilingual-semantic-classification',{nowMs:now,lastRateLimitAtMs:now-100_000,lastGeminiAtMs:now-10_000},{globalMinIntervalMs:6_000,semanticRateLimitCooldownMs:90_000,vocabularyRateLimitSuppressionMs:900_000,vocabularySemanticQuietMs:120_000,vocabularyMinIntervalMs:30_000,maxInlineWaitMs:8_000});assert.equal(decision.action,'RUN');assert.equal(decision.waitMs,0)});


test('Gemini route identifiers are normalized to machine-owned slots',()=>{
  assert.equal(resolveGeminiRouteId(undefined),'gemini-1');
  assert.equal(resolveGeminiRouteId('gemini-4'),'gemini-4');
  assert.equal(resolveGeminiRouteId('GEMINI_API_KEY_4'),'gemini-1');
  assert.equal(resolveGeminiRouteId('gemini-0'),'gemini-1');
  assert.equal(resolveGeminiRouteId('gemini-4;DROP'),'gemini-1');
});

test('Gemini capacity queries are account-scoped and never use one global lock',()=>{
  const source=readFileSync('server/providerResilience.ts','utf8');
  // Phase 4: independent Google projects must not pace each other. Pacing,
  // cooldown, and the token bucket all read strict geminiOrg tags.
  assert.match(source,/request_metadata->>'geminiOrg'=\$1/);
  assert.match(source,/request_metadata->>'geminiOrg'=\$2/);
  assert.match(source,/pg_try_advisory_lock\(\$1,hashtext\(\$2\)\)/);
  assert.doesNotMatch(source,/pg_try_advisory_lock\(\$1\) AS acquired/);
  // Every SELECT path must be scoped, not just one representative query.
  const templates=source.match(/`[^`]*provider_call_events[^`]*`/g)||[];
  const reads=templates.filter(sql=>/SELECT/i.test(sql));
  assert.ok(reads.length>=5,'expected the account-scoped ledger reads');
  for(const sql of reads)assert.match(sql,/request_metadata->>'geminiOrg'/,'unscoped Gemini ledger read');
  for(const sql of reads.filter(sql=>/COUNT\(\*\)::int AS calls|operation=\$1/.test(sql))){
    assert.match(sql,/geminiCapacityDeferral/,'pacing/bucket reads must exclude deferral echoes');
  }
  assert.doesNotMatch(source,/provider='gemini' AND status='RATE_LIMITED'\s+AND occurred_at/,'cooldown read must not span every project');
});

test('Gemini capacity tagging covers every pre-call failure, not just deferral codes',()=>{
  // Lock waits, deadline aborts, and unknown pre-lease failures never reached
  // Google and must be excluded from pacing/bucket reads.
  assert.equal(isGeminiCapacityDeferral('gemini',false),true);
  // Once the provider call starts, quota is spent even if it then fails.
  assert.equal(isGeminiCapacityDeferral('gemini',true),false);
  assert.equal(isGeminiCapacityDeferral('groq',false),false);
});

test('the scale gate excludes only reason-coded capacity deferrals',()=>{
  // A lock-wait/deadline timeout has no deferral reason. It must stay in the
  // gate denominator so higher concurrency cannot hide its own contention.
  assert.equal(isGeminiScaleGateDeferral('gemini',false,new ProviderCallError('lock wait timed out','TIMEOUT',true)),false);
  const rateDeferred=new ProviderCallError('deferred','TRANSIENT',true,{providerReasons:['SEMANTIC_DEFERRED_RATE_PRESSURE']});
  const bucketDeferred=new ProviderCallError('bucket empty','TRANSIENT',true,{providerReasons:['GEMINI_ORG_TOKEN_BUCKET_EMPTY']});
  assert.equal(isGeminiScaleGateDeferral('gemini',false,rateDeferred),true);
  assert.equal(isGeminiScaleGateDeferral('gemini',false,bucketDeferred),true);
  // A post-call failure already spent quota and is always counted.
  assert.equal(isGeminiScaleGateDeferral('gemini',true,rateDeferred),false);
  assert.equal(isGeminiScaleGateDeferral('groq',false,rateDeferred),false);
});

test('an already-aborted caller never starts a provider call',async()=>{
  let called=0;
  const controller=new AbortController(); controller.abort();
  await assert.rejects(executeProviderCall({
    context:{provider:'fake',operation:'read'},
    timeoutMs:50,
    signal:controller.signal,
    call:async()=>{called++;return {ok:true}},
    emit:async()=>undefined,
  }),(error:any)=>error instanceof ProviderCallError&&error.errorClass==='CANCELLED');
  assert.equal(called,0);
});

test('Google daily quota failures carry the provider reset window and scope', () => {
  const message = JSON.stringify({
    error: {
      code: 429,
      status: 'RESOURCE_EXHAUSTED',
      details: [
        { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '61986.75s' },
      ],
    },
  });
  const now = 1_000_000;
  const error = classifyProviderError(Object.assign(new Error(message), { status: 429 }), now);
  assert.equal(error.errorClass, 'RATE_LIMIT');
  assert.equal(error.retryable, true);
  assert.equal(error.quotaScope, 'DAILY');
  assert.equal(error.retryAfterMs, 61_986_750);
  assert.equal(error.cooldownUntilMs, now + 61_986_750);
  assert.equal(error.quotaId, 'GenerateRequestsPerDayPerProjectPerModel-FreeTier');
  assert.ok(error.providerReasons?.includes('PROVIDER_QUOTA_DAILY'));
});

test('daily quota without RetryInfo falls back to the next Pacific midnight', () => {
  const message = JSON.stringify({
    error: {
      details: [
        { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] },
      ],
    },
  });
  // Nov 7 2026 12:00 UTC is 04:00 PST; the next Pacific midnight is 08:00 UTC.
  const now = Date.UTC(2026, 10, 7, 12, 0, 0);
  const error = classifyProviderError(Object.assign(new Error(message), { status: 429 }), now);
  assert.equal(error.cooldownUntilMs, Date.UTC(2026, 10, 8, 8, 0, 0));
});

test('next Pacific midnight is stable across both DST transitions', () => {
  assert.equal(nextPacificMidnightMs(Date.UTC(2026, 2, 7, 12)), Date.UTC(2026, 2, 8, 8));
  assert.equal(nextPacificMidnightMs(Date.UTC(2026, 2, 8, 12)), Date.UTC(2026, 2, 9, 7));
  assert.equal(nextPacificMidnightMs(Date.UTC(2026, 9, 31, 12)), Date.UTC(2026, 10, 1, 7));
  assert.equal(nextPacificMidnightMs(Date.UTC(2026, 10, 1, 12)), Date.UTC(2026, 10, 2, 8));
});

test('retry-delay parsing accepts Google duration strings and rejects junk', () => {
  assert.equal(parseProviderRetryDelayMs('59s'), 59_000);
  assert.equal(parseProviderRetryDelayMs('61.5s'), 61_500);
  assert.equal(parseProviderRetryDelayMs(2.5), 2_500);
  assert.equal(parseProviderRetryDelayMs('soon'), undefined);
  assert.equal(parseProviderRetryDelayMs(-1), undefined);
});

test('quota extraction ignores unrelated JSON and never throws', () => {
  assert.deepEqual(extractGoogleQuotaFailure(Object.assign(new Error('plain 429'), { status: 429 })), {});
  assert.deepEqual(extractGoogleQuotaFailure({ message: '{"unrelated":true}' }), {});
  assert.deepEqual(extractGoogleQuotaFailure(null), {});
});

test('persisted cooldowns honor the longer provider-declared expiry', () => {
  const occurredAt = '2026-11-07T12:00:00.000Z';
  const occurredMs = Date.parse(occurredAt);
  assert.equal(providerCooldownExpiryMs(occurredAt, occurredMs + 3_600_000, 90_000, occurredMs + 1_000), occurredMs + 3_600_000);
  assert.equal(providerCooldownExpiryMs(occurredAt, null, 90_000, occurredMs + 1_000), occurredMs + 90_000);
  assert.equal(providerCooldownExpiryMs(occurredAt, '', 90_000, occurredMs + 120_000), undefined);
  assert.equal(providerCooldownExpiryMs(null, null, 90_000, occurredMs), undefined);
});

test('a declared daily cooldown defers semantic Gemini calls instead of pacing them', () => {
  const now = 1_000_000;
  const config = { globalMinIntervalMs: 6_000, semanticRateLimitCooldownMs: 90_000, vocabularyRateLimitSuppressionMs: 900_000, vocabularySemanticQuietMs: 120_000, vocabularyMinIntervalMs: 30_000, maxInlineWaitMs: 8_000 };
  const decision = decideGeminiCapacity('multilingual-semantic-classification', {
    nowMs: now,
    lastRateLimitAtMs: now - 200_000,
    rateLimitCooldownUntilMs: now + 3_600_000,
  }, config);
  assert.equal(decision.action, 'DEFER');
  assert.equal(decision.reasonCode, 'SEMANTIC_DEFERRED_RATE_PRESSURE');
});

test('a declared daily cooldown also suppresses vocabulary extraction', () => {
  const now = 1_000_000;
  const config = { globalMinIntervalMs: 6_000, semanticRateLimitCooldownMs: 90_000, vocabularyRateLimitSuppressionMs: 900_000, vocabularySemanticQuietMs: 120_000, vocabularyMinIntervalMs: 30_000, maxInlineWaitMs: 8_000 };
  const decision = decideGeminiCapacity('vocabulary-extraction', {
    nowMs: now,
    lastRateLimitAtMs: now - 10_000_000,
    rateLimitCooldownUntilMs: now + 3_600_000,
  }, config);
  assert.equal(decision.action, 'DEFER');
  assert.equal(decision.reasonCode, 'VOCABULARY_DEFERRED_RATE_PRESSURE');
});

test('non-quota YouTube 403 stays transient while semantic credential 403 is route-scoped', () => {
  const youtube = classifyProviderError(Object.assign(new Error('YouTube HTTP 403 forbidden'), { status: 403 }), Date.now(), 'youtube');
  assert.equal(youtube.errorClass, 'TRANSIENT');
  assert.equal(youtube.routeScoped, false);
  const gemini = classifyProviderError(Object.assign(new Error('permission denied'), { status: 403 }), Date.now(), 'gemini');
  assert.equal(gemini.errorClass, 'TRANSIENT');
  assert.equal(gemini.retryable, true);
  assert.equal(gemini.routeScoped, true);
  assert.ok(gemini.providerReasons?.includes('PROVIDER_ROUTE_UNAUTHORIZED'));
});

test('transient-looking 400/404/422 messages stay retryable', () => {
  for (const status of [400, 404, 422]) {
    const error = classifyProviderError(Object.assign(new Error('upstream is temporarily unavailable'), { status }));
    assert.equal(error.errorClass, 'TRANSIENT', `status ${status} must stay transient`);
    assert.equal(error.retryable, true);
  }
  const permanent = classifyProviderError(Object.assign(new Error('bad argument'), { status: 400 }));
  assert.equal(permanent.errorClass, 'PERMANENT_INPUT');
  assert.equal(permanent.retryable, false);
});

test('a short declared retry delay never shortens the fixed semantic cooldown', () => {
  const now = 1_000_000;
  const config = { globalMinIntervalMs: 6_000, semanticRateLimitCooldownMs: 90_000, vocabularyRateLimitSuppressionMs: 900_000, vocabularySemanticQuietMs: 120_000, vocabularyMinIntervalMs: 30_000, maxInlineWaitMs: 8_000, semanticMaxInlineWaitMs: 8_000 };
  const decision = decideGeminiCapacity('multilingual-semantic-classification', {
    nowMs: now,
    lastRateLimitAtMs: now,
    rateLimitCooldownUntilMs: now + 5_000,
  }, config);
  // The 5s declared delay is shorter than the fixed 90s window. Before the
  // fix this returned WAIT(5s); it must stay deferred for the full window.
  assert.equal(decision.action, 'DEFER');
  assert.equal(decision.reasonCode, 'SEMANTIC_DEFERRED_RATE_PRESSURE');
});

test('an expired daily quota is not extended by the generic cooldown clocks', () => {
  const now = 1_000_000;
  const config = { globalMinIntervalMs: 6_000, semanticRateLimitCooldownMs: 90_000, vocabularyRateLimitSuppressionMs: 900_000, vocabularySemanticQuietMs: 120_000, vocabularyMinIntervalMs: 30_000, maxInlineWaitMs: 8_000, semanticMaxInlineWaitMs: 8_000 };
  const semantic = decideGeminiCapacity('multilingual-semantic-classification', {
    nowMs: now,
    lastRateLimitAtMs: now - 20_000,
    rateLimitCooldownUntilMs: now - 1_000,
    rateLimitQuotaScope: 'DAILY',
  }, config);
  assert.equal(semantic.action, 'RUN');
  const vocabulary = decideGeminiCapacity('vocabulary-extraction', {
    nowMs: now,
    lastRateLimitAtMs: now - 20_000,
    rateLimitCooldownUntilMs: now - 1_000,
    rateLimitQuotaScope: 'DAILY',
  }, config);
  assert.equal(vocabulary.action, 'RUN');
});

test('a per-minute declared reset still applies when it extends past the fixed cooldown', () => {
  const now = 1_000_000;
  const config = { globalMinIntervalMs: 6_000, semanticRateLimitCooldownMs: 90_000, vocabularyRateLimitSuppressionMs: 900_000, vocabularySemanticQuietMs: 120_000, vocabularyMinIntervalMs: 30_000, maxInlineWaitMs: 8_000, semanticMaxInlineWaitMs: 8_000 };
  const decision = decideGeminiCapacity('multilingual-semantic-classification', {
    nowMs: now,
    lastRateLimitAtMs: now - 10_000,
    rateLimitCooldownUntilMs: now + 120_000,
    rateLimitQuotaScope: 'MINUTE',
  }, config);
  assert.equal(decision.action, 'DEFER');
});
