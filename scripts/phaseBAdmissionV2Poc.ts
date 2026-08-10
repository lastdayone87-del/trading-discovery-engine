import 'dotenv/config';
import { runPhaseBAdmissionV2Poc } from '../server/phaseBAdmissionV2Poc';

const datasetId = process.argv[2] || process.env.ADMISSION_V2_DATASET_ID || process.env.PHASE_B_DATASET_ID || '';
if (!datasetId) {
  throw new Error('Usage: npm run phaseb:admission-v2-poc -- <sealed-dataset-uuid>');
}

const result = await runPhaseBAdmissionV2Poc(datasetId);
console.log(
  JSON.stringify(
    {
      version: result.version,
      ready: result.ready,
      servingAuthority: result.servingAuthority,
      automaticPromotion: result.automaticPromotion,
      dataset: result.dataset,
      verification: {
        ready: result.verification.ready,
        reasonCodes: result.verification.reasonCodes,
        checks: result.verification.checks,
        metrics: result.verification.metrics
      },
      replay: result.replay,
      offlineReport: {
        reportVersion: result.offlineReport.reportVersion,
        policyVersion: result.offlineReport.policyVersion,
        hypothesisAssessment: result.offlineReport.hypothesisAssessment,
        evaluatedExamples: result.offlineReport.evaluatedExamples,
        excludedExamples: result.offlineReport.excludedExamples,
        decisionCounts: result.offlineReport.decisionCounts,
        metrics: result.offlineReport.metrics,
        segments: result.offlineReport.segments,
        inputChecksum: result.offlineReport.inputChecksum,
        outputChecksum: result.offlineReport.outputChecksum,
        servingAuthority: result.offlineReport.servingAuthority,
        automaticPromotion: result.offlineReport.automaticPromotion,
        generatedFromImmutableHistory: result.offlineReport.generatedFromImmutableHistory
      }
    },
    null,
    2
  )
);

if (!result.ready) process.exitCode = 2;
