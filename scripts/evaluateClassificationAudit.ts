import fs from 'node:fs';
import path from 'node:path';
import { EvidenceBasedTradingEngine } from '../server/evidenceEngine/index';
import { ChannelMetadataProvider } from '../server/evidenceEngine/providers/ChannelMetadataProvider';
import { VideoMetadataProvider } from '../server/evidenceEngine/providers/VideoMetadataProvider';
import { ExternalLinkProvider } from '../server/evidenceEngine/providers/ExternalLinkProvider';
import { CountryKnowledgeProvider } from '../server/evidenceEngine/providers/CountryKnowledgeProvider';
import { MultilingualContextProvider } from '../server/evidenceEngine/providers/MultilingualContextProvider';
import { DiscordProvider } from '../server/evidenceEngine/providers/DiscordProvider';
import type { RawChannelInput } from '../server/evidenceEngine/types';
import { resolveClassificationRouting } from '../server/classificationRouting/deterministicFirst';
import { detectScripts } from '../server/globalLanguageModel';
import { buildAuditChannelInput, normalizeAuditVideos } from '../server/classificationAuditWorklist';

const dataDir = process.env.CLASSIFICATION_AUDIT_DIR || '/tmp/opencode/classification-audit-data';
const worklistPath = path.join(dataDir, 'worklist.jsonl');
const manifestPath = path.join(dataDir, 'manifest.jsonl');
const labelsPath = path.join(dataDir, 'audit-labels.jsonl');
const outPath = path.join(dataDir, 'evaluation.json');

type WorkItem = {
  itemId: string; channelId: string; channelName: string; country?: string | null;
  description?: string; videos?: Array<{ title?: string; description?: string; published_at?: string }>;
  links?: string[];
};
type LabelRow = { itemId: string; label: 'TRADING_CONFIRMED' | 'NON_TRADING' | 'UNCERTAIN'; confidence?: number; evidence?: unknown[]; notes?: string };
type ManifestRow = { itemId: string; channelId: string; sourceCohort: string; channelName?: string; country?: string | null };

function loadJsonl<T>(file: string): T[] {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as T);
}

function inputFor(item: WorkItem): RawChannelInput {
  return buildAuditChannelInput(item);
}

function pct(value: number, total: number): number {
  return total ? Math.round((value / total) * 1000) / 10 : 0;
}

function ratio(value: number, total: number): number | null {
  return total ? pct(value, total) : null;
}

function scriptFor(item: WorkItem): string {
  const text = [item.channelName, item.description, ...(item.videos || []).flatMap(video => [video.title, video.description])].filter(Boolean).join(' ');
  try {
    const scripts = detectScripts(text);
    return scripts.length === 0 ? 'LATIN_OR_UNKNOWN' : scripts.length === 1 ? scripts[0] : `MULTI:${scripts.join('+')}`;
  } catch {
    return 'UNKNOWN';
  }
}

function binFor(confidence: number): string {
  if (confidence < 50) return '0-49';
  if (confidence < 65) return '50-64';
  if (confidence < 80) return '65-79';
  if (confidence < 90) return '80-89';
  return '90-100';
}

async function main() {
  if (!fs.existsSync(labelsPath)) throw new Error(`Missing ${labelsPath}. Provide the independent audit labels first.`);
  const work = new Map(loadJsonl<WorkItem>(worklistPath).map(item => [item.itemId, item]));
  const manifest = new Map(loadJsonl<ManifestRow>(manifestPath).map(item => [item.itemId, item]));
  const labels = loadJsonl<LabelRow>(labelsPath);
  const engine = new EvidenceBasedTradingEngine([
    new ChannelMetadataProvider(), new VideoMetadataProvider(), new ExternalLinkProvider(),
    new CountryKnowledgeProvider(), new MultilingualContextProvider(), new DiscordProvider(),
  ]);

  const rows: any[] = [];
  for (const label of labels) {
    const item = work.get(label.itemId);
    if (!item) continue;
    const decision = await engine.evaluateChannel(inputFor(item));
    const videoTexts = normalizeAuditVideos(item)
      .map(video => [video.title, video.description].filter(Boolean).join(' ').trim())
      .filter(Boolean);
    const routing = resolveClassificationRouting(decision, {
      independentEvidence: decision.stagedClassification?.stages.find(stage => stage.stage === 'CORROBORATION')?.disposition === 'PASS',
      videoTexts,
    });
    const predicted = decision.status === 'TRADING_CONFIRMED' || decision.status === 'NON_TRADING' ? decision.status : null;
    const resolved = predicted !== null;
    const isPositive = label.label === 'TRADING_CONFIRMED';
    const isNegative = label.label === 'NON_TRADING';
    const correct = resolved && ((isPositive && predicted === 'TRADING_CONFIRMED') || (isNegative && predicted === 'NON_TRADING'));
    const falsePositive = resolved && predicted === 'TRADING_CONFIRMED' && isNegative;
    const falseNegative = resolved && predicted === 'NON_TRADING' && isPositive;
    rows.push({
      itemId: item.itemId,
      channelId: item.channelId,
      channelName: item.channelName,
      country: item.country || null,
      script: scriptFor(item),
      sourceCohort: manifest.get(item.itemId)?.sourceCohort || 'UNKNOWN',
      auditLabel: label.label,
      auditConfidence: label.confidence ?? null,
      auditEvidence: label.evidence || [],
      auditNotes: label.notes || null,
      predictedStatus: decision.status,
      route: routing.route,
      fastTrack: routing.fastTrack,
      confidence: decision.confidenceScore,
      recognitionState: decision.recognitionState,
      semanticPolicy: decision.semanticPolicy,
      evidenceSufficiency: decision.evidenceCollection.sufficiency,
      reasonCodes: decision.decisionPolicy?.reasonCodes || [],
      engineEvidence: [...decision.positiveEvidence, ...decision.negativeEvidence].slice(0, 8).map(evidence => ({
        source: evidence.source, category: evidence.category, polarity: evidence.polarity,
        fact: evidence.fact, weight: evidence.finalWeight,
      })),
      resolved, correct, falsePositive, falseNegative,
    });
  }

  const labeled = rows.filter(row => row.auditLabel === 'TRADING_CONFIRMED' || row.auditLabel === 'NON_TRADING');
  const unresolved = rows.filter(row => row.auditLabel === 'UNCERTAIN');
  const resolved = labeled.filter(row => row.resolved);
  const tp = resolved.filter(row => row.auditLabel === 'TRADING_CONFIRMED' && row.predictedStatus === 'TRADING_CONFIRMED').length;
  const fp = resolved.filter(row => row.auditLabel === 'NON_TRADING' && row.predictedStatus === 'TRADING_CONFIRMED').length;
  const tn = resolved.filter(row => row.auditLabel === 'NON_TRADING' && row.predictedStatus === 'NON_TRADING').length;
  const fn = resolved.filter(row => row.auditLabel === 'TRADING_CONFIRMED' && row.predictedStatus === 'NON_TRADING').length;
  const positives = labeled.filter(row => row.auditLabel === 'TRADING_CONFIRMED').length;
  const negatives = labeled.filter(row => row.auditLabel === 'NON_TRADING').length;
  const metrics = {
    auditLabels: labels.length,
    decisiveAuditLabels: labeled.length,
    auditUncertain: unresolved.length,
    deterministicResolved: resolved.length,
    deterministicAbstained: labeled.length - resolved.length,
    coveragePct: pct(resolved.length, labeled.length),
    truePositives: tp, falsePositives: fp, trueNegatives: tn, falseNegatives: fn,
    precision: pct(tp, tp + fp), recall: pct(tp, positives),
    falsePositiveRate: pct(fp, negatives), falseNegativeRate: pct(fn, positives),
    accuracyOnResolved: pct(tp + tn, resolved.length),
    positiveMissRate: ratio(positives - tp, positives),
    unresolvedPositives: positives - tp - fn,
    fastTrackResolved: rows.filter(row => row.fastTrack && row.resolved).length,
    humanReviewRoute: rows.filter(row => row.route === 'HUMAN_REVIEW').length,
    enrichRoute: rows.filter(row => row.route === 'ENRICH').length,
  };

  function groupBy(key: 'country' | 'script' | 'sourceCohort') {
    const groups = new Map<string, any[]>();
    for (const row of labeled) {
      const name = String(row[key] || 'UNKNOWN');
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name)!.push(row);
    }
    return [...groups.entries()].map(([name, group]) => {
      const groupResolved = group.filter(row => row.resolved);
      const gtp = groupResolved.filter(row => row.auditLabel === 'TRADING_CONFIRMED' && row.predictedStatus === 'TRADING_CONFIRMED').length;
      const gfp = groupResolved.filter(row => row.auditLabel === 'NON_TRADING' && row.predictedStatus === 'TRADING_CONFIRMED').length;
      const gtn = groupResolved.filter(row => row.auditLabel === 'NON_TRADING' && row.predictedStatus === 'NON_TRADING').length;
      const gfn = groupResolved.filter(row => row.auditLabel === 'TRADING_CONFIRMED' && row.predictedStatus === 'NON_TRADING').length;
      return {
        name, total: group.length, resolved: groupResolved.length,
        precision: ratio(gtp, gtp + gfp), recall: ratio(gtp, group.filter(row => row.auditLabel === 'TRADING_CONFIRMED').length),
        falsePositiveRate: ratio(gfp, group.filter(row => row.auditLabel === 'NON_TRADING').length),
        falseNegativeRate: ratio(gfn, group.filter(row => row.auditLabel === 'TRADING_CONFIRMED').length),
      };
    }).sort((a, b) => b.total - a.total);
  }

  const calibration = new Map<string, { total: number; correct: number }>();
  for (const row of resolved) {
    const bin = binFor(Number(row.confidence || 0));
    const current = calibration.get(bin) || { total: 0, correct: 0 };
    current.total += 1;
    if (row.correct) current.correct += 1;
    calibration.set(bin, current);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    groundTruth: {
      source: 'independent evidence audit',
      labelPolicy: 'classification-audit-v1',
      productionClassificationsUsedAsGroundTruth: false,
      labels: labels.length,
      distribution: {
        TRADING_CONFIRMED: labels.filter(row => row.label === 'TRADING_CONFIRMED').length,
        NON_TRADING: labels.filter(row => row.label === 'NON_TRADING').length,
        UNCERTAIN: labels.filter(row => row.label === 'UNCERTAIN').length,
      },
    },
    metrics,
    byCountry: groupBy('country'),
    byScript: groupBy('script'),
    bySourceCohort: groupBy('sourceCohort'),
    calibration: [...calibration.entries()].map(([bin, value]) => ({ bin, ...value, accuracy: pct(value.correct, value.total) })),
    falsePositives: rows.filter(row => row.falsePositive).slice(0, 25),
    falseNegatives: rows.filter(row => row.falseNegative).slice(0, 25),
    unresolvedExamples: unresolved.slice(0, 25),
    rows,
  };
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ metrics, byCountry: report.byCountry, byScript: report.byScript, bySourceCohort: report.bySourceCohort, calibration: report.calibration, output: outPath }, null, 2));
}

main().catch(error => { console.error(error); process.exit(1); });
