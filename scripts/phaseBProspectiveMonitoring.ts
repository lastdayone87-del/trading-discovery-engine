import 'dotenv/config';
import { inspectPhaseBProspectiveMonitoring } from '../server/phaseBProspectiveMonitoring';

const report = await inspectPhaseBProspectiveMonitoring({
  windowStart: process.env.PHASE_B_WINDOW_START,
  cutoffAt: process.env.PHASE_B_CUTOFF_AT,
  minimumClassEss: process.env.PHASE_B_MINIMUM_CLASS_ESS
    ? Number(process.env.PHASE_B_MINIMUM_CLASS_ESS)
    : undefined,
  minimumEvidenceEligibilityBasisPoints: process.env.PHASE_B_MINIMUM_EVIDENCE_ELIGIBILITY_BPS
    ? Number(process.env.PHASE_B_MINIMUM_EVIDENCE_ELIGIBILITY_BPS)
    : undefined
});

console.log(JSON.stringify(report, null, 2));
if (!report.ready) process.exitCode = 2;
