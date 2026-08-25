import type {ChannelRecord} from '../src/types';
import type {DiscordValidationResult} from './discordValidator';
import type {DiscordCandidate} from './discordCandidates';

export type DiscordProjection=Pick<ChannelRecord,'discord_status'|'discord_invite'|'discord_candidate_locator'|'discord_candidate_id'|'discord_candidate_raw_locator'|'discord_candidate_type'|'discord_resolution_status'|'discord_liveness_status'|'discord_relevance_status'|'discord_validation_status'|'discord_discovery_status'>;

/**
 * The Discord invite endpoint can prove liveness while exposing too little
 * semantic metadata to prove relevance. When that happens, creator association
 * may supply the missing evidence, but only under a deliberately strict gate:
 * a strongly trading-confirmed parent AND a high-confidence creator-owned
 * candidate AND no Discord-native non-trading classification.
 *
 * This is not used for THIRD_PARTY/UNCERTAIN ownership and therefore cannot
 * turn a sponsor/partner Discord into the creator's primary community merely
 * because the YouTube creator trades.
 */
export function applyCreatorAssociationToDiscordValidation(
  current:ChannelRecord,
  validation:DiscordValidationResult,
  candidate:DiscordCandidate
):DiscordValidationResult{
  const parentConfidence=Number(current.trading_confidence_score||0);
  const creatorOwned=candidate.ownershipStatus==='CREATOR_OWNED'&&Number(candidate.ownershipConfidence||0)>=70;
  const eligible=
    validation.operationalOutcome==='SUCCEEDED'&&
    validation.livenessStatus==='ACTIVE'&&
    validation.relevanceStatus==='UNCERTAIN'&&
    current.trading_status==='TRADING_CONFIRMED'&&
    parentConfidence>=80&&
    creatorOwned&&
    !validation.nativeRelevanceConflict;
  if(!eligible)return validation;

  const status=Number(validation.approximateMemberCount||0)>=50?'ACTIVE':'ACTIVE_LOW_VOLUME';
  return {
    ...validation,
    status,
    confidence:Math.max(70,validation.confidence),
    inviteUrl:validation.candidateInviteUrl,
    relevanceStatus:'TRADING_RELEVANT',
    relevanceReason:`Live Discord with sparse native metadata; relevance supported by ${parentConfidence}% trading-confirmed parent and high-confidence creator-owned source (${candidate.ownershipConfidence||0}% association)`
  };
}

/** Pure compatibility reducer. A validation result is scoped to one stable
 * candidate identity, so an older/different candidate cannot donate terminality. */
export function projectDiscordValidation(current:ChannelRecord,validation:DiscordValidationResult,candidate:DiscordCandidate):DiscordProjection{
  const effective=applyCreatorAssociationToDiscordValidation(current,validation,candidate);
  const preserveServingInvite=effective.operationalOutcome!=='SUCCEEDED'&&effective.operationalOutcome!=='CONFIRMED_INVALID';
  return {
    discord_status:effective.status,
    discord_invite:preserveServingInvite?current.discord_invite:effective.inviteUrl,
    discord_candidate_locator:effective.candidateInviteUrl,
    discord_candidate_id:candidate.candidateId,
    discord_candidate_raw_locator:candidate.rawLocator,
    discord_candidate_type:candidate.locatorType,
    discord_resolution_status:effective.resolutionStatus,
    discord_liveness_status:effective.livenessStatus,
    discord_relevance_status:effective.relevanceStatus,
    discord_validation_status:effective.validationStatus,
    discord_discovery_status:effective.validationStatus==='SUCCEEDED'||effective.validationStatus==='COMPLETED'?'VALIDATED':'DISCOVERED_VALIDATION_FAILED'
  };
}

/**
 * Fail-closed reconciliation of Discord discovery state against the *current*
 * inspection result. Called on success, absence safety, and catch paths of
 * inspectAndValidateChannel before persistence.
 *
 * Invariant: if the current inspection structurally discovered a native
 * Discord candidate, the channel must not remain NOT_FOUND / NOT_DISCOVERED.
 * Historical pure-absence is overwritten by current discovery evidence.
 * Successful VALIDATED states (ACTIVE/DEAD) are never downgraded.
 * Genuine complete inspections that retained zero candidates are left alone
 * so the absence path can still project NOT_FOUND / NOT_DISCOVERED.
 */
export function reconcileDiscordDiscoveryFromInspection(
  channel: ChannelRecord,
  inspection: {
    discordCandidates?: DiscordCandidate[] | null;
    foundInvite?: string | null;
    steps?: Array<{ status?: string; detectedInvite?: string | null; details?: string | string[] }> | null;
  } | null | undefined,
  options?: { validationProjected?: boolean }
): void {
  const candidates = (inspection?.discordCandidates || []).filter(
    (c): c is DiscordCandidate & { nativeInviteCode: string } => !!c?.nativeInviteCode
  );
  const hasStructured = candidates.length > 0 || !!inspection?.foundInvite;

  const trail = inspection?.steps || channel.inspection_trail || [];
  const trailFound = Array.isArray(trail) && trail.some((step: any) => {
    if (!step || step.status !== 'FOUND') return false;
    if (step.detectedInvite) return true;
    const details = Array.isArray(step.details) ? step.details.join('\n') : String(step.details || '');
    return /discord\.(gg|com\/invite|app\.com\/invite)/i.test(details) || /Invite Code\s*["']?[a-zA-Z0-9_-]+/i.test(details);
  });

  if (!hasStructured && !trailFound) return;

  // A completed negative is authoritative when the inspection found no
  // structured Discord candidate. Text-only trail details must not reopen it
  // as a validation retry; a genuine candidate remains handled below.
  if (!hasStructured && trailFound && channel.discord_status === 'NOT_FOUND' && channel.discord_discovery_status === 'NOT_DISCOVERED' && !channel.discord_candidate_locator) return;

  const isPureAbsence =
    channel.discord_status === 'NOT_FOUND' ||
    channel.discord_discovery_status === 'NOT_DISCOVERED' ||
    channel.discord_discovery_status == null;

  const alreadyValidatedSuccess =
    channel.discord_discovery_status === 'VALIDATED' &&
    (channel.discord_status === 'ACTIVE' || channel.discord_status === 'DEAD');

  if (alreadyValidatedSuccess) return;

  if (isPureAbsence || channel.discord_status === 'PENDING' || !channel.discord_status) channel.discord_status = 'UNCERTAIN';
  if (channel.discord_discovery_status !== 'VALIDATED') channel.discord_discovery_status = 'DISCOVERED_VALIDATION_FAILED';

  if (candidates.length > 0 && !channel.discord_candidate_locator) {
    const primary = candidates[0];
    channel.discord_candidate_locator = primary.normalizedLocator || `https://discord.gg/${primary.nativeInviteCode}`;
    channel.discord_candidate_id = primary.candidateId;
    channel.discord_candidate_raw_locator = primary.rawLocator;
    channel.discord_candidate_type = primary.locatorType;
  }

  if (!options?.validationProjected) {
    if (!channel.discord_validation_status || channel.discord_validation_status === 'NOT_STARTED' || channel.discord_validation_status === 'COMPLETED') channel.discord_validation_status = 'RETRY_PENDING';
    if (!channel.discord_liveness_status || channel.discord_liveness_status === 'NOT_CHECKED') channel.discord_liveness_status = 'UNCERTAIN';
    if (!channel.discord_resolution_status || channel.discord_resolution_status === 'NOT_ATTEMPTED') channel.discord_resolution_status = 'RESOLVED';
  }
}
