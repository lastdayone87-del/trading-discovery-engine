import test from 'node:test';
import assert from 'node:assert/strict';
import { YouTubeRequestScheduler } from './youtubeRequestScheduler';

function runtime429(providerKey:string,reasons=['rateLimitExceeded']) {
  return Object.assign(new Error('Provider rate limit reached.'), {
    status: 429,
    quotaExceeded: false,
    errorClass: 'RATE_LIMIT',
    providerReasons: reasons,
    providerKey
  });
}

test('runtime 429 trace attributes pressure without exposing provider credentials', async () => {
  let now=0;
  const traces:string[]=[];
  const scheduler=new YouTubeRequestScheduler({
    minIntervalMs:250,
    initialRateLimitBackoffMs:500,
    maxRateLimitBackoffMs:5_000,
    runtimeRateLimitFloorMs:1_000,
    maxAdaptiveIntervalMs:5_000,
    ratePressureWindowMs:60_000,
    now:()=>now,
    sleep:async ms=>{now+=ms;}
  });
  const secret='AIzaSySUPER_SECRET_PROVIDER_KEY';
  await assert.rejects(scheduler.run(async()=>{throw runtime429(secret);},stage=>traces.push(stage),'enrichment'));
  const diagnostic=traces.find(stage=>stage.startsWith('runtime-rate-pressure-diagnostic'));
  assert.ok(diagnostic);
  assert.match(diagnostic!,/status=429/);
  assert.match(diagnostic!,/quota=false/);
  assert.match(diagnostic!,/provider=ytp-[0-9a-f]{8}/);
  assert.match(diagnostic!,/quota-group=unconfigured/);
  assert.match(diagnostic!,/recent-429s-60s=1/);
  assert.match(diagnostic!,/affected-providers=1/);
  assert.match(diagnostic!,/affected-quota-groups=0/);
  assert.match(diagnostic!,/unattributed-provider-observations=1/);
  assert.match(diagnostic!,/priority=enrichment/);
  assert.doesNotMatch(diagnostic!,/AIza/);
  assert.doesNotMatch(diagnostic!,/SUPER_SECRET/);
});

test('wrapped runtime 429 inherits provider identity from its cause before diagnostics are counted', async () => {
  let now=0;
  const traces:string[]=[];
  const scheduler=new YouTubeRequestScheduler({
    minIntervalMs:0,
    initialRateLimitBackoffMs:500,
    maxRateLimitBackoffMs:5_000,
    runtimeRateLimitFloorMs:0,
    maxAdaptiveIntervalMs:0,
    ratePressureWindowMs:60_000,
    now:()=>now,
    sleep:async ms=>{now+=ms;}
  });
  const secret='AIzaSyWRAPPED_PROVIDER_KEY';
  const cause=runtime429(secret,['rateLimitExceeded','RATE_LIMIT_EXCEEDED']);
  const wrapped=Object.assign(new Error('Provider rate limit reached.'),{
    status:429,
    quotaExceeded:false,
    errorClass:'RATE_LIMIT',
    providerReasons:['rateLimitExceeded','RATE_LIMIT_EXCEEDED'],
    cause
  });
  await assert.rejects(scheduler.run(async()=>{throw wrapped;},stage=>traces.push(stage),'autonomous'));
  const diagnostic=traces.find(stage=>stage.startsWith('runtime-rate-pressure-diagnostic'));
  assert.ok(diagnostic);
  assert.match(diagnostic!,/provider=ytp-[0-9a-f]{8}/);
  assert.doesNotMatch(diagnostic!,/provider=unknown/);
  assert.doesNotMatch(diagnostic!,/AIza/);
  assert.equal(scheduler.getRatePressureSnapshot().affectedProviders,1);
});

test('recent pressure snapshot distinguishes multiple provider fingerprints', async () => {
  let now=0;
  const scheduler=new YouTubeRequestScheduler({
    minIntervalMs:0,
    initialRateLimitBackoffMs:500,
    maxRateLimitBackoffMs:5_000,
    runtimeRateLimitFloorMs:0,
    maxAdaptiveIntervalMs:0,
    ratePressureWindowMs:60_000,
    now:()=>now,
    sleep:async ms=>{now+=ms;}
  });
  await assert.rejects(scheduler.run(async()=>{throw runtime429('provider-A');}));
  await assert.rejects(scheduler.run(async()=>{throw runtime429('provider-B');}));
  await assert.rejects(scheduler.run(async()=>{throw runtime429('provider-A');}));
  const snapshot=scheduler.getRatePressureSnapshot();
  assert.equal(snapshot.recent429s,3);
  assert.equal(snapshot.affectedProviders,2);
  assert.equal(snapshot.affectedQuotaGroups,0);
  assert.equal(snapshot.unattributedProviderObservations,3);
});

test('quota-group diagnostics distinguish many keys sharing one Google project from independent quota domains', async () => {
  let now=0;
  const traces:string[]=[];
  const groups:Record<string,string>={
    'provider-A':'project-shared',
    'provider-B':'project-shared',
    'provider-C':'project-independent'
  };
  const scheduler=new YouTubeRequestScheduler({
    minIntervalMs:0,
    initialRateLimitBackoffMs:500,
    maxRateLimitBackoffMs:5_000,
    runtimeRateLimitFloorMs:0,
    maxAdaptiveIntervalMs:0,
    ratePressureWindowMs:60_000,
    quotaGroupForProvider:key=>groups[key],
    now:()=>now,
    sleep:async ms=>{now+=ms;}
  });
  await assert.rejects(scheduler.run(async()=>{throw runtime429('provider-A');},stage=>traces.push(stage)));
  await assert.rejects(scheduler.run(async()=>{throw runtime429('provider-B');},stage=>traces.push(stage)));
  await assert.rejects(scheduler.run(async()=>{throw runtime429('provider-C');},stage=>traces.push(stage)));
  const snapshot=scheduler.getRatePressureSnapshot();
  assert.equal(snapshot.affectedProviders,3);
  assert.equal(snapshot.affectedQuotaGroups,2);
  assert.equal(snapshot.unattributedProviderObservations,0);
  const diagnostic=traces.filter(stage=>stage.startsWith('runtime-rate-pressure-diagnostic')).at(-1)!;
  assert.match(diagnostic,/quota-group=ytq-[0-9a-f]{8}/);
  assert.match(diagnostic,/affected-quota-groups=2/);
  assert.doesNotMatch(diagnostic,/project-shared|project-independent/);
});

test('daily quota exhaustion is not counted as runtime pressure', async () => {
  let now=0;
  const traces:string[]=[];
  const scheduler=new YouTubeRequestScheduler({
    minIntervalMs:0,
    initialRateLimitBackoffMs:500,
    maxRateLimitBackoffMs:5_000,
    runtimeRateLimitFloorMs:1_000,
    maxAdaptiveIntervalMs:5_000,
    now:()=>now,
    sleep:async ms=>{now+=ms;}
  });
  const quotaError=Object.assign(new Error('daily quota exhausted'),{
    status:403,
    quotaExceeded:true,
    errorClass:'RATE_LIMIT',
    providerReasons:['quotaExceeded'],
    providerKey:'secret-provider'
  });
  await assert.rejects(scheduler.run(async()=>{throw quotaError;},stage=>traces.push(stage)));
  assert.equal(scheduler.getRatePressureSnapshot().recent429s,0);
  assert.equal(traces.some(stage=>stage.startsWith('runtime-rate-pressure-diagnostic')),false);
});

test('successful calls update the last-success timestamp', async () => {
  let now=1234;
  const scheduler=new YouTubeRequestScheduler({
    minIntervalMs:0,
    initialRateLimitBackoffMs:500,
    maxRateLimitBackoffMs:5_000,
    now:()=>now,
    sleep:async ms=>{now+=ms;}
  });
  await scheduler.run(async()=> 'ok');
  assert.equal(scheduler.getRatePressureSnapshot().lastSuccessfulCallAt,1234);
});
