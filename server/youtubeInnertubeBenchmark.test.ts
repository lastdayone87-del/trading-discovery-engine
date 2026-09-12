import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * InnerTube single-container stability benchmark (P5-05).
 *
 * Env-gated: runs ONLY with INNERTUBE_BENCHMARK_LIVE=1, i.e. inside the
 * deployment container when explicitly authorized — never in CI. Executes 250
 * keyless description fetches across a fixed channel list and records
 * success/upstream-throttle/local-cooldown/error rates plus fetch latency.
 * Local cooldown rejections (no session started, no upstream request) are
 * reported separately and excluded from latency percentiles: local resilience
 * behavior must never read as YouTube throttling. No assertions on live
 * outcomes (results are recorded, never fabricated); the test fails only on
 * harness errors. Base suite stays green without the flag.
 */
const LIVE = process.env.INNERTUBE_BENCHMARK_LIVE === '1';
const CALLS = 250;

const CHANNELS = [
  'UCYTE8Y6z35_AfaeJLIz2LQA',
  'UCxCC7mjkNKlt82P-nupEVuw',
  'UC-01RZMFTwDINElIjPs32gw',
];

test('innertube container stability benchmark (live, env-gated)', { skip: !LIVE }, async () => {
  const { fetchChannelVideoDescriptionsViaInnertube, classifyBenchmarkOutcome } = await import(
    './youtubeInnertubeProvider'
  );
  const latencies: number[] = [];
  let success = 0;
  let upstreamThrottled = 0;
  let localCooldown = 0;
  let failed = 0;
  for (let i = 0; i < CALLS; i++) {
    const channelId = CHANNELS[i % CHANNELS.length];
    const started = Date.now();
    try {
      await fetchChannelVideoDescriptionsViaInnertube(channelId, { maxVideos: 3 });
      success += 1;
      latencies.push(Date.now() - started);
    } catch (error: unknown) {
      const outcome = classifyBenchmarkOutcome(error);
      if (outcome === 'LOCAL_COOLDOWN') {
        localCooldown += 1;
      } else if (outcome === 'UPSTREAM_THROTTLED') {
        upstreamThrottled += 1;
        latencies.push(Date.now() - started);
      } else {
        failed += 1;
        latencies.push(Date.now() - started);
      }
    }
    if ((i + 1) % 50 === 0) console.log(`[InnerTube Benchmark] progress ${i + 1}/${CALLS}`);
  }
  latencies.sort((a, b) => a - b);
  const quantile = (q: number) => latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))];
  const report = {
    calls: CALLS,
    success,
    upstreamThrottled,
    localCooldown,
    failed,
    attemptedFetches: latencies.length,
    successRate: success / CALLS,
    p50FetchLatencyMs: latencies.length ? quantile(0.5) : null,
    p99FetchLatencyMs: latencies.length ? quantile(0.99) : null,
    measuredAt: new Date().toISOString(),
  };
  console.log(`[InnerTube Benchmark] ${JSON.stringify(report)}`);
  assert.equal(success + upstreamThrottled + localCooldown + failed, CALLS);
});
