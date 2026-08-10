import { mkdir, writeFile } from 'node:fs/promises';
import { inspectStage1ProspectiveCohortReadiness } from '../server/candidateAdmission/stage1ProspectiveCohortReadiness';

async function main() {
  const minimumPerClass = Number(process.env.STAGE1_MINIMUM_PER_CLASS || 30);
  const report = await inspectStage1ProspectiveCohortReadiness(minimumPerClass);
  await mkdir('stage1-output', { recursive: true });
  await writeFile('stage1-output/stage1-prospective-cohort-readiness.json', `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
