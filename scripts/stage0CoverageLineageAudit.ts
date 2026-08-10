import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { auditStage0CoverageLineage } from '../server/candidateAdmission/stage0CoverageLineageAudit';

async function main() {
  const report = await auditStage0CoverageLineage();
  const text = JSON.stringify(report, null, 2);
  console.log(text);
  mkdirSync('stage0-output', { recursive: true });
  writeFileSync('stage0-output/stage0-coverage-lineage-audit.json', text);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
