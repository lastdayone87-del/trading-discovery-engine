import { createHash } from 'node:crypto';

export const PHASE_3_POLICY_VERSION = 'phase-3-baseline-v1';
export type ValidationKind = 'MIGRATION'|'RESTORE'|'RESTART'|'QUOTA'|'CLASSIFIER'|'BASELINE'|'PROVIDER';
export type ValidationStatus = 'PASS'|'FAIL'|'INCOMPLETE';

export interface LabeledPrediction {
  country: string;
  expected: boolean;
  predicted: boolean;
  confidence: number;
}

export interface ConfusionMatrix { truePositive:number; trueNegative:number; falsePositive:number; falseNegative:number; precision:number|null; recall:number|null; sampleSize:number }
export interface ReliabilityBin { lower:number; upper:number; count:number; averageConfidence:number|null; observedAccuracy:number|null }

const ratio=(n:number,d:number):number|null => d ? n/d : null;
export function confusionMatrix(rows:LabeledPrediction[]):ConfusionMatrix {
  const counts={truePositive:0,trueNegative:0,falsePositive:0,falseNegative:0};
  for(const row of rows){
    if(row.expected&&row.predicted) counts.truePositive++;
    else if(!row.expected&&!row.predicted) counts.trueNegative++;
    else if(!row.expected&&row.predicted) counts.falsePositive++;
    else counts.falseNegative++;
  }
  return {...counts,precision:ratio(counts.truePositive,counts.truePositive+counts.falsePositive),recall:ratio(counts.truePositive,counts.truePositive+counts.falseNegative),sampleSize:rows.length};
}

export function reliabilityCurve(rows:LabeledPrediction[],binCount=10):ReliabilityBin[]{
  if(!Number.isInteger(binCount)||binCount<1||binCount>100) throw new Error('binCount must be an integer from 1 to 100.');
  const bins=Array.from({length:binCount},(_,i)=>({lower:i/binCount,upper:(i+1)/binCount,values:[] as LabeledPrediction[]}));
  for(const row of rows){
    if(!Number.isFinite(row.confidence)||row.confidence<0||row.confidence>1) throw new Error('Confidence must be between 0 and 1.');
    bins[Math.min(binCount-1,Math.floor(row.confidence*binCount))].values.push(row);
  }
  return bins.map(({lower,upper,values})=>({lower,upper,count:values.length,averageConfidence:values.length?values.reduce((n,r)=>n+r.confidence,0)/values.length:null,observedAccuracy:values.length?values.filter(r=>r.expected===r.predicted).length/values.length:null}));
}

export function classifierReport(rows:LabeledPrediction[],binCount=10){
  const countries=[...new Set(rows.map(r=>r.country||'UNKNOWN'))].sort();
  return {sampleSize:rows.length,overall:confusionMatrix(rows),byCountry:Object.fromEntries(countries.map(c=>[c,confusionMatrix(rows.filter(r=>r.country===c))])),reliability:reliabilityCurve(rows,binCount)};
}

/** Stable checksum for retaining evidence without putting a corpus or backup in PostgreSQL. */
export function artifactChecksum(value:unknown):string {
  const stable=(input:any):any => Array.isArray(input)?input.map(stable):input&&typeof input==='object'?Object.fromEntries(Object.keys(input).sort().map(k=>[k,stable(input[k])])):input;
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

export function validateLedgerInput(input:{startedAt:string;completedAt:string;artifactChecksum:string;summary:unknown}){
  if(!/^[a-f0-9]{64}$/.test(input.artifactChecksum)) throw new Error('artifactChecksum must be a lowercase SHA-256 digest.');
  const start=Date.parse(input.startedAt), end=Date.parse(input.completedAt);
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<start) throw new Error('Validation timestamps are invalid or reversed.');
  const serialized=JSON.stringify(input.summary);
  if(serialized.length>100_000) throw new Error('Validation summary is too large; store artifacts externally and retain only results/checksums.');
}
