import fs from 'node:fs';
import path from 'node:path';
import { resolveClassificationRouting } from '../server/classificationRouting/deterministicFirst';
import { detectScripts } from '../server/globalLanguageModel';

const dataDir = process.env.CLASSIFICATION_AUDIT_DIR || '/tmp/opencode/classification-audit-data';
const load = (name: string) => fs.readFileSync(path.join(dataDir, name), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
const work = new Map<string, any>(load('worklist.jsonl').map(row => [row.itemId, row]));
const manifest = new Map<string, any>(load('manifest.jsonl').map(row => [row.itemId, row]));
const labels = load('audit-labels.jsonl');
const diagnostics = new Map<string, any>(load('diagnostics.jsonl').map(row => [String(row.channel_id), row]));
const deterministicRows = fs.existsSync(path.join(dataDir, 'evaluation.json'))
  ? new Map<string, any>(JSON.parse(fs.readFileSync(path.join(dataDir, 'evaluation.json'), 'utf8')).rows.map((row: any) => [row.channelId, row]))
  : new Map<string, any>();

const pct = (n: number, d: number) => d ? Math.round((n / d) * 1000) / 10 : 0;
const ratio = (n: number, d: number) => d ? pct(n, d) : null;
const scriptFor = (item: any) => {
  const text = [item.channelName, item.description, ...(item.videos || []).flatMap((video: any) => [video.title, video.description])].filter(Boolean).join(' ');
  try { const scripts = detectScripts(text); return scripts.length === 1 ? scripts[0] : scripts.length ? 'MULTI' : 'LATIN_OR_UNKNOWN'; } catch { return 'UNKNOWN'; }
};
const predictedFromStatus = (status: string) => status === 'TRADING_CONFIRMED' ? 'TRADING_CONFIRMED' : status === 'NON_TRADING' ? 'NON_TRADING' : null;
const predictedFromRoute = (route: string) => route === 'DETERMINISTIC_TRADING' || route === 'SEMANTIC_TRADING' ? 'TRADING_CONFIRMED'
  : route === 'DETERMINISTIC_NON_TRADING' || route === 'SEMANTIC_NON_TRADING' ? 'NON_TRADING' : null;

function metrics(rows: any[], predictor: (row: any) => string | null) {
  const labeled = rows.filter(row => row.auditLabel === 'TRADING_CONFIRMED' || row.auditLabel === 'NON_TRADING');
  const resolved = labeled.filter(row => predictor(row) !== null);
  const pos = labeled.filter(row => row.auditLabel === 'TRADING_CONFIRMED').length;
  const neg = labeled.filter(row => row.auditLabel === 'NON_TRADING').length;
  const tp = resolved.filter(row => row.auditLabel === 'TRADING_CONFIRMED' && predictor(row) === 'TRADING_CONFIRMED').length;
  const fp = resolved.filter(row => row.auditLabel === 'NON_TRADING' && predictor(row) === 'TRADING_CONFIRMED').length;
  const tn = resolved.filter(row => row.auditLabel === 'NON_TRADING' && predictor(row) === 'NON_TRADING').length;
  const fn = resolved.filter(row => row.auditLabel === 'TRADING_CONFIRMED' && predictor(row) === 'NON_TRADING').length;
  return {
    decisiveAuditLabels: labeled.length, resolved: resolved.length, abstained: labeled.length - resolved.length,
    coveragePct: pct(resolved.length, labeled.length),
    tp, fp, tn, fn, positives: pos, negatives: neg,
    precision: ratio(tp, tp + fp), recall: ratio(tp, pos),
    falsePositiveRate: ratio(fp, neg), falseNegativeRate: ratio(fn, pos),
    accuracyOnResolved: ratio(tp + tn, resolved.length),
    // FNR counts only explicit NON_TRADING predictions. Positive miss includes
    // audited trading labels that abstained or were left unresolved.
    positiveMissRate: ratio(pos - tp, pos),
    unresolvedPositives: pos - tp - fn,
    unresolvedNegatives: neg - tn - fp,
  };
}

const rows: any[] = [];
let unmatchedLabels = 0;
for (const label of labels) {
  const item = work.get(label.itemId);
  const source = manifest.get(label.itemId);
  if (!item || !source) { unmatchedLabels += 1; continue; }
  const diagnostic = diagnostics.get(item.channelId);
  const decision = diagnostic?.decision || null;
  let routing: any = null;
  if (decision) {
    const normalized = diagnostic.normalized_input || {};
    const videoDocuments: any[] = normalized.videos?.length
      ? normalized.videos
      : (normalized.video_titles || []).map((title: string, index: number) => ({ title, description: normalized.video_descriptions?.[index] || '' }));
    // Keep one document per video and preserve the title/description line
    // boundary so shared footer lines can be identified safely.
    const videoTexts = videoDocuments
      .map((video: any) => [video.title, video.description].filter(Boolean).join('\n').trim())
      .filter(Boolean);
    routing = resolveClassificationRouting({
      status: decision.status,
      confidenceScore: decision.confidenceScore,
      evidenceCollection: decision.evidenceCollection,
      recognitionState: decision.recognitionState || decision.recognition?.state,
      semanticPolicy: decision.semanticPolicy || decision.recognition?.semanticPolicy,
      decisionPolicy: decision.decisionPolicy,
      classificationMethod: decision.classificationMethod,
    }, {
      independentEvidence: decision.stagedClassification?.stages?.find((stage: any) => stage.stage === 'CORROBORATION')?.disposition === 'PASS',
      videoTexts,
    });
  }
  rows.push({
    itemId: item.itemId, channelId: item.channelId, channelName: item.channelName,
    country: item.country || null, script: scriptFor(item), sourceCohort: source.sourceCohort,
    auditLabel: label.label, auditConfidence: label.confidence ?? null, auditEvidence: label.evidence || [], auditNotes: label.notes || null,
    hasDiagnostic: !!decision,
    storedStatus: decision?.status || null,
    storedCategory: decision?.category || null,
    storedConfidence: decision?.confidenceScore ?? null,
    storedReasonCodes: decision?.decisionPolicy?.reasonCodes || [],
    storedPrediction: decision ? predictedFromStatus(decision.status) : null,
    route: routing?.route || null,
    routePrediction: routing ? predictedFromRoute(routing.route) : null,
    routeFallback: routing?.fallbackReason || null,
    routeReasonCodes: routing?.reasonCodes || [],
    deterministicPrediction: deterministicRows.get(item.channelId)?.predictedStatus ? predictedFromStatus(deterministicRows.get(item.channelId).predictedStatus) : null,
    deterministicRoute: deterministicRows.get(item.channelId)?.route || null,
  });
}

const withDiagnostic = rows.filter(row => row.hasDiagnostic);
const report = {
  generatedAt: new Date().toISOString(),
  readOnly: true,
  groundTruth: {
    source: 'independent evidence audit',
    productionClassificationsUsedAsGroundTruth: false,
    labels: rows.length,
    byLabel: {
      TRADING_CONFIRMED: rows.filter(row => row.auditLabel === 'TRADING_CONFIRMED').length,
      NON_TRADING: rows.filter(row => row.auditLabel === 'NON_TRADING').length,
      UNCERTAIN: rows.filter(row => row.auditLabel === 'UNCERTAIN').length,
    },
    withProductionDiagnostic: withDiagnostic.length,
    unmatchedLabels,
  },
  fullStoredDecision: metrics(withDiagnostic, row => row.storedPrediction),
  deterministicRoutingOnStoredDecision: metrics(withDiagnostic, row => row.routePrediction),
  deterministicOnlyEngine: metrics(rows, row => row.deterministicPrediction),
  byCountry: [...new Set(withDiagnostic.map(row => row.country || 'UNKNOWN'))].map(country => ({
    country,
    stored: metrics(withDiagnostic.filter(row => (row.country || 'UNKNOWN') === country), row => row.storedPrediction),
    routing: metrics(withDiagnostic.filter(row => (row.country || 'UNKNOWN') === country), row => row.routePrediction),
  })).sort((a, b) => b.stored.decisiveAuditLabels - a.stored.decisiveAuditLabels),
  byScript: [...new Set(withDiagnostic.map(row => row.script))].map(script => ({
    script,
    stored: metrics(withDiagnostic.filter(row => row.script === script), row => row.storedPrediction),
    routing: metrics(withDiagnostic.filter(row => row.script === script), row => row.routePrediction),
  })).sort((a, b) => b.stored.decisiveAuditLabels - a.stored.decisiveAuditLabels),
  // The audit sample is stratified, so the headline metrics are sample-weighted
  // and must be read alongside these cohort-level figures.
  bySourceCohort: [...new Set(withDiagnostic.map(row => row.sourceCohort))].map(cohort => ({
    cohort,
    stored: metrics(withDiagnostic.filter(row => row.sourceCohort === cohort), row => row.storedPrediction),
    routing: metrics(withDiagnostic.filter(row => row.sourceCohort === cohort), row => row.routePrediction),
  })).sort((a, b) => b.stored.decisiveAuditLabels - a.stored.decisiveAuditLabels),
  examples: {
    storedFalsePositives: withDiagnostic.filter(row => row.auditLabel === 'NON_TRADING' && row.storedPrediction === 'TRADING_CONFIRMED').slice(0, 20),
    storedFalseNegatives: withDiagnostic.filter(row => row.auditLabel === 'TRADING_CONFIRMED' && row.storedPrediction === 'NON_TRADING').slice(0, 20),
    auditUncertain: withDiagnostic.filter(row => row.auditLabel === 'UNCERTAIN').slice(0, 20),
  },
  rows,
};
fs.writeFileSync(path.join(dataDir, 'evaluation-full.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  groundTruth: report.groundTruth,
  fullStoredDecision: report.fullStoredDecision,
  deterministicRoutingOnStoredDecision: report.deterministicRoutingOnStoredDecision,
  deterministicOnlyEngine: report.deterministicOnlyEngine,
  byCountry: report.byCountry,
  byScript: report.byScript,
  bySourceCohort: report.bySourceCohort,
}, null, 2));
