import { readFileSync, writeFileSync } from 'node:fs';
import { evaluateDeterministicAdmission } from '../server/channelAdmission/deterministic';
import { summarizeDeterministicCohort, type DeterministicCohortCase, type EvaluationTruth } from '../server/channelAdmission/deterministicEvaluation';
import type { AdmissionEvidence } from '../server/channelAdmission/types';

/**
 * Offline deterministic-admission evaluation. The default inputs are the
 * frozen 900-channel cohort checked into tests/fixtures/admission-v2.
 *
 * Usage:
 *   npx tsx scripts/evaluateDeterministicAdmission.ts
 *   npx tsx scripts/evaluateDeterministicAdmission.ts --cases=<jsonl> --truth=<json> [--out=<jsonl>]
 */
const args = process.argv.slice(2);
function arg(name: string): string | undefined {
  const equals = args.find(value => value.startsWith(`--${name}=`));
  if (equals) return equals.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}
const casesPath = arg('cases') || new URL('../tests/fixtures/admission-v2/fresh_cases.jsonl', import.meta.url).pathname;
const truthPath = arg('truth') || new URL('../tests/fixtures/admission-v2/fresh_truth.json', import.meta.url).pathname;

type Case = {
  index: string | number;
  channel_id: string;
  channel_name: string;
  description?: string;
  country?: string;
  language?: string;
  links?: string[];
  external_links?: string[];
  video_titles?: string[];
  video_descriptions?: string[];
  videos?: Array<{ id?: string; title?: string; description?: string; published_at?: string }>;
};
type Truth = { relevance: EvaluationTruth; content_type?: string; operator_type?: string };

function toEvidence(item: Case): AdmissionEvidence {
  const structured = item.videos && item.videos.length > 0
    ? item.videos
    : (item.video_titles || []).map((title, index) => ({
        title,
        description: item.video_descriptions?.[index] || '',
      }));
  const videos = structured.map((video, index) => ({
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
    links: item.links || item.external_links || [],
    country: item.country,
    declaredLanguage: item.language,
    videos,
    source: 'automated_query',
    targetCountry: 'UNKNOWN',
    evidenceCoverage: videos.length > 0 ? 'COMPLETE' : 'PARTIAL',
    fetchedAt: '2026-01-01T00:00:00.000Z',
  };
}

const cases = readFileSync(casesPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Case);
const truth = JSON.parse(readFileSync(truthPath, 'utf8')) as Record<string, Truth>;
const missingTruth = cases.filter(item => !truth[String(item.index)]).map(item => String(item.index));
if (missingTruth.length > 0) {
  throw new Error(`Truth file is missing ${missingTruth.length} cohort case(s): ${missingTruth.slice(0, 20).join(', ')}`);
}
const outPath = arg('out');
const rows: Array<Record<string, unknown>> = [];
const summaryInput: DeterministicCohortCase[] = [];

for (const item of cases) {
  const expected = truth[String(item.index)];
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
console.log(JSON.stringify({ inputCases: cases.length, evaluated: rows.length, casesPath, truthPath, summary }, null, 2));
