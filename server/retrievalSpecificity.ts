export const RETRIEVAL_SPECIFICITY_POLICY_VERSION='retrieval-specificity-v1';
export type RetrievalEligibility='STANDALONE'|'ANCHOR_ONLY'|'MODIFIER_ONLY'|'INELIGIBLE';
export interface RetrievalSpecificityDecision{eligibility:RetrievalEligibility;specificity:number;ambiguity:number;reasonCodes:string[];policyVersion:string;requiredCompanionClasses:string[]}

/** Language-neutral policy over governed semantic classes. Lexemes are never
 * blacklisted: generators must declare what a surface means and how it was governed. */
export function evaluateRetrievalSpecificity(input:{semanticClass:string;governed:boolean;proven?:boolean;independentSources?:number;validated?:boolean}):RetrievalSpecificityDecision{
  const kind=input.semanticClass.toUpperCase();let eligibility:RetrievalEligibility='INELIGIBLE',specificity=20,ambiguity=80,requiredCompanionClasses:string[]=[];const reasonCodes:string[]=[];
  if(['INSTRUMENT','PLATFORM','BROKER','PROPFIRM'].includes(kind)){eligibility='STANDALONE';specificity=95;ambiguity=5;reasonCodes.push('CONCRETE_TRADING_ENTITY');}
  else if(['METHOD','STRATEGY'].includes(kind)){eligibility=input.governed?'STANDALONE':'ANCHOR_ONLY';specificity=input.governed?82:68;ambiguity=input.governed?18:32;reasonCodes.push(input.governed?'GOVERNED_TRADING_METHOD':'CURATED_METHOD_ANCHOR');}
  else if(['MARKET','SESSION','TEMPORAL','GEOGRAPHIC'].includes(kind)){eligibility='MODIFIER_ONLY';specificity=42;ambiguity=72;requiredCompanionClasses=['INSTRUMENT','METHOD','STRATEGY','PLATFORM'];reasonCodes.push('AMBIGUOUS_MARKET_CONTEXT_REQUIRES_COMPANION');}
  else if(['FORMAT','TOPIC','ENTITY','NEIGHBORHOOD','COVERAGE','LEARNED'].includes(kind)){eligibility='MODIFIER_ONLY';specificity=45;ambiguity=65;requiredCompanionClasses=['INSTRUMENT','METHOD','STRATEGY'];reasonCodes.push('EXPANSION_SURFACE_REQUIRES_TRADING_ANCHOR');}
  else if(kind==='CONCEPT'&&input.governed&&input.proven&&input.validated&&(input.independentSources||0)>=2){eligibility='STANDALONE';specificity=80;ambiguity=20;reasonCodes.push('PROVEN_GOVERNED_CONCEPT');}
  else {reasonCodes.push('INSUFFICIENT_SEMANTIC_SPECIFICITY');}
  return {eligibility,specificity,ambiguity,reasonCodes,policyVersion:RETRIEVAL_SPECIFICITY_POLICY_VERSION,requiredCompanionClasses};
}
