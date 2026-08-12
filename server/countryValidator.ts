import type { CountryMetadataStatus, CountryStatus } from '../src/types';
import { getExcludedCountries, getCountryVocabularies } from './db';
import { CountryInferenceEvidence, inferChannelCountry } from './countryInference';

export interface ValidationResult {
  score: number;
  status: CountryStatus;
  detectedCountry?: string | null;
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
    aboutBio: `${channelData.description || ''} ${(channelData.socialBios || []).join(' ')}`,
    officialWebsiteLinks: websiteLinks,
    verifiedSocialLinks: socialLinks,
    // Deliberately exclude videoTitles from country attribution. A creator may
    // cover any country's instrument/market, and discovery-selected titles are
    // especially vulnerable to circular query evidence.
    videoTitles: [] as string[]
  };
}

/**
 * Compatibility adapter for existing pipeline callers. All inference and
 * precedence decisions live in the dedicated countryInference module.
 */
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
  targetCountryName: string
): Promise<ValidationResult> {
  const [excludedCountries, vocabularies] = await Promise.all([
    getExcludedCountries(),
    getCountryVocabularies()
  ]);

  const inference = inferChannelCountry({
    ...creatorLevelCountryEvidence(channelData),
    discoveryCountry: targetCountryName
  }, excludedCountries, vocabularies);

  const evidenceLines = inference.evidence.map(item =>
    `  [P${item.priority}] ${item.source}: ${item.detectedCountry} (${item.confidence}/100) — ${item.reasoning}`
  );
  const decisionLogs = [
    `Official Metadata: ${channelData.metadataStatus === 'UNAVAILABLE' ? 'Unavailable (provider/configuration failure)' : channelData.metadataStatus === 'AVAILABLE_NOT_DECLARED' ? 'Available; channel declared no country' : channelData.metadataStatus === 'AVAILABLE_DECLARED' ? 'Available with declared country' : 'Not requested'}`,
    `Detected Country: ${inference.detectedCountry || 'Unknown'}`,
    `Calculated Score: ${inference.confidence}/100 (Status: ${inference.status})`,
    `Decision Basis: ${inference.reasoning}`,
    'Ordered Evidence:',
    ...(evidenceLines.length ? evidenceLines : ['  No country evidence found.'])
  ].join('\n');

  return {
    score: inference.confidence,
    status: inference.status,
    detectedCountry: inference.detectedCountry,
    rejectionReason: inference.rejectionReason,
    decisionLogs,
    evidence: inference.evidence
  };
}
