/**
 * Sustained free-tier capacity probe for the pinned Groq semantic model.
 *
 * Drives the production Groq default client (real HTTP path: timeout,
 * bounded body, telemetry sink) with paced classification calls and reports
 * per-call latency, success/schema validity, and 429 backpressure.
 *
 * Requires GROQ_API_KEY. Without a key it exits 2 with BLOCKED (never fake
 * results). Published free-tier envelope for openai/gpt-oss-120b is
 * 30 RPM / 8K TPM / 1K RPD / 200K TPD — the default 2500ms interval stays
 * under 30 RPM; watch TPM on large prompts.
 *
 * Usage: tsx scripts/groqCapacityProbe.ts [--calls 20] [--interval-ms 2500] [--out path]
 */
import { buildSemanticPrompt, type SemanticModelClient } from '../server/evidenceEngine/providers/GeminiSemanticProvider.js';
import {
  DEFAULT_GROQ_CANDIDATE_MODEL,
  configuredGroqRoutes,
  defaultClient,
  groqTimeoutMs,
} from '../server/evidenceEngine/providers/GroqSemanticProvider.js';

const args = new Map(
  process.argv.slice(2).flatMap((arg, i, all) => (arg.startsWith('--') ? [[arg.slice(2), all[i + 1] ?? '']] : [])),
);
const calls = Math.max(1, Math.floor(Number(args.get('calls') ?? '20')) || 20);
const intervalMs = Math.max(0, Math.floor(Number(args.get('interval-ms') ?? '2500')) || 0);
const outPath = args.get('out') || '';

const fixtureInput = {
  channel_id: 'capacity-probe',
  channel_name: 'Probe Trading Channel',
  description: 'Day trading education with price action and risk management content for active traders.',
  video_titles: ['Morning price action review', 'Risk management basics'],
  video_descriptions: ['Entries, exits, and position sizing.', 'How we manage risk per trade.'],
  country: 'United States',
} as never;

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const routes = configuredGroqRoutes();
  if (!routes.length) {
    console.error(JSON.stringify({ status: 'BLOCKED', reason: 'GROQ_API_KEY is not configured; no live calls attempted.' }));
    process.exit(2);
  }
  const model = process.env.GROQ_CANDIDATE_MODEL || DEFAULT_GROQ_CANDIDATE_MODEL;
  const prompt = buildSemanticPrompt(fixtureInput, 'CANDIDATE');
  const client: SemanticModelClient | undefined = defaultClient(async () => undefined);
  if (!client) throw new Error('Groq default client unavailable despite configured routes.');
  const results: Array<Record<string, unknown>> = [];
  let consecutive429 = 0;
  for (let i = 0; i < calls; i++) {
    if (i > 0) await sleep(intervalMs);
    const started = Date.now();
    try {
      const value = await client.classify(prompt, model);
      consecutive429 = 0;
      results.push({ n: i + 1, ok: true, latency_ms: Date.now() - started, label: (value as { label?: unknown })?.label ?? null });
    } catch (error: unknown) {
      const status = Number((error as { status?: unknown })?.status) || undefined;
      const errorClass = (error as { errorClass?: unknown })?.errorClass;
      // Local cooldown deferrals are backpressure echoes, not provider
      // responses: they must neither inflate the genuine-429 stop condition
      // nor the ordinary-failure count, so they get their own bucket.
      const cooldownDeferred = (error as { groqCooldownDeferred?: unknown })?.groqCooldownDeferred === true;
      if (cooldownDeferred) {
        results.push({ n: i + 1, ok: false, latency_ms: Date.now() - started, deferred: true });
        continue;
      }
      const is429 = status === 429 || errorClass === 'RATE_LIMIT' || /rate.?limit|429/i.test(String((error as Error)?.message || ''));
      if (is429) {
        consecutive429++;
        results.push({ n: i + 1, ok: false, latency_ms: Date.now() - started, rate_limited: true, status });
        if (consecutive429 >= 3) {
          results.push({ stopped_early: true, reason: 'capacity ceiling hit: 3 consecutive 429s' });
          break;
        }
        continue;
      }
      results.push({ n: i + 1, ok: false, latency_ms: Date.now() - started, status, error: String((error as Error)?.message || error).slice(0, 300) });
    }
  }
  const ok = results.filter(r => r.ok).length;
  const latencies = results.filter(r => r.ok).map(r => Number(r.latency_ms)).sort((a, b) => a - b);
  const report = {
    status: 'COMPLETED',
    model,
    routes: routes.length,
    timeout_ms: groqTimeoutMs(),
    prompt_chars: prompt.length,
    attempted: results.filter(r => typeof r.n === 'number').length,
    succeeded: ok,
    rate_limited: results.filter(r => r.rate_limited).length,
    deferred: results.filter(r => r.deferred).length,
    failed: results.filter(r => !r.ok && !r.rate_limited && !r.deferred && typeof r.n === 'number').length,
    latency_ms: latencies.length
      ? { p50: latencies[Math.floor((latencies.length - 1) * 0.5)], p95: latencies[Math.floor((latencies.length - 1) * 0.95)] }
      : null,
    results,
  };
  const text = JSON.stringify(report, null, 2);
  if (outPath) {
    const fs = await import('node:fs/promises');
    await fs.writeFile(outPath, text);
  }
  console.log(text);
}

main().catch(error => {
  console.error(JSON.stringify({ status: 'ERROR', error: String(error instanceof Error ? error.message : error).slice(0, 500) }));
  process.exit(1);
});
