import { mkdir, writeFile } from 'node:fs/promises';
import { runStage2GuardedPromotionGate } from '../server/release5/stage2GuardedPromotionGate';

const report = await runStage2GuardedPromotionGate(process.env.STAGE1_DATASET_ID || undefined);
await mkdir('stage2-output', { recursive: true });
await writeFile('stage2-output/stage2-guarded-promotion-gate.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({
  datasetId: report.datasetId,
  gateStatus: report.gateStatus,
  blockers: report.blockers,
  observedMetrics: report.observedMetrics,
  decisionCounts: report.decisionCounts,
  fallbackApplied: report.fallbackApplied,
  deferredCount: report.deferred.length,
  nextAction: report.nextAction
}, null, 2));
