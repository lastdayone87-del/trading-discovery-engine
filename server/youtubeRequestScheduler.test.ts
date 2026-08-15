import test from 'node:test';
import assert from 'node:assert/strict';
import { YouTubeRequestScheduler } from './youtubeRequestScheduler';
import { isYouTubeRateLimited } from './youtube';
import fs from 'node:fs';

test('serializes concurrent outbound calls and spaces their starts', async () => {
  let now = 0;
  const starts: number[] = [];
  const scheduler = new YouTubeRequestScheduler({
    minIntervalMs: 100,
    initialRateLimitBackoffMs: 500,
    maxRateLimitBackoffMs: 2_000,
    now: () => now,
    sleep: async ms => { now += ms; }
  });
  await Promise.all([
    scheduler.run(async () => { starts.push(now); }),
    scheduler.run(async () => { starts.push(now); }),
    scheduler.run(async () => { starts.push(now); })
  ]);
  assert.deepEqual(starts, [0, 100, 200]);
});

test('serves queued work by priority while preserving the active request', async () => {
  const order: string[] = [];
  let releaseActive!: () => void;
  const active = new Promise<void>(resolve => { releaseActive = resolve; });
  const scheduler = new YouTubeRequestScheduler({ minIntervalMs: 0, initialRateLimitBackoffMs: 500, maxRateLimitBackoffMs: 2_000 });
  const running = scheduler.run(async () => { await active; order.push('active'); }, undefined, 'enrichment');
  const recovery = scheduler.run(async () => { order.push('recovery'); }, undefined, 'incident-recovery');
  const enrichment = scheduler.run(async () => { order.push('enrichment'); }, undefined, 'enrichment');
  const autonomous = scheduler.run(async () => { order.push('autonomous'); }, undefined, 'autonomous');
  const manual = scheduler.run(async () => { order.push('manual'); }, undefined, 'manual');
  releaseActive();
  await Promise.all([running, recovery, enrichment, autonomous, manual]);
  assert.deepEqual(order, ['active', 'manual', 'autonomous', 'enrichment', 'recovery']);
});

test('aged enrichment cannot starve behind a continuous autonomous queue', async () => {
  let now = 0;
  const order: string[] = [];
  let releaseActive!: () => void;
  const active = new Promise<void>(resolve => { releaseActive = resolve; });
  const scheduler = new YouTubeRequestScheduler({ minIntervalMs: 1_000, initialRateLimitBackoffMs: 500, maxRateLimitBackoffMs: 2_000, starvationMs: 1_500, now: () => now, sleep: async ms => { now += ms; } });
  const running = scheduler.run(async () => { await active; order.push('active'); }, undefined, 'enrichment');
  const enrichment = scheduler.run(async () => { order.push('enrichment'); }, undefined, 'enrichment');
  const autonomous1 = scheduler.run(async () => { order.push('autonomous-1'); }, undefined, 'autonomous');
  const autonomous2 = scheduler.run(async () => { order.push('autonomous-2'); }, undefined, 'autonomous');
  const autonomous3 = scheduler.run(async () => { order.push('autonomous-3'); }, undefined, 'autonomous');
  releaseActive();
  await Promise.all([running, enrichment, autonomous1, autonomous2, autonomous3]);
  assert.deepEqual(order, ['active', 'autonomous-1', 'enrichment', 'autonomous-2', 'autonomous-3']);
});

test('starvation is re-evaluated after shared pacing delay before the next call starts', async () => {
  let now = 0;
  const order: string[] = [];
  let releaseActive!: () => void;
  const active = new Promise<void>(resolve => { releaseActive = resolve; });
  const scheduler = new YouTubeRequestScheduler({ minIntervalMs: 1_000, initialRateLimitBackoffMs: 500, maxRateLimitBackoffMs: 2_000, starvationMs: 500, now: () => now, sleep: async ms => { now += ms; } });
  const running = scheduler.run(async () => { await active; order.push('active'); }, undefined, 'enrichment');
  const enrichment = scheduler.run(async () => { order.push('enrichment'); }, undefined, 'enrichment');
  const autonomous = scheduler.run(async () => { order.push('autonomous'); }, undefined, 'autonomous');
  releaseActive();
  await Promise.all([running, enrichment, autonomous]);
  assert.deepEqual(order, ['active', 'enrichment', 'autonomous']);
});

test('provider rate limiting does not impose shared exponential cooldown', async () => {
  let now = 0;
  const starts: number[] = [];
  const scheduler = new YouTubeRequestScheduler({ minIntervalMs: 100, initialRateLimitBackoffMs: 500, maxRateLimitBackoffMs: 800, now: () => now, sleep: async ms => { now += ms; } });
  const rateLimit = () => Object.assign(new Error('YouTube HTTP 429 RESOURCE_EXHAUSTED (rateLimitExceeded)'), { status: 429, providerReasons: ['rateLimitExceeded'], quotaExceeded: false });
  await assert.rejects(scheduler.run(async () => { starts.push(now); throw rateLimit(); }));
  await assert.rejects(scheduler.run(async () => { starts.push(now); throw rateLimit(); }));
  await scheduler.run(async () => { starts.push(now); });
  assert.deepEqual(starts, [0, 100, 200]);
  assert.equal(scheduler.isRateLimited(), false);
});

test('distinguishes runtime rate limiting from project quota exhaustion through wrapped errors', () => {
  const rateLimit = Object.assign(new Error('YouTube HTTP 429 RESOURCE_EXHAUSTED (rateLimitExceeded)'), { status: 429, providerReasons: ['rateLimitExceeded'], quotaExceeded: false });
  assert.equal(isYouTubeRateLimited(Object.assign(new Error('Provider rate limit reached.'), { cause: rateLimit })), true);
  assert.equal(isYouTubeRateLimited(Object.assign(new Error('YouTube HTTP 403 (quotaExceeded)'), { status: 403, providerReasons: ['quotaExceeded'], quotaExceeded: true })), false);
});

test('youtubeFetch always bounds the scheduler head request', () => {
  const source = fs.readFileSync(new URL('./youtube.ts', import.meta.url), 'utf8');
  const youtubeFetch = source.slice(source.indexOf('async function youtubeFetch'), source.indexOf('/** Preserve both legacy'));
  assert.match(youtubeFetch, /timeout=Number\.isFinite\(configuredTimeout\)&&configuredTimeout>0\?configuredTimeout:30_000/);
  assert.match(youtubeFetch, /timeoutMs:timeout,enabled:true/);
  assert.doesNotMatch(youtubeFetch, /provider_deadlines_enabled|PROVIDER_DEADLINES_ENABLED/);
});

test('youtubeFetch reselects from the live provider pool at dispatch and clears the actual provider history on success', () => {
  const source = fs.readFileSync(new URL('./youtube.ts', import.meta.url), 'utf8');
  const youtubeFetch = source.slice(source.indexOf('async function youtubeFetch'), source.indexOf('export type YouTubeAdditionalQuotaCallback'));
  assert.match(youtubeFetch, /const livePool=getYouTubeKeyPool\(\)/);
  assert.match(youtubeFetch, /selectYouTubeDispatchProviderIndex\(livePool,providerKey\)/);
  assert.match(youtubeFetch, /rebuiltUrl\.searchParams\.set\('key',dispatchedProviderKey\)/);
  assert.match(youtubeFetch, /fetch\(dispatchedUrl,\{signal\}\)/);
  assert.match(youtubeFetch, /youtubeProviderCooldown\.succeeded\(dispatchedProviderKey\)/);
  assert.match(youtubeFetch, /Object\.assign\(error,\{providerKey:dispatchedProviderKey/);
});

test('youtubeFetch records the actual provider failure before scheduler release and prevents duplicate outer accounting', () => {
  const source = fs.readFileSync(new URL('./youtube.ts', import.meta.url), 'utf8');
  const youtubeFetch = source.slice(source.indexOf('async function youtubeFetch'), source.indexOf('export type YouTubeAdditionalQuotaCallback'));
  const failureBranch = youtubeFetch.slice(youtubeFetch.indexOf('if(!response.ok)'), youtubeFetch.indexOf('if(dispatchedProviderKey)youtubeProviderCooldown.succeeded'));
  assert.match(failureBranch, /youtubeProviderCooldown\.failed\(dispatchedProviderKey,'DAILY_QUOTA_EXHAUSTED'\)/);
  assert.match(failureBranch, /youtubeProviderCooldown\.failed\(dispatchedProviderKey,'RATE_LIMITED'\)/);
  assert.match(failureBranch, /providerFailureRecorded:true/);
  assert.ok(failureBranch.indexOf('youtubeProviderCooldown.failed') < failureBranch.indexOf('throw error'));
  const recorder = source.slice(source.indexOf('function recordProviderFailure'), source.indexOf('export function selectYouTubeDispatchProviderIndex'));
  assert.match(recorder, /providerFailureRecorded === true\) return/);
});

test('youtubeFetch preserves the already-recorded provider failure marker through ProviderCallError wrapping', () => {
  const source = fs.readFileSync(new URL('./youtube.ts', import.meta.url), 'utf8');
  const youtubeFetch = source.slice(source.indexOf('async function youtubeFetch'), source.indexOf('export type YouTubeAdditionalQuotaCallback'));
  assert.match(youtubeFetch, /const wrappedCause=\(error as any\)\.cause/);
  assert.match(youtubeFetch, /providerFailureRecorded=.*wrappedCause/);
  assert.match(youtubeFetch, /providerFailureRecorded:true/);
});

test('dispatch-time fallback failure is excluded when another healthy provider becomes available', () => {
  const source = fs.readFileSync(new URL('./youtube.ts', import.meta.url), 'utf8');
  const youtubeFetch = source.slice(source.indexOf('async function youtubeFetch'), source.indexOf('export type YouTubeAdditionalQuotaCallback'));
  assert.match(source, /failedDispatchProvidersByAcquisition = new WeakMap<object, Set<string>>/);
  assert.match(youtubeFetch, /!failedProviders\?\.has\(key\)/);
  assert.match(youtubeFetch, /if\(dispatchIndex<0\) dispatchIndex=selectYouTubeDispatchProviderIndex\(livePool,providerKey\)/);
  assert.match(youtubeFetch, /failedDispatchProviders\(acquisition\)\?\.add\(dispatchedProviderKey\)/);
});

test('transport failures record the actual dispatched provider before leaving youtubeFetch', () => {
  const source = fs.readFileSync(new URL('./youtube.ts', import.meta.url), 'utf8');
  const youtubeFetch = source.slice(source.indexOf('async function youtubeFetch'), source.indexOf('export type YouTubeAdditionalQuotaCallback'));
  const transportBranch = youtubeFetch.slice(youtubeFetch.indexOf('response=await fetch(dispatchedUrl,{signal})'), youtubeFetch.indexOf('trace(`after HTTP fetch'));
  assert.match(transportBranch, /catch \(error\)/);
  assert.match(transportBranch, /failedDispatchProviders\(acquisition\)\?\.add\(dispatchedProviderKey\)/);
  assert.match(transportBranch, /Object\.assign\(error,\{providerKey:dispatchedProviderKey\}\)/);
  assert.ok(transportBranch.indexOf('failedDispatchProviders') < transportBranch.indexOf('throw error'));
});

test('provider-loop requests carry the selected API key into scheduler dispatch', () => {
  const source = fs.readFileSync(new URL('./youtube.ts', import.meta.url), 'utf8');
  assert.match(source, /youtubeFetch\(searchUrl,'search',100,attempt\+1,acquisition,priority,apiKey\)/);
  assert.match(source, /youtubeFetch\(recentUrl,'channel-uploads',100,attempt\+1,acquisition,priority,apiKey\)/);
  assert.match(source, /youtubeFetch\(channelUrl,'channel-details',1,attempt\+1,acquisition,priority,apiKey\)/);
});

test('search provider loop retains key failover after a rate-limited attempt', () => {
  const source = fs.readFileSync(new URL('./youtube.ts', import.meta.url), 'utf8');
  const search = source.slice(source.indexOf('export async function searchYouTubeChannelPage'), source.indexOf('/**\n * Fetches recent video titles'));
  assert.match(search, /const providerIndexes = availableKeyIndexes\(keyPool\)/);
  assert.match(search, /for \(let attempt = 0; attempt < providerIndexes\.length; attempt\+\+\)/);
  assert.match(search, /recordProviderFailure\(apiKey, e\)/);
  assert.doesNotMatch(search, /isYouTubeRateLimited\(e\)[\s\S]*?throw e/);
});

test('search propagates the earliest retry when its final eligible provider enters cooldown', () => {
  const source = fs.readFileSync(new URL('./youtube.ts', import.meta.url), 'utf8');
  const search = source.slice(source.indexOf('export async function searchYouTubeChannelPage'), source.indexOf('/**\n * Fetches recent video titles'));
  assert.match(search, /recordProviderFailure\(apiKey, e\)[\s\S]*throwIfAllProvidersCoolingDown\(keyPool\)/);
});
