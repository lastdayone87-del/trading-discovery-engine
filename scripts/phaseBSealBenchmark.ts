import 'dotenv/config';
import { sealPhaseBBenchmarksAfterPreflight } from '../server/phaseBSealPreflight';

const required = (key: string) => {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
};

sealPhaseBBenchmarksAfterPreflight({
  actor: process.env.PHASE_B_ACTOR || 'phase-b-operator',
  minimumEffectiveSampleSize: Number(process.env.PHASE_B_MINIMUM_ESS || '30'),
  windowStart: process.env.PHASE_B_WINDOW_START,
  definition: {
    datasetKey: process.env.PHASE_B_DATASET_KEY || 'creator-focus-phase-b',
    calibrationFrom: required('PHASE_B_CALIBRATION_FROM'),
    testFrom: required('PHASE_B_TEST_FROM'),
    cutoffAt: required('PHASE_B_CUTOFF_AT')
  }
})
  .then(({ preflight, sealed }) =>
    console.log(
      JSON.stringify(
        {
          preflightReady: preflight.ready,
          sealingPermitted: preflight.sealingPermitted,
          datasetId: sealed.dataset.id,
          baselineRunId: sealed.baseline.id,
          creatorFocusRunId: sealed.creatorFocus.id,
          servingAuthority: false,
          automaticPromotion: false
        },
        null,
        2
      )
    )
  )
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
