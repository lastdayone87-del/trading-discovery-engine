import { mkdir, writeFile } from 'node:fs/promises';
import { evaluateStage1OperatorVisibleReplay } from '../server/candidateAdmission/stage1OperatorVisibleReplay';

const report = await evaluateStage1OperatorVisibleReplay();
await mkdir('stage1-output', { recursive: true });
await writeFile('stage1-output/stage1-operator-visible-hypothesis-replay.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
