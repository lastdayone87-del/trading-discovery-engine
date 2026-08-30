import { getAllChannels, getExcludedCountries, getCountryVocabularies, getDb } from '../server/db';
import { creatorLevelCountryEvidence } from '../server/countryValidator';
import { assessChannelCountry, GateDisposition } from '../server/countryInference';
import type { CountryStatus } from '../src/types';

export interface DryRunReport {
  timestamp: string;
  totalChannelsAudited: number;
  dispositionBreakdown: Record<GateDisposition, number>;
  statusBreakdown: Record<CountryStatus, number>;
  creatorCountryCounts: Record<string, number>;
  discoveryCountryCounts: Record<string, number>;
  unknownCreatorCount: number;
  unavailableDiscoveryContextCount: number;
  sampleClassifications: Array<{
    channelId: string;
    channelName: string;
    discoveryCountry: string | null;
    detectedCreatorCountry: string | null;
    countryStatus: CountryStatus;
    gateDisposition: GateDisposition;
    reasoning: string;
  }>;
  databaseMutationsExecuted: number;
}

export async function runCountryAttributionDryRun(): Promise<DryRunReport> {
  // DB connection failures MUST be fatal — do NOT swallow errors with .catch(() => [])
  const db = await getDb();
  const [channels, excludedCountries, vocabularies] = await Promise.all([
    getAllChannels(),
    getExcludedCountries(),
    getCountryVocabularies()
  ]);

  // Load actual persisted retrieval/sighting provenance (targetCountry from channel_sightings or nominations)
  const sightingsRes = await db.query(`
    SELECT DISTINCT ON (channel_id)
      channel_id,
      metadata->>'targetCountry' AS target_country
    FROM channel_sightings
    WHERE metadata->>'targetCountry' IS NOT NULL
    ORDER BY channel_id, observed_at DESC
  `);

  const discoveryCountryMap = new Map<string, string>();
  for (const row of sightingsRes.rows) {
    if (row.target_country) {
      discoveryCountryMap.set(row.channel_id, row.target_country);
    }
  }

  const dispositionBreakdown: Record<GateDisposition, number> = {
    ALLOW_NORMAL: 0,
    CONTINUE_CRAWLING: 0,
    NEEDS_REVIEW: 0,
    REJECT_EXCLUDED: 0
  };

  const statusBreakdown: Record<CountryStatus, number> = {
    CONFIRMED: 0,
    LIKELY: 0,
    UNCERTAIN: 0,
    REJECTED: 0
  };

  const creatorCountryCounts: Record<string, number> = {};
  const discoveryCountryCounts: Record<string, number> = {};
  let unknownCreatorCount = 0;
  let unavailableDiscoveryContextCount = 0;
  const sampleClassifications: DryRunReport['sampleClassifications'] = [];

  for (const channel of channels) {
    const discoveryCountry = discoveryCountryMap.get(channel.channel_id) || null;
    if (!discoveryCountry) {
      unavailableDiscoveryContextCount++;
    }

    const creatorEvidence = creatorLevelCountryEvidence({
      channelName: channel.channel_name,
      description: (channel.inspection_trail || [])
        .filter(t => t.step !== 'COUNTRY_VALIDATION')
        .map(t => t.details || '')
        .join(' ') || channel.channel_name,
      videoTitles: [channel.channel_name],
      externalLinks: channel.discord_invite ? [channel.discord_invite] : [],
      metadataStatus: channel.country_metadata_status
    });

    const assessment = assessChannelCountry({
      ...creatorEvidence,
      discoveryCountry: discoveryCountry || undefined
    }, excludedCountries, vocabularies);

    dispositionBreakdown[assessment.gateDisposition] = (dispositionBreakdown[assessment.gateDisposition] || 0) + 1;
    statusBreakdown[assessment.countryStatus] = (statusBreakdown[assessment.countryStatus] || 0) + 1;

    if (discoveryCountry) {
      discoveryCountryCounts[discoveryCountry] = (discoveryCountryCounts[discoveryCountry] || 0) + 1;
    }

    if (assessment.detectedCreatorCountry) {
      creatorCountryCounts[assessment.detectedCreatorCountry] = (creatorCountryCounts[assessment.detectedCreatorCountry] || 0) + 1;
    } else {
      unknownCreatorCount++;
    }

    if (sampleClassifications.length < 10) {
      sampleClassifications.push({
        channelId: channel.channel_id,
        channelName: channel.channel_name,
        discoveryCountry,
        detectedCreatorCountry: assessment.detectedCreatorCountry,
        countryStatus: assessment.countryStatus,
        gateDisposition: assessment.gateDisposition,
        reasoning: assessment.reasoning
      });
    }
  }

  return {
    timestamp: new Date().toISOString(),
    totalChannelsAudited: channels.length,
    dispositionBreakdown,
    statusBreakdown,
    creatorCountryCounts,
    discoveryCountryCounts,
    unknownCreatorCount,
    unavailableDiscoveryContextCount,
    sampleClassifications,
    databaseMutationsExecuted: 0
  };
}

// Execute dry-run if invoked directly
if (process.argv[1]?.endsWith('dryRunCountryAttribution.ts') || process.argv[1]?.endsWith('dryRunCountryAttribution.js')) {
  runCountryAttributionDryRun()
    .then(report => {
      console.log('--- Production Country Attribution Dry-Run Report ---');
      console.log(JSON.stringify(report, null, 2));
      process.exit(0);
    })
    .catch(err => {
      console.error('Dry-run failed:', err);
      process.exit(1);
    });
}
