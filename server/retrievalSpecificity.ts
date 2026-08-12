export const RETRIEVAL_SPECIFICITY_POLICY_VERSION='retrieval-specificity-v2';
export type RetrievalEligibility='STANDALONE'|'ANCHOR_ONLY'|'MODIFIER_ONLY'|'INELIGIBLE';
export interface RetrievalSpecificityDecision{eligibility:RetrievalEligibility;specificity:number;ambiguity:number;reasonCodes:string[];policyVersion:string;requiredCompanionClasses:string[]}

/**
 * Language-neutral retrieval policy over governed semantic classes.
 *
 * A semantic label alone is not sufficient authority for a broad vocabulary
 * surface to search YouTube globally. Curated/governed trading entities and
 * methods may stand alone; country-vocabulary, learned, and expansion surfaces
 * must be paired with an independent trading anchor. This prevents short or
 * overloaded terms (for example an exchange/index acronym that also has many
 * non-financial meanings) from flooding autonomous discovery without relying on
 * country-specific blacklists.
 */
export function evaluateRetrievalSpecificity(input:{semanticClass:string;governed:boolean;proven?:boolean;independentSources?:number;validated?:boolean}):RetrievalSpecificityDecision{
  const kind=input.semanticClass.toUpperCase();let eligibility:RetrievalEligibility='INELIGIBLE',specificity=20,ambiguity=80,requiredCompanionClasses:string[]=[];const reasonCodes:string[]=[];
  if(['INSTRUMENT','PLATFORM','BROKER','PROPFIRM'].includes(kind)){
    if(input.governed){eligibility='STANDALONE';specificity=95;ambiguity=5;reasonCodes.push('GOVERNED_CONCRETE_TRADING_ENTITY');}
    else{eligibility='MODIFIER_ONLY';specificity=62;ambiguity=48;requiredCompanionClasses=['METHOD','STRATEGY','MARKET'];reasonCodes.push('UNGOVERNED_ENTITY_REQUIRES_TRADING_ANCHOR');}
  }
  else if(['METHOD','STRATEGY'].includes(kind)){
    if(input.governed){eligibility='STANDALONE';specificity=82;ambiguity=18;reasonCodes.push('GOVERNED_TRADING_METHOD');}
    else{eligibility='MODIFIER_ONLY';specificity=58;ambiguity=52;requiredCompanionClasses=['INSTRUMENT','MARKET','PLATFORM','BROKER','PROPFIRM'];reasonCodes.push('UNGOVERNED_METHOD_REQUIRES_TRADING_ANCHOR');}
  }
  else if(['MARKET','SESSION','TEMPORAL','GEOGRAPHIC'].includes(kind)){eligibility='MODIFIER_ONLY';specificity=42;ambiguity=72;requiredCompanionClasses=['INSTRUMENT','METHOD','STRATEGY','PLATFORM'];reasonCodes.push('AMBIGUOUS_MARKET_CONTEXT_REQUIRES_COMPANION');}
  else if(['FORMAT','TOPIC','ENTITY','NEIGHBORHOOD','COVERAGE','LEARNED'].includes(kind)){eligibility='MODIFIER_ONLY';specificity=45;ambiguity=65;requiredCompanionClasses=['INSTRUMENT','METHOD','STRATEGY'];reasonCodes.push('EXPANSION_SURFACE_REQUIRES_TRADING_ANCHOR');}
  else if(kind==='CONCEPT'&&input.governed&&input.proven&&input.validated&&(input.independentSources||0)>=2){eligibility='STANDALONE';specificity=80;ambiguity=20;reasonCodes.push('PROVEN_GOVERNED_CONCEPT');}
  else {reasonCodes.push('INSUFFICIENT_SEMANTIC_SPECIFICITY');}
  return {eligibility,specificity,ambiguity,reasonCodes,policyVersion:RETRIEVAL_SPECIFICITY_POLICY_VERSION,requiredCompanionClasses};
}
