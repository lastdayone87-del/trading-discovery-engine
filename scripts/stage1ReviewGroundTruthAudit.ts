import { mkdir, writeFile } from 'node:fs/promises';
import { inspectStage1ReviewGroundTruthAudit } from '../server/candidateAdmission/stage1ReviewGroundTruthAudit';

const report = await inspectStage1ReviewGroundTruthAudit();
await mkdir('stage1-output', { recursive: true });
await writeFile('stage1-output/stage1-review-ground-truth-audit.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
