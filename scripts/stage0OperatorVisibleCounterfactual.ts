import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'node:fs';
import { evaluateOperatorVisibleStage0 } from '../server/candidateAdmission/stage0OperatorVisible';

async function main() {
  const report = await evaluateOperatorVisibleStage0();
  const text = JSON.stringify(report, null, 2);
  console.log(text);
  mkdirSync('stage0-output', { recursive: true });
  writeFileSync('stage0-output/stage0-operator-visible-counterfactual.json', text);
  const totals = report.totals as {
    reliableForPopulationInference?: boolean;
    operatorVisibleChannels?: number;
    evaluatedWithFocusAndCoverage?: number;
  };
  if (totals && totals.reliableForPopulationInference === false) {
    process.exitCode = 0; // still a successful measurement run
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
