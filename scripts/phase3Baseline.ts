import fs from 'node:fs';
import path from 'node:path';
import { artifactChecksum, classifierReport, PHASE_3_POLICY_VERSION, type LabeledPrediction } from '../server/phase3Validation';

interface Dataset {
  datasetVersion: string;
  heldOut: boolean;
  country: LabeledPrediction[];
  trading: LabeledPrediction[];
  baseline: {
    periodStart:string; periodEnd:string; verifiedNetNewCreators:number; verifiedCommunities:number;
    duplicateHits:number; rawHits:number; youtubeCost:number; aiCost:number; computeCost:number; reviewCost:number;
    coverageByCountry:Record<string,number>; legacyMissingProvenance:number;
  };
}

const input=process.argv[2];
if(!input) throw new Error('Usage: npm run phase3:baseline -- <held-out-dataset.json> [output.json]');
const dataset=JSON.parse(fs.readFileSync(input,'utf8')) as Dataset;
if(!dataset.datasetVersion||dataset.heldOut!==true) throw new Error('A versioned held-out dataset is required.');
if(!Array.isArray(dataset.country)||!Array.isArray(dataset.trading)||!dataset.baseline) throw new Error('Dataset must contain country, trading, and baseline sections.');
const {baseline}=dataset;
if(Date.parse(baseline.periodEnd)<Date.parse(baseline.periodStart)) throw new Error('Baseline period is reversed.');
const totalCost=baseline.youtubeCost+baseline.aiCost+baseline.computeCost+baseline.reviewCost;
const report={
  policyVersion:PHASE_3_POLICY_VERSION,datasetVersion:dataset.datasetVersion,inputChecksum:artifactChecksum(dataset),generatedAt:new Date().toISOString(),
  definitions:{primary:'verified incremental coverage per total constrained cost at equal or better country and trading precision',costUnit:'deployment-defined currency; provider categories remain separate',missingProvenance:'segmented as legacy/missing; never imputed'},
  countryClassifier:classifierReport(dataset.country),tradingClassifier:classifierReport(dataset.trading),
  baseline:{...baseline,totalCost,costPerVerifiedCreator:baseline.verifiedNetNewCreators?totalCost/baseline.verifiedNetNewCreators:null,duplicateRate:baseline.rawHits?baseline.duplicateHits/baseline.rawHits:null}
};
const output=process.argv[3]||path.join(process.cwd(),'data','validation-artifacts',`phase3-baseline-${dataset.datasetVersion}.json`);
fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(report,null,2));
console.log(JSON.stringify({output,checksum:artifactChecksum(report),datasetVersion:dataset.datasetVersion},null,2));
