export const NOMINATION_POLICY_VERSION='candidate-nomination-v1';
export const NOMINATION_FEATURE_VERSION='source-observation-v1';
export const ADMISSION_POLICY_VERSION='candidate-admission-shadow-v1';

export type NominationState='OBSERVED'|'DUPLICATE_ENTITY'|'POLICY_REJECTED'|'INVESTIGATION_QUEUED'|'BUDGET_DEFERRED'|'EXPIRED';
export type AdmissionMode='OFF'|'SHADOW'|'CANARY'|'ACTIVE';
export type AdmissionState='NOT_EVALUATED'|'LEGACY_VISIBLE'|'WITHHELD_INVESTIGATING'|'ADMITTED_CONFIRMED'|'ADMITTED_REVIEW'|'WITHHELD_NO_PLAUSIBLE_HYPOTHESIS'|'WITHHELD_OPERATIONAL_FAILURE'|'WITHHELD_POLICY'|'WITHHELD_TERMINAL_NON_TRADING'|'SUPERSEDED';
export type AdmissionClassificationStatus='TRADING_CONFIRMED'|'NON_TRADING'|'UNCERTAIN'|'NEEDS_REVIEW'|'HUMAN_REJECTED'|'COUNTRY_REJECTED'|'UNKNOWN';
export interface MatchedDocument {type:'VIDEO'|'CHANNEL'|'PLAYLIST'|'EXTERNAL'|'MANUAL'|'UNKNOWN';providerNativeId?:string;title?:string;description?:string;publishedAt?:string;locator?:string}
export interface NominationInput {channelId:string;channelEntityId?:string;sourceType:string;sourceActionId?:string;queryId?:number;queryRunId?:string;jobId?:string;queryCatalogVersion?:string;query:string;querySemanticClasses?:string[];queryGenerationMode?:string;country:string;declaredLanguage?:string;retrievalLane?:string;searchOrdering?:string;pageNumber?:number;resultRank?:number;matchedDocument:MatchedDocument;rawObservation:Record<string,unknown>;observedAt?:string}
export interface AdmissionPolicyInput {channelId:string;priorState:AdmissionState;classificationStatus:AdmissionClassificationStatus;investigationState?:string;classificationDiagnosticId?:string;investigationId?:string;reviewId?:string;candidateHypothesis?:Record<string,unknown>;evidenceCoverage?:Record<string,unknown>;terminalCountryPolicy?:boolean;operationalFailure?:boolean}
export interface AdmissionEvaluation {resultingState:AdmissionState;reasonCodes:string[];servingAuthority:false;policyVersion:string}
