import { readFileSync } from 'node:fs';
import { evaluateStage0PromotionReadiness, promotionEvidenceFromReport } from '../server/candidateAdmission/stage0PromotionReadiness';

const paths = process.argv.slice(2);
if (!paths.length) {
  console.error('Usage: npm run stage0:promotion-readiness -- <stage0-report.json> [more-report.json ...]');
  process.exit(2);
}

const evidence = paths.map(path => {
  const report = JSON.parse(readFileSync(path, 'utf8'));
  return promotionEvidenceFromReport(report, path);
});

const result = evaluateStage0PromotionReadiness(evidence);
console.log(JSON.stringify(result, null, 2));

// HOLD is an evidence result, not a process failure. CI/operator automation should
// inspect recommendation explicitly rather than interpreting a non-zero exit as
// authorization to bypass the gate.
