import { createHash } from 'node:crypto';

export const UTILITY_CONTRACT_VERSION='utility-constraints-v1';
export type HardConstraintCode='COUNTRY_POLICY'|'TERMINAL_PRECISION'|'PROVIDER_QUOTA'|'CASE_QUOTA'|'LATENCY_DEADLINE'|'REVIEW_CAPACITY'|'GOVERNED_ACTION'|'PREREQUISITE';
export interface UtilityVector {decisionResolution:number;confirmationRecall:number;precisionProtection:number;coverageGain:number;informationGain:number;providerCost:number;reviewCost:number;latencyMs:number;operationalRisk:number}
export interface UtilityWeights {decisionResolution:number;confirmationRecall:number;precisionProtection:number;coverageGain:number;informationGain:number;providerCost:number;reviewCost:number;latencyMs:number;operationalRisk:number}
export interface ConstraintContext {countryAllowed:boolean;terminalPrecisionProtected:boolean;providerQuotaRemaining:number;caseQuotaRemaining:number;latencyRemainingMs:number;reviewCapacityRemaining:number;governedAction:boolean;prerequisitesSatisfied:boolean}
export interface UtilityAssessment {feasible:boolean;score:number|null;violations:HardConstraintCode[];vector:UtilityVector;contractVersion:string;checksum:string}

const stable=(value:unknown):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
export const utilityChecksum=(value:unknown)=>createHash('sha256').update(stable(value)).digest('hex');
const finite=(value:number)=>Number.isFinite(value)&&value>=0;
export function assessUtility(vector:UtilityVector,weights:UtilityWeights,constraints:ConstraintContext,requirements:{providerCost:number;reviewCost:number;latencyMs:number}):UtilityAssessment{
  if(Object.values(vector).some(value=>!finite(value))||Object.values(weights).some(value=>!finite(value))||Object.values(requirements).some(value=>!finite(value)))throw new Error('Utility values, weights, and requirements must be finite and non-negative.');
  const violations:HardConstraintCode[]=[];if(!constraints.countryAllowed)violations.push('COUNTRY_POLICY');if(!constraints.terminalPrecisionProtected)violations.push('TERMINAL_PRECISION');if(!constraints.governedAction)violations.push('GOVERNED_ACTION');if(!constraints.prerequisitesSatisfied)violations.push('PREREQUISITE');if(requirements.providerCost>constraints.providerQuotaRemaining)violations.push('PROVIDER_QUOTA');if(requirements.providerCost>constraints.caseQuotaRemaining)violations.push('CASE_QUOTA');if(requirements.latencyMs>constraints.latencyRemainingMs)violations.push('LATENCY_DEADLINE');if(requirements.reviewCost>constraints.reviewCapacityRemaining)violations.push('REVIEW_CAPACITY');
  const benefit=vector.decisionResolution*weights.decisionResolution+vector.confirmationRecall*weights.confirmationRecall+vector.precisionProtection*weights.precisionProtection+vector.coverageGain*weights.coverageGain+vector.informationGain*weights.informationGain;
  const cost=vector.providerCost*weights.providerCost+vector.reviewCost*weights.reviewCost+vector.latencyMs*weights.latencyMs+vector.operationalRisk*weights.operationalRisk,score=violations.length?null:benefit-cost,unsigned={contractVersion:UTILITY_CONTRACT_VERSION,feasible:violations.length===0,score,violations,vector};return {...unsigned,checksum:utilityChecksum(unsigned)};
}
