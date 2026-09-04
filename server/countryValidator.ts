import type { CountryMetadataStatus, CountryStatus } from '../src/types';
import { getExcludedCountries, getCountryVocabularies } from './db';
import {
  assessChannelCountry,
  canonicalCountry,
  CountryAssessment,
  CountryEvidenceAvailability,
  CountryInferenceEvidence,
  GateDisposition
} from './countryInference';

export interface ValidationResult {
  score: number;
  status: CountryStatus;
  detectedCountry?: string | null; // Backwards compatibility alias for detectedCreatorCountry
  detectedCreatorCountry?: string | null;
  discoveryCountry?: string | null;
  evidenceAvailability?: CountryEvidenceAvailability;
  gateDisposition?: GateDisposition;
  rejectionReason?: string;
  decisionLogs: string;
  evidence?: CountryInferenceEvidence[];
}

/**
 * Creator-country attribution must be based on creator-level evidence. Search
 * result titles are retrieval-selected documents: they may contain the exact
 * country/instrument term that caused the channel to be nominated and therefore
 * cannot independently prove where the creator is based.
 */
export function creatorLevelCountryEvidence(channelData: {
  channelName: string;
  description: string;
  videoTitles?: string[];
  locationTag?: string;
  externalLinks?: string[];
  socialBios?: string[];
  metadataStatus?: CountryMetadataStatus;
}) {
  const socialLinks = (channelData.externalLinks || []).filter(link =>
    /(?:instagram|twitter|x|facebook|linkedin|tiktok)\.com/i.test(link)
  );
  const websiteLinks = (channelData.externalLinks || []).filter(link => !socialLinks.includes(link));
  return {
    officialCountry: channelData.locationTag,
    channelName: channelData.channelName,
    // Provenance boundary: description and socialBios stay separate fields so
    // P2 evidence records exactly which one produced it. Crawler trail prose,
    // video metadata, and discovery context must never be passed here.
    aboutBio: channelData.description || '',
    socialBios: channelData.socialBios || [],
    officialWebsiteLinks: websiteLinks,
    verifiedSocialLinks: socialLinks,
    // Deliberately exclude videoTitles from country attribution. A creator may
    // cover any country's instrument/market, and discovery-selected titles are
    // especially vulnerable to circular query evidence.
    videoTitles: [] as string[]
  };
}

/**
 * Reconstructs creator evidence from stored channel records without treating
 * inspection trail prose, channel names, or search query titles as About text or location tags.
 */
export function retainedCreatorEvidenceInput(channel: {
  channel_name?: string;
  country_metadata_status?: CountryMetadataStatus;
  discord_invite?: string | null;
  inspection_trail?: Array<{ step?: string; details?: string }>;
}) {
  const externalLinks: string[] = channel.discord_invite ? [channel.discord_invite] : [];
  return creatorLevelCountryEvidence({
    channelName: '',
    description: '',
    locationTag: undefined,
    videoTitles: [],
    externalLinks,
    metadataStatus: channel.country_metadata_status
  });
}

/**
 * Compatibility adapter for existing pipeline callers. All inference and
 * precedence decisions live in the dedicated countryInference module.
 *
 * A pinned-country mismatch is a hard rejection only when creator-country
 * attribution itself is confirmed. UNCERTAIN/LIKELY results remain unresolved:
 * a best-current detected country is not sufficient evidence for exclusion.
 */
export function mergeCountryValidationResults(initial: ValidationResult, live: ValidationResult): ValidationResult {
  const initialEvidence = initial.evidence || [];
  const liveEvidence = live.evidence || [];
  const initialPriority = initialEvidence.length ? Math.min(...initialEvidence.map(item => item.priority)) : Number.POSITIVE_INFINITY;
  const livePriority = liveEvidence.length ? Math.min(...liveEvidence.map(item => item.priority)) : Number.POSITIVE_INFINITY;

  // A later live fetch may add stronger official evidence, but it may not
  // replace an earlier creator-level conflict/decision with weaker indirect
  // evidence. Equal-priority competing evidence remains unresolved.
  if (initial.status === 'UNCERTAIN' && live.status === 'REJECTED' && livePriority > initialPriority) return initial;
  if (initial.status === 'UNCERTAIN' && livePriority >= initialPriority) return initial;
  if (initial.status !== 'UNCERTAIN' && livePriority > initialPriority) return initial;
  const initialCreator = initial.detectedCreatorCountry ?? initial.detectedCountry;
  const liveCreator = live.detectedCreatorCountry ?? live.detectedCountry;
  if (initial.status === 'UNCERTAIN' && livePriority === initialPriority && liveCreator !== initialCreator) return {
    ...initial,
    status: 'UNCERTAIN',
    detectedCountry: null,
    detectedCreatorCountry: null,
    score: Math.min(49, Math.max(initial.score, live.score)),
    decisionLogs: `${initial.decisionLogs}\nLive revalidation preserved uncertainty because evidence remained conflicting at the same priority.`,
    evidence: [...initialEvidence, ...liveEvidence]
  };
  return live;
}

export function applyTargetCountryBoundary(result: ValidationResult, targetCountryName?: string | null): ValidationResult {
  // Hard invariant: a target-country mismatch can NEVER change a non-rejected
  // country result into REJECTED. Rejection occurs ONLY if the detected creator
  // country is explicitly present in excluded_countries (which produces
  // result.status === 'REJECTED' before this boundary function is called).
  if (result.status === 'REJECTED') return result;

  const cleanTargetName = targetCountryName || '';
  const target = canonicalCountry(cleanTargetName);
  const rawCreator = result.detectedCreatorCountry ?? result.detectedCountry;
  const detected = rawCreator ? canonicalCountry(rawCreator) : null;
  const globalContext = !cleanTargetName.trim() || ['GLOBAL', 'ALL', '*', 'WORLDWIDE'].includes(target.toLocaleUpperCase('en'));

  if (globalContext || !detected || detected === target) return result;

  const reason = `Creator country ${detected} differs from pinned discovery country ${target}; retained for normal processing because creator country ${detected} is not itself excluded.`;
  return {
    ...result,
    decisionLogs: `${result.decisionLogs}\nTarget Country Boundary: RETAINED — ${reason}`
  };
}

export async function validateChannelCountry(
  channelData: {
    channelName: string;
    description: string;
    videoTitles?: string[];
    locationTag?: string;
    externalLinks?: string[];
    socialBios?: string[];
    metadataStatus?: CountryMetadataStatus;
  },
  targetCountryName?: string | null
): Promise<ValidationResult> {
  const [excludedCountries, vocabularies] = await Promise.all([
    getExcludedCountries(),
    getCountryVocabularies()
  ]);

  const assessment = assessChannelCountry({
    ...creatorLevelCountryEvidence(channelData),
    discoveryCountry: targetCountryName,
    metadataStatus: channelData.metadataStatus
  }, excludedCountries, vocabularies);

  const evidenceLines = assessment.countryEvidence.map(item =>
    `  [P${item.priority}] ${item.source}: ${item.detectedCountry} (${item.confidence}/100) — ${item.reasoning}`
  );
  const decisionLogs = [
    `Official Metadata: ${channelData.metadataStatus === 'UNAVAILABLE' ? 'Unavailable (provider/configuration failure)' : channelData.metadataStatus === 'AVAILABLE_NOT_DECLARED' ? 'Available; channel declared no country' : channelData.metadataStatus === 'AVAILABLE_DECLARED' ? 'Available with declared country' : 'Not requested'}`,
    `Discovery Country: ${assessment.discoveryCountry || 'None'}`,
    `Detected Creator Country: ${assessment.detectedCreatorCountry || 'Unknown'}`,
    `Calculated Score: ${assessment.confidence}/100 (Status: ${assessment.countryStatus}, Gate Disposition: ${assessment.gateDisposition})`,
    `Decision Basis: ${assessment.reasoning}`,
    'Ordered Evidence:',
    ...(evidenceLines.length ? evidenceLines : ['  No country evidence found.'])
  ].join('\n');

  return applyTargetCountryBoundary({
    score: assessment.confidence,
    status: assessment.countryStatus,
    detectedCountry: assessment.detectedCreatorCountry,
    detectedCreatorCountry: assessment.detectedCreatorCountry,
    discoveryCountry: assessment.discoveryCountry,
    evidenceAvailability: assessment.evidenceAvailability,
    gateDisposition: assessment.gateDisposition,
    rejectionReason: assessment.rejectionReason,
    decisionLogs,
    evidence: assessment.countryEvidence
  }, targetCountryName);
}
