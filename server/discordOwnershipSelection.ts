import type {DiscordCandidate} from './discordCandidates';

export function discordOwnershipRank(candidate:DiscordCandidate):number{
  return candidate.ownershipStatus==='CREATOR_OWNED'?3:candidate.ownershipStatus==='UNCERTAIN'?2:1;
}

export function discordValidationRank(validation:{operationalOutcome?:string;relevanceStatus?:string;status?:string}):number{
  if(validation.operationalOutcome==='SUCCEEDED'){
    if(validation.relevanceStatus==='TRADING_RELEVANT'&&(validation.status==='ACTIVE'||validation.status==='ACTIVE_LOW_VOLUME'))return 100;
    if(validation.relevanceStatus==='TRADING_RELEVANT')return 90;
    if(validation.relevanceStatus==='UNCERTAIN'||validation.status==='UNCERTAIN')return 60;
    if(validation.status==='NON_TRADING'||validation.relevanceStatus==='NON_TRADING')return 40;
    if(validation.status==='DEAD')return 30;
    return 50;
  }
  if(validation.operationalOutcome==='INVALID_OBSERVED')return 20;
  if(validation.operationalOutcome==='CONFIRMED_INVALID')return 10;
  return 0;
}

/** A `SUCCEEDED` lookup is not automatically usable: it can be operationally
 * successful while returning no serving invite and no relevance evidence
 * (status/relevance `UNCERTAIN`). Such an ambiguous result must not outrank a
 * candidate that actually serves a live invite. When a caller supplies an
 * invite URL, a null/empty value is likewise not usable. */
export function isUsableDiscordValidation(validation:{operationalOutcome?:string;relevanceStatus?:string;status?:string;inviteUrl?:string|null}):boolean{
  if(validation.operationalOutcome!=='SUCCEEDED')return false;
  if(validation.status!=='ACTIVE'&&validation.status!=='ACTIVE_LOW_VOLUME')return false;
  return validation.inviteUrl===undefined||Boolean(validation.inviteUrl);
}

/** Ownership is the primary selection dimension. Health/relevance ranks only
 * candidates within the same ownership tier, so an active partner community
 * cannot replace a creator-owned candidate merely because it validates first. */
export function discordCandidateCompositeRank(candidate:DiscordCandidate,validation:{operationalOutcome?:string;relevanceStatus?:string;status?:string;inviteUrl?:string|null}):number{
  // A genuinely usable validation always outranks an operationally
  // unavailable, invalid, or ambiguous candidate. Ownership remains
  // authoritative within the same usability tier, so a healthy partner still
  // cannot replace a healthy creator-owned community.
  const usable=isUsableDiscordValidation(validation)?10000:0;
  return usable+discordOwnershipRank(candidate)*1000+discordValidationRank(validation);
}
