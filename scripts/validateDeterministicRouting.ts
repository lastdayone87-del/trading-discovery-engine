import fs from 'node:fs';
import { EvidenceBasedTradingEngine } from '../server/evidenceEngine/index';
import { ChannelMetadataProvider } from '../server/evidenceEngine/providers/ChannelMetadataProvider';
import { VideoMetadataProvider } from '../server/evidenceEngine/providers/VideoMetadataProvider';
import { ExternalLinkProvider } from '../server/evidenceEngine/providers/ExternalLinkProvider';
import { CountryKnowledgeProvider } from '../server/evidenceEngine/providers/CountryKnowledgeProvider';
import { MultilingualContextProvider } from '../server/evidenceEngine/providers/MultilingualContextProvider';
import { DiscordProvider } from '../server/evidenceEngine/providers/DiscordProvider';
import type { RawChannelInput } from '../server/evidenceEngine/types';
import { resolveClassificationRouting } from '../server/classificationRouting/deterministicFirst';

const files: Array<[string, string]> = [
  ['confirmed', '/tmp/opencode/cohort_confirmed.jsonl'],
  ['non_trading', '/tmp/opencode/cohort_non_trading.jsonl'],
  ['needs_review', '/tmp/opencode/cohort_needs_review.jsonl'],
  ['uncertain', '/tmp/opencode/cohort_uncertain.jsonl'],
];

const engine = new EvidenceBasedTradingEngine([
  new ChannelMetadataProvider(),
  new VideoMetadataProvider(),
  new ExternalLinkProvider(),
  new CountryKnowledgeProvider(),
  new MultilingualContextProvider(),
  new DiscordProvider(),
]);

function inputFromRow(row: any): RawChannelInput {
  const videos = Array.isArray(row.videos) ? row.videos : [];
  return {
    channel_id: String(row.channelId || ''),
    channel_name: String(row.channelName || ''),
    description: String(row.description || ''),
    country: row.country || undefined,
    video_titles: videos.map((video: any) => String(video.title || '')).filter(Boolean),
    video_descriptions: videos.map((video: any) => String(video.description || '')).filter(Boolean),
    videos: videos.map((video: any, index: number) => ({
      id: video.id || `${row.channelId}:${index}`,
      title: String(video.title || ''),
      description: String(video.description || ''),
      published_at: video.published_at || undefined,
    })).filter((video: any) => video.title),
    external_links: [],
    enrichment_stage: 0,
    search_match_context: { type: 'CHANNEL', title: String(row.channelName || ''), description: String(row.description || '') },
  };
}

function count(record: Record<string, number>, key: string | undefined | null) {
  const k = key || 'UNKNOWN';
  record[k] = (record[k] || 0) + 1;
}

const output: any = { readOnly: true, groundTruth: false, note: 'Production status is used only for engineering coverage diagnostics, never as human ground truth.', cohorts: {} };
for (const [name, path] of files) {
  if (!fs.existsSync(path)) continue;
  const rows = fs.readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  const summary: any = { rows: rows.length, status: {}, recognition: {}, semanticPolicy: {}, routes: {}, confirmedByDeterministic: 0, nonTradingByDeterministic: 0, examples: [] };
  for (const row of rows) {
    const decision = await engine.evaluateChannel(inputFromRow(row));
    const routing = resolveClassificationRouting(decision, {
      independentEvidence: decision.stagedClassification?.stages.find(stage => stage.stage === 'CORROBORATION')?.disposition === 'PASS',
    });
    count(summary.status, decision.status);
    count(summary.recognition, decision.recognitionState);
    count(summary.semanticPolicy, decision.semanticPolicy);
    count(summary.routes, routing.route);
    if (decision.status === 'TRADING_CONFIRMED') summary.confirmedByDeterministic += 1;
    if (decision.status === 'NON_TRADING') summary.nonTradingByDeterministic += 1;
    if (summary.examples.length < 25 && decision.status !== 'TRADING_CONFIRMED' && (decision.recognitionState === 'AMBIGUOUS_THIN' || decision.recognitionState === 'INSUFFICIENT')) {
      summary.examples.push({
        channelId: row.channelId,
        channelName: row.channelName,
        country: row.country,
        status: decision.status,
        confidence: decision.confidenceScore,
        recognition: decision.recognitionState,
        semanticPolicy: decision.semanticPolicy,
        reasonCodes: decision.decisionPolicy?.reasonCodes,
        evidenceSufficiency: decision.evidenceCollection.sufficiency,
        positiveWeight: decision.totalPositiveWeight,
        negativeWeight: decision.totalNegativeWeight,
        composition: decision.composition,
      });
    }
  }
  output.cohorts[name] = summary;
}
console.log(JSON.stringify(output, null, 2));
