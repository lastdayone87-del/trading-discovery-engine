import { mkdir, writeFile } from 'node:fs/promises';
import { runStage2PostFixShadowEvaluation } from '../server/release5/stage2PostFixShadowEvaluation';

const report = await runStage2PostFixShadowEvaluation(process.env.STAGE1_DATASET_ID || undefined);
await mkdir('stage2-output', { recursive: true });
await writeFile('stage2-output/stage2-postfix-shadow-evaluation.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({
  datasetId: report.datasetId,
  totals: report.totals,
  metrics: report.metrics,
  nextAction: report.nextAction,
  servingAuthority: report.servingAuthority,
  mutatesOperationalState: report.mutatesOperationalState
}, null, 2));
