import { BENCHMARK_DATASET } from '../server/regressionSuite.js';
import { classifyTradingRelevance } from '../server/tradingRelevanceClassifier.js';

async function runFastBenchmark() {
  console.log(`Starting fast benchmark run on ${BENCHMARK_DATASET.length} channels...`);
  const startTime = Date.now();

  let truePositives = 0;
  let trueNegatives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;

  const scoreDistribution = {
    under25: 0,
    range25to49: 0,
    range50to64: 0,
    range65plus: 0
  };

  const score50to64Channels: any[] = [];
  const falseNegativesList: any[] = [];
  const falsePositivesList: any[] = [];

  // Process in batches of 10
  const BATCH_SIZE = 10;
  const results: any[] = [];

  for (let i = 0; i < BENCHMARK_DATASET.length; i += BATCH_SIZE) {
    const batch = BENCHMARK_DATASET.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (sample) => {
        const rel = await classifyTradingRelevance(
          sample.channel_name,
          sample.sample_description,
          sample.sample_video_titles,
          '',
          sample.country
        );
        return { sample, rel };
      })
    );
    results.push(...batchResults);
  }

  for (const { sample, rel } of results) {
    const score = rel.confidenceScore;
    const status = rel.status;

    if (score < 25) scoreDistribution.under25++;
    else if (score < 50) scoreDistribution.range25to49++;
    else if (score <= 64) scoreDistribution.range50to64++;
    else scoreDistribution.range65plus++;

    const isTrueTrading = sample.ground_truth_trading === 'TRADING_CONFIRMED';
    const isPredictedTrading = status === 'TRADING_CONFIRMED';

    if (isTrueTrading && isPredictedTrading) truePositives++;
    else if (!isTrueTrading && !isPredictedTrading) trueNegatives++;
    else if (!isTrueTrading && isPredictedTrading) falsePositives++;
    else if (isTrueTrading && !isPredictedTrading) falseNegatives++;

    if (score >= 50 && score <= 64) {
      score50to64Channels.push({
        id: sample.channel_id,
        name: sample.channel_name,
        country: sample.country,
        category: sample.ground_truth_category,
        groundTruth: sample.ground_truth_trading,
        score,
        status,
        posWeight: rel.breakdown.stage_a_score,
        consistency: rel.breakdown.consistency_ratio,
        reasoning: rel.breakdown.reasoning
      });
    }

    if (isTrueTrading && !isPredictedTrading) {
      falseNegativesList.push({
        id: sample.channel_id,
        name: sample.channel_name,
        country: sample.country,
        category: sample.ground_truth_category,
        score,
        status,
        posWeight: rel.breakdown.stage_a_score,
        consistency: rel.breakdown.consistency_ratio,
        reasoning: rel.breakdown.reasoning
      });
    }

    if (!isTrueTrading && isPredictedTrading) {
      falsePositivesList.push({
        id: sample.channel_id,
        name: sample.channel_name,
        country: sample.country,
        category: sample.ground_truth_category,
        score,
        status,
        posWeight: rel.breakdown.stage_a_score,
        consistency: rel.breakdown.consistency_ratio,
        reasoning: rel.breakdown.reasoning
      });
    }
  }

  const totalTested = BENCHMARK_DATASET.length;
  const classifiedTrading = truePositives + falsePositives;
  const precision = classifiedTrading > 0 ? Math.round((truePositives / classifiedTrading) * 10000) / 100 : 100;
  const totalTrueTrading = truePositives + falseNegatives;
  const recall = totalTrueTrading > 0 ? Math.round((truePositives / totalTrueTrading) * 10000) / 100 : 100;
  const f1Score = (precision + recall) > 0 ? Math.round((2 * (precision * recall) / (precision + recall)) * 100) / 100 : 0;

  console.log(`\n=== BENCHMARK SUMMARY (${Date.now() - startTime}ms) ===`);
  console.log(`Total Channels Tested: ${totalTested}`);
  console.log(`True Positives: ${truePositives} | True Negatives: ${trueNegatives}`);
  console.log(`False Positives: ${falsePositives} | False Negatives: ${falseNegatives}`);
  console.log(`Precision: ${precision}% | Recall: ${recall}% | F1 Score: ${f1Score}`);

  console.log(`\nScore Distribution:`);
  console.log(`  - < 25 (VERIFIED_NON_TRADING): ${scoreDistribution.under25}`);
  console.log(`  - 25 to 49 (UNCERTAIN Low): ${scoreDistribution.range25to49}`);
  console.log(`  - 50 to 64 (UNCERTAIN Borderline): ${scoreDistribution.range50to64}`);
  console.log(`  - 65+ (VERIFIED_TRADING): ${scoreDistribution.range65plus}`);

  const tradingIn50to64 = score50to64Channels.filter(c => c.groundTruth === 'TRADING_CONFIRMED').length;
  const nonTradingIn50to64 = score50to64Channels.filter(c => c.groundTruth === 'NON_TRADING').length;

  console.log(`\nChannels in 50-64 Borderline Range (${score50to64Channels.length} total):`);
  console.log(`  - Genuine Trading Creators: ${tradingIn50to64}`);
  console.log(`  - Non-Trading Channels: ${nonTradingIn50to64}`);

  console.log(`\n--- ALL BORDERLINE CHANNELS (50-64) ---`);
  score50to64Channels.forEach(c => {
    console.log(`[${c.country}] ${c.name} (${c.category}) -> Score: ${c.score}, PosWeight: +${c.posWeight}, Consistency: ${c.consistency}`);
  });

  console.log(`\n--- ALL FALSE NEGATIVES (${falseNegativesList.length}) ---`);
  falseNegativesList.forEach(c => {
    console.log(`[${c.country}] ${c.name} (${c.category}) -> Score: ${c.score}, PosWeight: +${c.posWeight}, Consistency: ${c.consistency}`);
    console.log(`   Reasoning snippet: ${c.reasoning.slice(0, 3).join(' | ')}`);
  });

  console.log(`\n--- ALL FALSE POSITIVES (${falsePositivesList.length}) ---`);
  falsePositivesList.forEach(c => {
    console.log(`[${c.country}] ${c.name} (${c.category}) -> Score: ${c.score}, PosWeight: +${c.posWeight}, Consistency: ${c.consistency}`);
  });
}

runFastBenchmark().catch(console.error);
