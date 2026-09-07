/**
 * Live shadow-measurement runner: Groq vs Gemini over shared JSONL cases.
 *
 * Each input line: {"id": "...", "input": {RawChannelInput}}. Runs the real
 * provider classes through runSemanticShadowComparison (per-side failures
 * isolated per case) and writes the agreement report as JSON.
 *
 * Requires keys for the sides being measured (GROQ_API_KEY, GEMINI_API_KEY);
 * sides without keys record honest per-case failures instead of fake data.
 * Default pacing (2500ms) stays under Groq's 30 RPM free-tier envelope.
 *
 * Usage: tsx scripts/groqShadowRun.ts --cases <cases.jsonl> [--out report.json] [--interval-ms 2500] [--limit 0]
 */
import fs from 'node:fs/promises';
import { GroqSemanticProvider } from '../server/evidenceEngine/providers/GroqSemanticProvider.js';
import { GeminiSemanticProvider } from '../server/evidenceEngine/providers/GeminiSemanticProvider.js';
import { getLayeredKnowledgeContext } from '../server/evidenceEngine/knowledgePacks.js';
import { runSemanticShadowComparison } from '../server/evidenceEngine/semanticShadowHarness.js';
import type { RawChannelInput } from '../server/evidenceEngine/types.js';

const args = new Map(
  process.argv.slice(2).flatMap((arg, i, all) => (arg.startsWith('--') ? [[arg.slice(2), all[i + 1] ?? '']] : [])),
);
const casesPath = args.get('cases') || '';
const outPath = args.get('out') || 'benchmark/results/groq-shadow.json';
const intervalMs = Math.max(0, Math.floor(Number(args.get('interval-ms') ?? '2500')) || 0);
const limit = Math.max(0, Math.floor(Number(args.get('limit') ?? '0')) || 0);

async function main(): Promise<void> {
  if (!casesPath) {
    console.error(JSON.stringify({ status: 'BLOCKED', reason: 'Missing --cases <cases.jsonl>; each line must be {"id","input"}.' }));
    process.exit(2);
  }
  let raw: string;
  try {
    raw = await fs.readFile(casesPath, 'utf8');
  } catch {
    console.error(JSON.stringify({ status: 'BLOCKED', reason: `Cases file not readable: ${casesPath}.` }));
    process.exit(2);
  }
  const parsed = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => JSON.parse(line) as { id: string; input: RawChannelInput });
  if (!parsed.length) {
    console.error(JSON.stringify({ status: 'BLOCKED', reason: `No cases found in ${casesPath}.` }));
    process.exit(2);
  }
  const selected = limit > 0 ? parsed.slice(0, limit) : parsed;
  const groq = new GroqSemanticProvider();
  const gemini = new GeminiSemanticProvider();
  const gateInput = { channel_name: 'probe', description: 'probe with enough context for the gate' } as RawChannelInput;
  console.error(JSON.stringify({
    status: 'RUNNING',
    groq: groq.availability(gateInput),
    gemini: gemini.availability(gateInput),
    cases: selected.length,
    interval_ms: intervalMs,
  }));
  const report = await runSemanticShadowComparison(
    selected.map(c => ({ id: c.id, input: c.input })),
    { gemini, groq },
    getLayeredKnowledgeContext('United States'),
    { intervalMs },
  );
  await fs.mkdir(outPath.split('/').slice(0, -1).join('/') || '.', { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: 'COMPLETED', out: outPath, ...report }, null, 2));
}

main().catch(error => {
  console.error(JSON.stringify({ status: 'ERROR', error: String(error instanceof Error ? error.message : error).slice(0, 500) }));
  process.exit(1);
});
