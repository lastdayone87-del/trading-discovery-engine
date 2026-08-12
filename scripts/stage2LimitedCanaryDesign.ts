import { mkdir, writeFile } from 'node:fs/promises';
import { runStage2LimitedCanaryDesign } from '../server/release5/stage2LimitedCanaryDesign';

const report = await runStage2LimitedCanaryDesign(process.env.STAGE1_DATASET_ID || undefined);
await mkdir('stage2-output', { recursive: true });
await writeFile('stage2-output/stage2-limited-canary-design.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({
  designStatus: report.designStatus,
  blockers: 'blockers' in report ? report.blockers : [],
  nextAction: report.nextAction,
  servingAuthority: report.servingAuthority,
  productionActivation: report.productionActivation
}, null, 2));
