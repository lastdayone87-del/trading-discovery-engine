import 'dotenv/config';
import { inspectPhaseBSealPreflight } from '../server/phaseBSealPreflight';

const required = (key: string) => {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
};

const report = await inspectPhaseBSealPreflight({
  windowStart: process.env.PHASE_B_WINDOW_START,
  minimumClassEss: process.env.PHASE_B_MINIMUM_ESS
    ? Number(process.env.PHASE_B_MINIMUM_ESS)
    : undefined,
  minimumEvidenceEligibilityBasisPoints: process.env.PHASE_B_MINIMUM_EVIDENCE_ELIGIBILITY_BPS
    ? Number(process.env.PHASE_B_MINIMUM_EVIDENCE_ELIGIBILITY_BPS)
    : undefined,
  definition: {
    datasetKey: process.env.PHASE_B_DATASET_KEY || 'creator-focus-phase-b',
    calibrationFrom: required('PHASE_B_CALIBRATION_FROM'),
    testFrom: required('PHASE_B_TEST_FROM'),
    cutoffAt: required('PHASE_B_CUTOFF_AT')
  }
});

console.log(JSON.stringify(report, null, 2));
if (!report.sealingPermitted) process.exitCode = 2;
