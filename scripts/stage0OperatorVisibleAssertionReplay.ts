import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { evaluateOperatorVisibleAssertionReplay } from '../server/candidateAdmission/stage0OperatorVisibleAssertionReplay';

async function main() {
  const report = await evaluateOperatorVisibleAssertionReplay();
  const text = JSON.stringify(report, null, 2);
  console.log(text);
  mkdirSync('stage0-output', { recursive: true });
  writeFileSync('stage0-output/stage0-operator-visible-assertion-replay.json', text);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
