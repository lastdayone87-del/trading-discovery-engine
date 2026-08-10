import 'dotenv/config';
import { declarePhaseBCollectionEpoch } from '../server/phaseBCollectionEpoch';

const validationRunId = process.env.PHASE_B_VALIDATION_RUN_ID;
if (!validationRunId) throw new Error('PHASE_B_VALIDATION_RUN_ID is required');

declarePhaseBCollectionEpoch({
  validationRunId,
  actor: process.env.PHASE_B_ACTOR || 'phase-b-operator',
  reason: process.env.PHASE_B_EPOCH_REASON || 'Phase B Milestone 4 collection epoch declaration',
  startedAt: process.env.PHASE_B_EPOCH_STARTED_AT,
  minimumBundleAvailabilityBps: process.env.PHASE_B_MINIMUM_BUNDLE_AVAILABILITY_BPS
    ? Number(process.env.PHASE_B_MINIMUM_BUNDLE_AVAILABILITY_BPS)
    : undefined
})
  .then(result => console.log(JSON.stringify(result, null, 2)))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
