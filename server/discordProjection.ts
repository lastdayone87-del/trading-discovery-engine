import type {ChannelRecord} from '../src/types';
import type {DiscordValidationResult} from './discordValidator';
import type {DiscordCandidate} from './discordCandidates';

export type DiscordProjection=Pick<ChannelRecord,'discord_status'|'discord_invite'|'discord_candidate_locator'|'discord_candidate_id'|'discord_candidate_raw_locator'|'discord_candidate_type'|'discord_resolution_status'|'discord_liveness_status'|'discord_relevance_status'|'discord_validation_status'|'discord_discovery_status'>;

/** Pure compatibility reducer. A validation result is scoped to one stable
 * candidate identity, so an older/different candidate cannot donate terminality. */
export function projectDiscordValidation(current:ChannelRecord,validation:DiscordValidationResult,candidate:DiscordCandidate):DiscordProjection{
  const preserveServingInvite=validation.operationalOutcome!=='SUCCEEDED'&&validation.operationalOutcome!=='CONFIRMED_INVALID';
  return {
    discord_status:validation.status,
    discord_invite:preserveServingInvite?current.discord_invite:validation.inviteUrl,
    discord_candidate_locator:validation.candidateInviteUrl,
    discord_candidate_id:candidate.candidateId,
    discord_candidate_raw_locator:candidate.rawLocator,
    discord_candidate_type:candidate.locatorType,
    discord_resolution_status:validation.resolutionStatus,
    discord_liveness_status:validation.livenessStatus,
    discord_relevance_status:validation.relevanceStatus,
    discord_validation_status:validation.validationStatus,
    discord_discovery_status:validation.validationStatus==='SUCCEEDED'||validation.validationStatus==='COMPLETED'?'VALIDATED':'DISCOVERED_VALIDATION_FAILED'
  };
}
