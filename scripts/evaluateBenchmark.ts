import { runRegressionTestSuite, BENCHMARK_DATASET } from '../server/regressionSuite.js';
import { classifyTradingRelevance } from '../server/tradingRelevanceClassifier.js';

async function main() {
  console.log('Running benchmark evaluation...');
  const run = await runRegressionTestSuite('Analysis Run');
  console.log('\n--- METRICS ---');
  console.log(JSON.stringify(run.metrics, null, 2));

  console.log('\n--- DETAILED CHANNEL ANALYSIS ---');
  let score50to64Count = 0;
  let score50to64Trading = 0;
  let score50to64NonTrading = 0;

  const score50to64List: any[] = [];
  const falseNegativesList: any[] = [];
  const falsePositivesList: any[] = [];

  for (const sample of BENCHMARK_DATASET) {
    const rel = await classifyTradingRelevance(
      sample.channel_name,
      sample.sample_description,
      sample.sample_video_titles,
      '',
      sample.country
    );

    const score = rel.confidenceScore;
    const status = rel.status;

    if (score >= 50 && score <= 64) {
      score50to64Count++;
      if (sample.ground_truth_trading === 'TRADING_CONFIRMED') score50to64Trading++;
      else score50to64NonTrading++;

      score50to64List.push({
        id: sample.channel_id,
        name: sample.channel_name,
        country: sample.country,
        groundTruth: sample.ground_truth_trading,
        score,
        status,
        reasoning: rel.breakdown.reasoning
      });
    }

    if (sample.ground_truth_trading === 'TRADING_CONFIRMED' && status !== 'TRADING_CONFIRMED') {
      falseNegativesList.push({
        id: sample.channel_id,
        name: sample.channel_name,
        country: sample.country,
        category: sample.ground_truth_category,
        score,
        status,
        reasoning: rel.breakdown.reasoning
      });
    }

    if (sample.ground_truth_trading === 'NON_TRADING' && status === 'TRADING_CONFIRMED') {
      falsePositivesList.push({
        id: sample.channel_id,
        name: sample.channel_name,
        country: sample.country,
        category: sample.ground_truth_category,
        score,
        status,
        reasoning: rel.breakdown.reasoning
      });
    }
  }

  console.log(`\nChannels in Score Range 50-64: ${score50to64Count}`);
  console.log(`  - Genuine Trading Creators: ${score50to64Trading}`);
  console.log(`  - Non-Trading Channels: ${score50to64NonTrading}`);

  console.log('\n--- CHANNELS IN SCORE RANGE 50-64 ---');
  console.log(JSON.stringify(score50to64List, null, 2));

  console.log('\n--- FALSE NEGATIVES (Genuine Trading Creators Not Verified) ---');
  console.log(JSON.stringify(falseNegativesList, null, 2));

  console.log('\n--- FALSE POSITIVES (Non-Trading Falsely Verified) ---');
  console.log(JSON.stringify(falsePositivesList, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
