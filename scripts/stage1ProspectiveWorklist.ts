import { mkdir, writeFile } from 'node:fs/promises';
import { loadStage1ProspectiveWorklist, toStage1HumanReviewSheet } from '../server/candidateAdmission/stage1ProspectiveWorklist';

async function main() {
  const limit = Number(process.env.STAGE1_WORKLIST_LIMIT || 100);
  const items = await loadStage1ProspectiveWorklist(limit);
  const sheet = toStage1HumanReviewSheet(items);
  const report = {
    reportType: 'STAGE1_PROSPECTIVE_HUMAN_REVIEW_WORKLIST',
    servingAuthority: false,
    operationalStateMutation: false,
    predictionBlind: true,
    count: sheet.length,
    candidates: sheet
  };
  await mkdir('stage1-output', { recursive: true });
  await writeFile('stage1-output/stage1-prospective-human-review-worklist.json', `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
