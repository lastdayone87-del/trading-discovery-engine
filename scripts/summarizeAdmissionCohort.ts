/**
 * Read-only summarizer for the 60-channel admission cohort.
 *
 * Usage:
 *   npx tsx scripts/summarizeAdmissionCohort.ts \
 *     --results=/tmp/admission-cohort-60.jsonl \
 *     --ground-truth=scripts/fixtures/admission-cohort-60-ground-truth.json
 */
import { readFileSync } from 'node:fs';

function argValue(name: string): string | undefined {
  return process.argv.find(arg => arg.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
}

type Label = 'TRADING' | 'FINANCE_ADJACENT' | 'UNRELATED' | 'AMBIGUOUS' | 'UNKNOWN_EVIDENCE';
interface GroundTruth { label: Label; note?: string }
const expectedAdmit = new Set<Label>(['TRADING', 'FINANCE_ADJACENT']);

const resultsPath = argValue('results') || '/tmp/opencode/admission-cohort-60.jsonl';
const truthPath = argValue('ground-truth') || 'scripts/fixtures/admission-cohort-60-ground-truth.json';
const rows = readFileSync(resultsPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as any);
const truthDocument = JSON.parse(readFileSync(truthPath, 'utf8')) as { _meta?: { reviewer?: string; method?: string; reviewedAt?: string }; labels?: Record<string, GroundTruth> };
if (!truthDocument._meta?.reviewer || !truthDocument._meta?.method || !truthDocument._meta?.reviewedAt) {
  console.error('Ground-truth file is missing reviewer/method/reviewedAt provenance metadata.');
  process.exitCode = 1;
}
const truth = (truthDocument.labels || truthDocument) as Record<string, GroundTruth>;
const label = (channelId: string): Label => truth[channelId]?.label || 'UNKNOWN_EVIDENCE';
const missingLabelIds = rows.map(row => row.channel?.channelId).filter(channelId => !channelId || !truth[channelId]);
if (missingLabelIds.length) {
  console.error(`Independent review labels are missing for ${missingLabelIds.length} cohort channel(s): ${missingLabelIds.join(', ')}`);
  process.exitCode = 1;
}
const tally = (items: string[]) => items.reduce((acc, item) => ({ ...acc, [item]: (acc[item] || 0) + 1 }), {} as Record<string, number>);

const deterministic = rows.map(row => row.deterministic?.outcome || 'NONE');
const finalDecisions = rows.map(row => row.final?.decision || 'NONE');
const detDecided = rows.filter(row => row.deterministic?.outcome === 'PASS' || row.deterministic?.outcome === 'REJECT');
const detCorrect = detDecided.filter(row => {
  const expected = expectedAdmit.has(label(row.channel.channelId));
  return row.deterministic.outcome === 'PASS' ? expected : !expected;
});
const finalDecided = rows.filter(row => ['ADMIT', 'ADMIT_AMBIGUOUS', 'REJECT_UNRELATED'].includes(row.final?.decision));
const finalCorrect = finalDecided.filter(row => {
  const expected = expectedAdmit.has(label(row.channel.channelId));
  return row.final.decision === 'REJECT_UNRELATED' ? !expected : expected;
});

const report = {
  event: 'admission_cohort_summary',
  resultsPath,
  total: rows.length,
  groups: tally(rows.map(row => row.group)),
  independentReviewLabels: tally(rows.map(row => label(row.channel.channelId))),
  labelProvenance: truthDocument._meta || null,
  prior: tally(rows.map(row => row.prior?.decision || 'NONE')),
  deterministic: {
    outcomes: tally(deterministic),
    decided: detDecided.length,
    correct: detCorrect.length,
    wrong: detDecided.length - detCorrect.length,
    accuracy: detDecided.length ? detCorrect.length / detDecided.length : null,
    coverage: rows.length ? detDecided.length / rows.length : null,
    fastPass: {
      total: rows.filter(row => row.deterministic?.outcome === 'PASS').length,
      wrong: rows.filter(row => row.deterministic?.outcome === 'PASS' && !expectedAdmit.has(label(row.channel.channelId))).length,
    },
    strictReject: {
      total: rows.filter(row => row.deterministic?.outcome === 'REJECT').length,
      wrong: rows.filter(row => row.deterministic?.outcome === 'REJECT' && expectedAdmit.has(label(row.channel.channelId))).length,
    },
    ambiguousByGroundTruth: tally(rows.filter(row => row.deterministic?.outcome === 'AMBIGUOUS').map(row => label(row.channel.channelId))),
  },
  final: (() => {
    const admitted = rows.filter(row => row.final?.decision === 'ADMIT' || row.final?.decision === 'ADMIT_AMBIGUOUS');
    const rejected = rows.filter(row => row.final?.decision === 'REJECT_UNRELATED');
    const review = rows.filter(row => row.final?.decision === 'NEEDS_REVIEW');
    const expectedAdmitRows = rows.filter(row => expectedAdmit.has(label(row.channel.channelId)));
    const expectedRejectRows = rows.filter(row => !expectedAdmit.has(label(row.channel.channelId)));
    const admittedExpected = admitted.filter(row => expectedAdmit.has(label(row.channel.channelId)));
    const rejectedExpected = rejected.filter(row => !expectedAdmit.has(label(row.channel.channelId)));
    return {
      decisions: tally(finalDecisions),
      decided: finalDecided.length,
      correct: finalCorrect.length,
      wrong: finalDecided.length - finalCorrect.length,
      accuracy: finalDecided.length ? finalCorrect.length / finalDecided.length : null,
      admitPrecision: admitted.length ? admittedExpected.length / admitted.length : null,
      rejectPrecision: rejected.length ? rejectedExpected.length / rejected.length : null,
      admitRecall: expectedAdmitRows.length ? admittedExpected.length / expectedAdmitRows.length : null,
      rejectRecall: expectedRejectRows.length ? rejectedExpected.length / expectedRejectRows.length : null,
      pendingReviewByLabel: tally(review.map(row => label(row.channel.channelId))),
      fetchFailed: rows.filter(row => row.final?.decision === 'COHORT_FETCH_FAILED').length,
      aiUnavailable: rows.filter(row => row.final?.decision === 'AI_UNAVAILABLE').length,
      providerDeferred: rows.filter(row => row.final?.decision === 'PROVIDER_DEFERRED').length,
      needsReview: review.length,
      unsafeRejects: rejected.filter(row => expectedAdmit.has(label(row.channel.channelId))).map(row => row.channel.channelName),
      unsafeAdmits: admitted.filter(row => !expectedAdmit.has(label(row.channel.channelId))).map(row => row.channel.channelName),
    };
  })(),
  unsafeTransitions: {
    priorAdmitToDeterministicReject: rows.filter(row => (row.prior?.decision === 'ADMIT' || row.prior?.decision === 'ADMIT_AMBIGUOUS') && row.deterministic?.outcome === 'REJECT').map(row => row.channel.channelName),
    priorRejectToDeterministicPass: rows.filter(row => row.prior?.decision === 'REJECT_UNRELATED' && row.deterministic?.outcome === 'PASS').map(row => row.channel.channelName),
  },
  generatedAt: new Date().toISOString(),
};
console.log(JSON.stringify(report, null, 2));
if (rows.length === 0 || missingLabelIds.length > 0 || report.deterministic.decided === 0 || report.final.decided === 0 || report.deterministic.wrong > 0 || report.final.wrong > 0) process.exitCode = 1;
