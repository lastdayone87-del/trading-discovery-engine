import { runRegressionTestSuite } from '../server/regressionSuite.js';
import { runValidationTestSuite } from '../server/validationSuite.js';

async function main() {
  console.log('====================================================');
  console.log(' 1. RUNNING CALIBRATION REGRESSION BENCHMARK (120 Channels)');
  console.log('====================================================');
  const benchResult = await runRegressionTestSuite('Calibration Benchmark');
  console.log(`Precision: ${benchResult.metrics.precision.toFixed(1)}% | Recall: ${benchResult.metrics.recall.toFixed(1)}% | F1: ${benchResult.metrics.f1_score.toFixed(1)}%`);
  console.log(`True Positives: ${benchResult.metrics.true_positives} | True Negatives: ${benchResult.metrics.true_negatives}`);
  console.log(`False Positives: ${benchResult.metrics.false_positives} | False Negatives: ${benchResult.metrics.false_negatives}`);

  console.log('\n====================================================');
  console.log(' 2. RUNNING INDEPENDENT HOLDOUT VALIDATION SUITE (23 Channels)');
  console.log('====================================================');
  const valResult = await runValidationTestSuite();
  console.log(`Precision: ${valResult.metrics.precision.toFixed(1)}% | Recall: ${valResult.metrics.recall.toFixed(1)}% | F1: ${valResult.metrics.f1_score.toFixed(1)}%`);
  console.log(`True Positives: ${valResult.metrics.true_positives} | True Negatives: ${valResult.metrics.true_negatives}`);
  console.log(`False Positives: ${valResult.metrics.false_positives} | False Negatives: ${valResult.metrics.false_negatives}`);

  console.log('\n====================================================');
  console.log(' SUMMARY');
  console.log('====================================================');
  const totalChannels = benchResult.metrics.total_tested + valResult.metrics.total_tested;
  const totalTP = benchResult.metrics.true_positives + valResult.metrics.true_positives;
  const totalTN = benchResult.metrics.true_negatives + valResult.metrics.true_negatives;
  const totalFP = benchResult.metrics.false_positives + valResult.metrics.false_positives;
  const totalFN = benchResult.metrics.false_negatives + valResult.metrics.false_negatives;

  const combinedPrecision = (totalTP + totalFP) > 0 ? (totalTP / (totalTP + totalFP)) * 100 : 100;
  const combinedRecall = (totalTP + totalFN) > 0 ? (totalTP / (totalTP + totalFN)) * 100 : 100;
  const combinedF1 = (combinedPrecision + combinedRecall) > 0 ? (2 * combinedPrecision * combinedRecall) / (combinedPrecision + combinedRecall) : 0;

  console.log(`Total Combined Test Cases: ${totalChannels}`);
  console.log(`Overall Precision: ${combinedPrecision.toFixed(1)}%`);
  console.log(`Overall Recall:    ${combinedRecall.toFixed(1)}%`);
  console.log(`Overall F1 Score:  ${combinedF1.toFixed(1)}%`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
