import {ADMISSION_REASON_CODES as R} from './reasonCodes';
import {ADMISSION_POLICY_VERSION,type AdmissionEvaluation,type AdmissionPolicyInput,type AdmissionState} from './types';
import {admissionChecksum} from './versioning';

export function assignAdmissionCanary(subjectKey:string,basisPoints:number){if(!subjectKey.trim()||!Number.isInteger(basisPoints)||basisPoints<0||basisPoints>10000)throw new Error('INVALID_ADMISSION_CANARY_ALLOCATION');const randomizationValue=parseInt(admissionChecksum(subjectKey).slice(0,8),16)%10000;return {basisPoints,randomizationValue,assigned:randomizationValue<basisPoints,servingAuthority:false as const};}

/** Structural Release-1 shadow policy. It cannot serve, review, confirm, or reject independently. */
export function evaluateAdmission(input:AdmissionPolicyInput):AdmissionEvaluation{
 let resultingState:AdmissionState='WITHHELD_NO_PLAUSIBLE_HYPOTHESIS';const reasonCodes:string[]=[];
 if(input.terminalCountryPolicy||input.classificationStatus==='COUNTRY_REJECTED'){resultingState='WITHHELD_POLICY';reasonCodes.push(R.COUNTRY_POLICY_TERMINAL);}
 else if(input.classificationStatus==='NON_TRADING'||input.classificationStatus==='HUMAN_REJECTED'){resultingState='WITHHELD_TERMINAL_NON_TRADING';reasonCodes.push(R.CLASSIFIER_TERMINAL_NON_TRADING);}
 else if(input.operationalFailure){resultingState='WITHHELD_OPERATIONAL_FAILURE';reasonCodes.push(R.OPERATIONAL_FAILURE_NOT_SEMANTIC_REVIEW);}
 else if(input.classificationStatus==='TRADING_CONFIRMED'){resultingState='ADMITTED_CONFIRMED';reasonCodes.push(R.CLASSIFIER_CONFIRMED);}
 else if(input.investigationState==='ACTIVE'){resultingState='WITHHELD_INVESTIGATING';reasonCodes.push(R.INVESTIGATION_ACTIVE);}
 else {resultingState='WITHHELD_NO_PLAUSIBLE_HYPOTHESIS';reasonCodes.push(R.NO_PLAUSIBLE_TRADING_HYPOTHESIS,R.REVIEW_NOT_YET_ELIGIBLE,R.SELECTIVE_POLICY_ABSTAINED);}
 return {resultingState,reasonCodes,servingAuthority:false,policyVersion:ADMISSION_POLICY_VERSION};
}

const transitions:Record<AdmissionState,AdmissionState[]>= {
 NOT_EVALUATED:['LEGACY_VISIBLE','WITHHELD_INVESTIGATING','ADMITTED_CONFIRMED','WITHHELD_NO_PLAUSIBLE_HYPOTHESIS','WITHHELD_OPERATIONAL_FAILURE','WITHHELD_POLICY','WITHHELD_TERMINAL_NON_TRADING'],
 LEGACY_VISIBLE:['WITHHELD_INVESTIGATING','ADMITTED_CONFIRMED','WITHHELD_NO_PLAUSIBLE_HYPOTHESIS','WITHHELD_OPERATIONAL_FAILURE','WITHHELD_POLICY','WITHHELD_TERMINAL_NON_TRADING','SUPERSEDED'],
 WITHHELD_INVESTIGATING:['ADMITTED_CONFIRMED','ADMITTED_REVIEW','WITHHELD_NO_PLAUSIBLE_HYPOTHESIS','WITHHELD_OPERATIONAL_FAILURE','WITHHELD_POLICY','WITHHELD_TERMINAL_NON_TRADING','SUPERSEDED'],
 ADMITTED_CONFIRMED:['WITHHELD_POLICY','WITHHELD_TERMINAL_NON_TRADING','SUPERSEDED'],ADMITTED_REVIEW:['ADMITTED_CONFIRMED','WITHHELD_POLICY','WITHHELD_TERMINAL_NON_TRADING','SUPERSEDED'],
 WITHHELD_NO_PLAUSIBLE_HYPOTHESIS:['WITHHELD_INVESTIGATING','ADMITTED_CONFIRMED','WITHHELD_POLICY','WITHHELD_TERMINAL_NON_TRADING','SUPERSEDED'],
 WITHHELD_OPERATIONAL_FAILURE:['WITHHELD_INVESTIGATING','ADMITTED_CONFIRMED','WITHHELD_POLICY','WITHHELD_TERMINAL_NON_TRADING','SUPERSEDED'],
 WITHHELD_POLICY:['SUPERSEDED'],WITHHELD_TERMINAL_NON_TRADING:['SUPERSEDED'],SUPERSEDED:[]
};
export function assertAdmissionTransition(from:AdmissionState,to:AdmissionState){if(from===to)return;if(!transitions[from].includes(to))throw new Error(`INVALID_ADMISSION_TRANSITION:${from}:${to}`);}
