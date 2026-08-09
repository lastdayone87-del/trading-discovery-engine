import { evaluateSealedDatasetOfflineV2 } from '../server/candidateAdmission/offlineV2Store';

const datasetId = process.argv[2] || process.env.ADMISSION_V2_DATASET_ID || '';
if (!datasetId) throw new Error('Usage: npm run admission:v2-poc -- <sealed-dataset-uuid>');

const report = await evaluateSealedDatasetOfflineV2(datasetId);
console.log(JSON.stringify(report, null, 2));
