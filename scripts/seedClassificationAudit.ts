import fs from 'node:fs';
import path from 'node:path';
import { createClassificationAuditItem, type ClassificationAuditEvidence } from '../server/classificationAudit';
import { buildAuditChannelInput, buildAuditEvidenceInput, normalizeAuditVideos } from '../server/classificationAuditWorklist';
import { EvidenceBasedTradingEngine } from '../server/evidenceEngine/index';
import { ChannelMetadataProvider } from '../server/evidenceEngine/providers/ChannelMetadataProvider';
import { VideoMetadataProvider } from '../server/evidenceEngine/providers/VideoMetadataProvider';
import { ExternalLinkProvider } from '../server/evidenceEngine/providers/ExternalLinkProvider';
import { CountryKnowledgeProvider } from '../server/evidenceEngine/providers/CountryKnowledgeProvider';
import { MultilingualContextProvider } from '../server/evidenceEngine/providers/MultilingualContextProvider';
import { DiscordProvider } from '../server/evidenceEngine/providers/DiscordProvider';
import { resolveClassificationRouting } from '../server/classificationRouting/deterministicFirst';

const dataDir = process.env.CLASSIFICATION_AUDIT_DIR || '/tmp/opencode/classification-audit-data';
const cohortKey = process.env.CLASSIFICATION_AUDIT_COHORT || 'audit-2026-11-10-v1';
const work = fs.readFileSync(path.join(dataDir, 'worklist.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
const manifest = new Map<string, any>(fs.readFileSync(path.join(dataDir, 'manifest.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => { const row = JSON.parse(line); return [row.itemId, row]; }));
const engine = new EvidenceBasedTradingEngine([
  new ChannelMetadataProvider(), new VideoMetadataProvider(), new ExternalLinkProvider(),
  new CountryKnowledgeProvider(), new MultilingualContextProvider(), new DiscordProvider(),
]);
let inserted = 0;
for (const item of work) {
  const source = manifest.get(item.itemId) || {};
  const input = buildAuditChannelInput(item);
  const decision = await engine.evaluateChannel(input);
  const videoTexts = normalizeAuditVideos(item)
    .map(video => [video.title, video.description].filter(Boolean).join('\n').trim())
    .filter(Boolean);
  const routing = resolveClassificationRouting(decision, {
    independentEvidence: decision.stagedClassification?.stages.find(stage => stage.stage === 'CORROBORATION')?.disposition === 'PASS',
    videoTexts,
  });
  const evidence: ClassificationAuditEvidence = {
    channel: { channelId: item.channelId, channelName: item.channelName, country: item.country || null, sourceCohort: source.sourceCohort },
    input: buildAuditEvidenceInput(item),
    classifier: { status: decision.status, confidence: decision.confidenceScore, recognitionState: decision.recognitionState, semanticPolicy: decision.semanticPolicy, route: routing.route, fastTrack: routing.fastTrack, reasonCodes: decision.decisionPolicy?.reasonCodes || [], policyVersion: decision.decisionPolicy?.version },
  };
  const result = await createClassificationAuditItem({
    cohortKey,
    channelId: item.channelId,
    evidence,
    proposedLabel: decision.status === 'TRADING_CONFIRMED' ? 'TRADING_CONFIRMED' : decision.status === 'NON_TRADING' ? 'NON_TRADING' : 'UNCERTAIN',
    proposedConfidence: decision.confidenceScore,
    proposedReasonCodes: decision.decisionPolicy?.reasonCodes || [],
  });
  if (result.inserted) inserted += 1;
}
console.log(JSON.stringify({ cohortKey, items: work.length, inserted }, null, 2));
