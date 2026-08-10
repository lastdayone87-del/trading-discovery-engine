import 'dotenv/config';
import {
  inspectActivePhaseBCollectionEpoch,
  inspectPhaseBBundleAvailability
} from '../server/phaseBCollectionEpoch';

const windowStart = process.env.PHASE_B_WINDOW_START;
const cutoffAt = process.env.PHASE_B_CUTOFF_AT;

const active = await inspectActivePhaseBCollectionEpoch();
const report: Record<string, unknown> = {
  epoch: active,
  servingAuthority: false,
  automaticPromotion: false
};

if (windowStart && cutoffAt) {
  report.bundleAvailability = await inspectPhaseBBundleAvailability({
    windowStart,
    cutoffAt,
    minimumAvailabilityBasisPoints: process.env.PHASE_B_MINIMUM_BUNDLE_AVAILABILITY_BPS
      ? Number(process.env.PHASE_B_MINIMUM_BUNDLE_AVAILABILITY_BPS)
      : undefined
  });
  if (!(report.bundleAvailability as { ready: boolean }).ready) process.exitCode = 2;
}

if (!active.declared) process.exitCode = process.exitCode || 2;
console.log(JSON.stringify(report, null, 2));
