import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * InnerTube single-container stability benchmark (P5-05).
 *
 * Env-gated: runs ONLY with INNERTUBE_BENCHMARK_LIVE=1, i.e. inside the
 * deployment container when explicitly authorized — never in CI. Executes 250
 * keyless description fetches across a fixed channel list and records
 * success/error/throttle rates plus p50/p99 latency. No assertions on live
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
  const { fetchChannelVideoDescriptionsViaInnertube } = await import(
    './youtubeInnertubeProvider'
  );
  const latencies: number[] = [];
  let success = 0;
  let throttled = 0;
  let failed = 0;
  for (let i = 0; i < CALLS; i++) {
    const channelId = CHANNELS[i % CHANNELS.length];
    const started = Date.now();
    try {
      await fetchChannelVideoDescriptionsViaInnertube(channelId, { maxVideos: 3 });
      success += 1;
    } catch (error: any) {
      if (String(error?.code || '').includes('RATE_LIMITED')) throttled += 1;
      else failed += 1;
    } finally {
      latencies.push(Date.now() - started);
    }
    if ((i + 1) % 50 === 0) console.log(`[InnerTube Benchmark] progress ${i + 1}/${CALLS}`);
  }
  latencies.sort((a, b) => a - b);
  const quantile = (q: number) => latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))];
  const report = {
    calls: CALLS,
    success,
    throttled,
    failed,
    successRate: success / CALLS,
    p50LatencyMs: quantile(0.5),
    p99LatencyMs: quantile(0.99),
    measuredAt: new Date().toISOString(),
  };
  console.log(`[InnerTube Benchmark] ${JSON.stringify(report)}`);
  assert.equal(success + throttled + failed, CALLS);
});
