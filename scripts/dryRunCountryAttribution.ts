import { getAllChannels, getExcludedCountries, getCountryVocabularies, getDb } from '../server/db';
import { creatorLevelCountryEvidence } from '../server/countryValidator';
import { assessChannelCountry, GateDisposition } from '../server/countryInference';
import type { CountryStatus } from '../src/types';

type Db = Awaited<ReturnType<typeof getDb>>;
type Channel = Awaited<ReturnType<typeof getAllChannels>>[number];

export interface CandidateClassification {
  channelId: string;
  channelName: string;
  persistedCountry: string | null;
  persistedStatus: string | null;
  persistedConfidence: number | null;
  discoveryCountry: string | null;
  detectedCreatorCountry: null;
  countryStatus: 'UNCERTAIN';
  gateDisposition: 'CONTINUE_CRAWLING';
  classification: 'NOT DETERMINABLE FROM RETAINED PRODUCTION EVIDENCE';
  reason: string;
}

export interface DryRunReport {
  timestamp: string;
  productionReadOnly: true;
  totalChannelsAudited: number;
  dispositionBreakdown: Record<GateDisposition, number>;
  statusBreakdown: Record<CountryStatus, number>;
  creatorCountryCounts: Record<string, number>;
  discoveryCountryCounts: Record<string, number>;
  unknownCreatorCount: number;
  unavailableDiscoveryContextCount: number;
  evidenceSourceBreakdown: Record<string, number>;
  creatorDiscoveryDisagreement: {
    channelsWithDifferentStoredAndDiscoveryCountry: number;
    rowsWithDiscoveryContextAndUnknownCreatorCountry: number;
    note: string;
  };
  excludedCountryBreakdown: Array<{
    excludedCountry: string;
    candidateChannels: number;
    confirmedCreatorEvidence: number | null;
    discoveryOnlyCases: number | null;
    uncertainCases: number | null;
    gate1Rejected: number | null;
    gate1Passed: number | null;
    potentialFalseNegatives: number | null;
    classification: string;
  }>;
  previouslyIdentified57: {
    count: number;
    classifications: CandidateClassification[];
    limitation: string;
  };
  candidatePopulation2517: {
    identifiedCount: number;
    dispositionChangeCount: number | null;
    concreteCountryValuesBecomingNull: number;
    limitation: string;
  };
  dataQualityLimitations: string[];
  sampleClassifications: CandidateClassification[];
  databaseMutationsExecuted: 0;
}

/** Only empty, structured creator evidence is used when no raw creator payload is retained. */
export function retainedCreatorEvidenceInput(channel: Channel): Parameters<typeof creatorLevelCountryEvidence>[0] {
  return {
    channelName: '',
    description: '',
    videoTitles: [],
    locationTag: undefined,
    externalLinks: [],
    socialBios: [],
    metadataStatus: channel.country_metadata_status
  };
}

function bump(map: Record<string, number>, key: string | null | undefined): void {
  if (key) map[key] = (map[key] || 0) + 1;
}

function numberValue(value: unknown): number {
  return typeof value === 'number' ? value : Number(value || 0);
}

async function queryDiscoveryMap(db: Db): Promise<Map<string, string>> {
  const result = await db.query(`
    SELECT DISTINCT ON (channel_id)
      channel_id, metadata->>'targetCountry' AS target_country
    FROM channel_sightings
    WHERE metadata->>'targetCountry' IS NOT NULL
    ORDER BY channel_id, observed_at DESC
  `);
  const map = new Map<string, string>();
  for (const row of result.rows) if (row.target_country) map.set(row.channel_id, row.target_country);
  return map;
}

async function queryCountryBreakdown(db: Db): Promise<DryRunReport['excludedCountryBreakdown']> {
  const result = await db.query(`
    WITH target AS (
      SELECT DISTINCT ON (channel_id) channel_id, metadata->>'targetCountry' AS discovery_country
      FROM channel_sightings
      WHERE metadata->>'targetCountry' IS NOT NULL
      ORDER BY channel_id, observed_at DESC
    )
    SELECT e.country_name AS excluded_country,
      COUNT(DISTINCT c.channel_id) FILTER (WHERE lower(trim(t.discovery_country)) = lower(trim(e.country_name))) AS candidate_channels
    FROM excluded_countries e
    LEFT JOIN target t ON lower(trim(t.discovery_country)) = lower(trim(e.country_name))
    LEFT JOIN channels c ON c.channel_id = t.channel_id
    GROUP BY e.country_name ORDER BY e.country_name
  `);
  return result.rows.map(row => ({
    excludedCountry: row.excluded_country,
    candidateChannels: numberValue(row.candidate_channels),
    confirmedCreatorEvidence: null,
    discoveryOnlyCases: null,
    uncertainCases: null,
    gate1Rejected: null,
    gate1Passed: null,
    potentialFalseNegatives: null,
    classification: 'NOT DETERMINABLE FROM RETAINED PRODUCTION EVIDENCE'
  }));
}

async function queryPreviouslyIdentified57(db: Db, discoveryMap: Map<string, string>): Promise<CandidateClassification[]> {
  const result = await db.query(`
    SELECT DISTINCT c.channel_id, c.channel_name, c.country, c.country_status, c.confidence_score
    FROM excluded_countries e
    JOIN channels c
      ON c.country_status = 'UNCERTAIN'
     AND c.confidence_score < 60
     AND c.country IS NOT NULL
     AND lower(trim(c.country)) <> lower(trim(e.country_name))
     AND c.inspection_trail::text ILIKE '%' || e.country_name || '%'
     AND (
       c.inspection_trail::text ILIKE '%CHANNEL_ABOUT_BIO%'
       OR c.inspection_trail::text ILIKE '%OFFICIAL_YOUTUBE_METADATA%'
       OR c.inspection_trail::text ILIKE '%OFFICIAL_WEBSITE_DOMAIN%'
       OR c.inspection_trail::text ILIKE '%VERIFIED_SOCIAL_LINK%'
     )
    ORDER BY c.channel_id
  `);
  return result.rows.map(row => ({
    channelId: row.channel_id,
    channelName: row.channel_name,
    persistedCountry: row.country || null,
    persistedStatus: row.country_status || null,
    persistedConfidence: row.confidence_score == null ? null : Number(row.confidence_score),
    discoveryCountry: discoveryMap.get(row.channel_id) || null,
    detectedCreatorCountry: null,
    countryStatus: 'UNCERTAIN',
    gateDisposition: 'CONTINUE_CRAWLING',
    classification: 'NOT DETERMINABLE FROM RETAINED PRODUCTION EVIDENCE',
    reason: 'The qualifying inspection-trail marker is untrusted prose; no structured creator-level evidence payload is retained.'
  }));
}

async function query2517Candidates(db: Db): Promise<{ count: number; concreteCountryValues: number }> {
  const result = await db.query(`
    WITH target AS (
      SELECT DISTINCT channel_id, lower(trim(metadata->>'targetCountry')) AS discovery_country
      FROM channel_sightings WHERE metadata->>'targetCountry' IS NOT NULL
    )
    SELECT COUNT(DISTINCT c.channel_id)::int AS count,
      COUNT(DISTINCT c.channel_id) FILTER (WHERE c.country IS NOT NULL)::int AS concrete_country_values
    FROM channels c JOIN target t ON t.channel_id = c.channel_id
    WHERE c.country_status = 'UNCERTAIN'
      AND c.confidence_score < 60
      AND lower(trim(c.country)) = t.discovery_country
  `);
  return {
    count: numberValue(result.rows[0]?.count),
    concreteCountryValues: numberValue(result.rows[0]?.concrete_country_values)
  };
}

async function queryDisagreements(db: Db): Promise<DryRunReport['creatorDiscoveryDisagreement']> {
  const result = await db.query(`
    WITH target AS (
      SELECT DISTINCT ON (channel_id) channel_id, metadata->>'targetCountry' AS discovery_country
      FROM channel_sightings WHERE metadata->>'targetCountry' IS NOT NULL
      ORDER BY channel_id, observed_at DESC
    )
    SELECT
      COUNT(*) FILTER (WHERE c.country IS NOT NULL AND lower(trim(c.country)) <> lower(trim(t.discovery_country)))::int AS different_stored_and_discovery,
      COUNT(*) FILTER (WHERE t.discovery_country IS NOT NULL)::int AS discovery_rows
    FROM channels c LEFT JOIN target t ON t.channel_id = c.channel_id
  `);
  return {
    channelsWithDifferentStoredAndDiscoveryCountry: numberValue(result.rows[0]?.different_stored_and_discovery),
    rowsWithDiscoveryContextAndUnknownCreatorCountry: numberValue(result.rows[0]?.discovery_rows),
    note: 'Creator-country attribution is null in this audit because no structured retained creator-evidence payload is available. channels.country is not treated as creator evidence.'
  };
}

export async function runCountryAttributionDryRun(): Promise<DryRunReport> {
  const db = await getDb();
  const [channels, excludedCountries, vocabularies, discoveryMap] = await Promise.all([
    getAllChannels(), getExcludedCountries(), getCountryVocabularies(), queryDiscoveryMap(db)
  ]);
  if (!Array.isArray(channels) || !Array.isArray(excludedCountries) || !Array.isArray(vocabularies)) {
    throw new Error('Required production query returned incomplete data; refusing to report a clean result.');
  }

  const dispositionBreakdown: Record<GateDisposition, number> = { ALLOW_NORMAL: 0, CONTINUE_CRAWLING: 0, NEEDS_REVIEW: 0, REJECT_EXCLUDED: 0 };
  const statusBreakdown: Record<CountryStatus, number> = { CONFIRMED: 0, LIKELY: 0, UNCERTAIN: 0, REJECTED: 0 };
  const creatorCountryCounts: Record<string, number> = {};
  const discoveryCountryCounts: Record<string, number> = {};
  const samples: CandidateClassification[] = [];
  let unknownCreatorCount = 0;
  let unavailableDiscoveryContextCount = 0;

  for (const channel of channels) {
    const discoveryCountry = discoveryMap.get(channel.channel_id) || null;
    if (discoveryCountry) bump(discoveryCountryCounts, discoveryCountry); else unavailableDiscoveryContextCount++;
    const evidence = creatorLevelCountryEvidence(retainedCreatorEvidenceInput(channel));
    // Discovery context is intentionally not passed to assessment: it is provenance, not creator evidence.
    const assessment = assessChannelCountry({ ...evidence }, excludedCountries, vocabularies);
    dispositionBreakdown[assessment.gateDisposition]++;
    statusBreakdown[assessment.countryStatus]++;
    if (assessment.detectedCreatorCountry) bump(creatorCountryCounts, assessment.detectedCreatorCountry); else unknownCreatorCount++;
    if (samples.length < 10) samples.push({
      channelId: channel.channel_id,
      channelName: channel.channel_name,
      persistedCountry: channel.country || null,
      persistedStatus: channel.country_status || null,
      persistedConfidence: channel.confidence_score == null ? null : Number(channel.confidence_score),
      discoveryCountry,
      detectedCreatorCountry: null,
      countryStatus: 'UNCERTAIN',
      gateDisposition: 'CONTINUE_CRAWLING',
      classification: 'NOT DETERMINABLE FROM RETAINED PRODUCTION EVIDENCE',
      reason: 'No structured creator-level evidence was retained for this dry-run input.'
    });
  }

  const [excludedCountryBreakdown, previouslyIdentified57, candidatePopulation2517, disagreement] = await Promise.all([
    queryCountryBreakdown(db), queryPreviouslyIdentified57(db, discoveryMap), query2517Candidates(db), queryDisagreements(db)
  ]);
  return {
    timestamp: new Date().toISOString(),
    productionReadOnly: true,
    totalChannelsAudited: channels.length,
    dispositionBreakdown,
    statusBreakdown,
    creatorCountryCounts,
    discoveryCountryCounts,
    unknownCreatorCount,
    unavailableDiscoveryContextCount,
    evidenceSourceBreakdown: {
      NONE_RETAINED_CREATOR_EVIDENCE: channels.length,
      INSPECTION_TRAIL_PROSE_EXCLUDED: channels.filter(c => Array.isArray(c.inspection_trail) && c.inspection_trail.length > 0).length,
      PERSISTED_CHANNEL_COUNTRY_EXCLUDED_AS_EVIDENCE: channels.filter(c => Boolean(c.country)).length
    },
    creatorDiscoveryDisagreement: disagreement,
    excludedCountryBreakdown,
    previouslyIdentified57: {
      count: previouslyIdentified57.length,
      classifications: previouslyIdentified57,
      limitation: 'NOT DETERMINABLE FROM RETAINED PRODUCTION EVIDENCE'
    },
    candidatePopulation2517: {
      identifiedCount: candidatePopulation2517.count,
      dispositionChangeCount: null,
      concreteCountryValuesBecomingNull: candidatePopulation2517.concreteCountryValues,
      limitation: 'Exact disposition changes are NOT DETERMINABLE FROM RETAINED PRODUCTION EVIDENCE because prior operational disposition and authoritative creator evidence are not retained together.'
    },
    dataQualityLimitations: [
      'Inspection-trail prose is excluded as creator evidence.',
      'Persisted channels.country is excluded as creator evidence.',
      'Video titles, query terms, retrieval keywords, and channel names are not passed to inference.',
      'Raw structured About/provider evidence is not retained for every production channel.',
      'Discovery provenance is counted only from channel_sightings.metadata->>targetCountry.',
      'The 2,517 population is a persisted-country/target equality cohort, not a confirmed false-negative population.'
    ],
    sampleClassifications: samples,
    databaseMutationsExecuted: 0
  };
}

if (process.argv[1]?.endsWith('dryRunCountryAttribution.ts') || process.argv[1]?.endsWith('dryRunCountryAttribution.js')) {
  runCountryAttributionDryRun()
    .then(report => { console.log('--- Production Country Attribution Dry-Run Report ---'); console.log(JSON.stringify(report, null, 2)); })
    .catch(error => { console.error('Dry-run failed:', error); process.exitCode = 1; });
}
