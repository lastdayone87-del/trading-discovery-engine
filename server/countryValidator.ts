import type { CountryStatus } from '../src/types';
import type { CountryMetadataStatus } from '../src/types';
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

  const socialLinks = (channelData.externalLinks || []).filter(link =>
    /(?:instagram|twitter|x|facebook|linkedin|tiktok)\.com/i.test(link)
  );
  const websiteLinks = (channelData.externalLinks || []).filter(link => !socialLinks.includes(link));
  const inference = inferChannelCountry({
    officialCountry: channelData.locationTag,
    channelName: channelData.channelName,
    aboutBio: `${channelData.description || ''} ${(channelData.socialBios || []).join(' ')}`,
    officialWebsiteLinks: websiteLinks,
    verifiedSocialLinks: socialLinks,
    videoTitles: channelData.videoTitles,
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
