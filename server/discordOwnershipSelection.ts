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

/** Ownership is the primary selection dimension. Health/relevance ranks only
 * candidates within the same ownership tier, so an active partner community
 * cannot replace a creator-owned candidate merely because it validates first. */
export function discordCandidateCompositeRank(candidate:DiscordCandidate,validation:{operationalOutcome?:string;relevanceStatus?:string;status?:string}):number{
  return discordOwnershipRank(candidate)*1000+discordValidationRank(validation);
}
