import { mkdir, writeFile } from 'node:fs/promises';
import { inspectStage1ReviewHistoryStorageAudit } from '../server/candidateAdmission/stage1ReviewHistoryStorageAudit';

const report = await inspectStage1ReviewHistoryStorageAudit();
await mkdir('stage1-output', { recursive: true });
await writeFile('stage1-output/stage1-review-history-storage-audit.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
