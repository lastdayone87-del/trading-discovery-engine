import { getAllChannels, getExcludedCountries, getCountryVocabularies, getDb, enqueueJob, getChannelById } from './db';
import { canonicalCountry, inferChannelCountry } from './countryInference';
import { creatorLevelCountryEvidence } from './countryValidator';
import type { ChannelRecord, CountryVocabulary, ExcludedCountry } from '../src/types';

export const COUNTRY_BOUNDARY_RECOVERY_VERSION = 'country-boundary-nonexcluded-v4';
export const COUNTRY_BOUNDARY_RECOVERY_JOB = 'COUNTRY_BOUNDARY_REPROCESS';

export type ReconciliationState =
  | 'RECOVERABLE_NON_EXCLUDED'
  | 'RETAIN_EXCLUDED'
  | 'INSUFFICIENT_EVIDENCE'
  | 'LEGITIMATE_REJECTION';
