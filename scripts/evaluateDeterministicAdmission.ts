import { readFileSync, writeFileSync } from 'node:fs';
import { evaluateDeterministicAdmission } from '../server/channelAdmission/deterministic';
import { summarizeDeterministicCohort, type DeterministicCohortCase, type EvaluationTruth } from '../server/channelAdmission/deterministicEvaluation';
import type { AdmissionEvidence } from '../server/channelAdmission/types';

/**
 * Offline deterministic-admission evaluation. The cases are the frozen
 * 900-channel cohort; evidence is the same field set the admission gate gets
 * (title, bio, videos). No semantic provider is called.
 *
 * Usage:
 *   npx tsx scripts/evaluateDeterministicAdmission.ts \
 *     --cases=/tmp/opencode/fresh_cases.jsonl \
 *     --truth=/tmp/opencode/fresh_truth.json \
 *     [--out=/tmp/opencode/deterministic-eval.jsonl]
 */
const args = process.argv.slice(2);
function arg(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
const casesPath = arg('--cases');
const truthPath = arg('--truth');
if (!casesPath || !truthPath) {
  throw new Error('Usage: evaluateDeterministicAdmission --cases=<jsonl> --truth=<json> [--out=<jsonl>]');
}

type Case = {
  index: string | number;
  channel_id: string;
  channel_name: string;
  description?: string;
  video_titles?: string[];
  videos?: Array<{ id?: string; title?: string; description?: string; published_at?: string }>;
};
type Truth = { relevance: EvaluationTruth; content_type?: string; operator_type?: string };

function toEvidence(item: Case): AdmissionEvidence {
  const videos = (item.videos || []).map((video, index) => ({
    videoId: video.id || String(index),
    title: video.title || '',
    description: video.description || '',
    publishedAt: video.published_at,
  }));
  return {
    channelId: item.channel_id,
    channelName: item.channel_name,
    youtubeUrl: `https://youtube.com/channel/${item.channel_id}`,
    description: item.description || '',
    links: [],
    videos,
    source: 'automated_query',
    targetCountry: 'UNKNOWN',
    evidenceCoverage: videos.length > 0 ? 'COMPLETE' : 'PARTIAL',
    fetchedAt: '2026-01-01T00:00:00.000Z',
  };
}

const cases = readFileSync(casesPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Case);
const truth = JSON.parse(readFileSync(truthPath, 'utf8')) as Record<string, Truth>;
const outPath = arg('--out');
const rows: Array<Record<string, unknown>> = [];
const summaryInput: DeterministicCohortCase[] = [];

for (const item of cases) {
  const expected = truth[String(item.index)];
  if (!expected) continue;
  const result = await evaluateDeterministicAdmission(toEvidence(item));
  const row = {
    index: String(item.index),
    channelId: item.channel_id,
    channelName: item.channel_name,
    truth: expected.relevance,
    content_type: expected.content_type,
    operator_type: expected.operator_type,
    outcome: result.outcome,
    confidence: result.confidence,
    reasonCodes: result.reasonCodes,
  };
  rows.push(row);
  summaryInput.push({ truth: expected.relevance, outcome: result.outcome, confidence: result.confidence, reasonCodes: result.reasonCodes });
}

const summary = summarizeDeterministicCohort(summaryInput);
if (outPath) writeFileSync(outPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
console.log(JSON.stringify({ cases: cases.length, evaluated: rows.length, summary }, null, 2));
