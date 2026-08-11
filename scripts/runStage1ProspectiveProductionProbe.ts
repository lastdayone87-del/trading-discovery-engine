import { mkdir, writeFile } from 'node:fs/promises';
import { getChannelById, getCountryVocabularies, getDb } from '../server/db';
import { recordNomination } from '../server/candidateAdmission/store';
import { processDiscoveredChannel } from '../server/queueManager';
import { CREATOR_FOCUS_CLASSIFIER_VERSION, CREATOR_FOCUS_POLICY_VERSION } from '../server/evidenceEngine/classifierV4';
import { EVIDENCE_COVERAGE_POLICY_VERSION } from '../server/evidenceEngine/coverage';
import { searchYouTubeChannels } from '../server/youtube';

const POLICY_KEY = 'stage1-prospective-census';
const CONFIRMATION = 'RUN_STAGE1_PROSPECTIVE_PRODUCTION_PROBE';
const country = String(process.env.STAGE1_PROBE_COUNTRY || 'United States').trim();
const query = String(process.env.STAGE1_PROBE_QUERY || 'futures day trading education').trim();
const confirmation = String(process.env.STAGE1_PROBE_CONFIRMATION || '').trim();
const waitMs = Math.min(120_000, Math.max(10_000, Number(process.env.STAGE1_PROBE_WAIT_MS || 45_000)));

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
if (!country) throw new Error('STAGE1_PROBE_COUNTRY is required.');
if (!query) throw new Error('STAGE1_PROBE_QUERY is required.');
if (confirmation !== CONFIRMATION) throw new Error(`Explicit confirmation ${CONFIRMATION} is required.`);

const db = await getDb();
const vocabularies = await getCountryVocabularies();
const vocabulary = vocabularies.find(item => item.country.toLowerCase() === country.toLowerCase());
if (!vocabulary) throw new Error(`Country '${country}' is not present in the allowed vocabulary database.`);

// Use the same YouTube retrieval adapter as production discovery, but select only
// one channel that has never been materialized in channels. This prevents a
// terminal/stable duplicate from generating another unusable prospective assignment.
const retrieved = await searchYouTubeChannels(query, country, vocabulary, 'VIDEO');
let candidate = null as (typeof retrieved)[number] | null;
for (const raw of retrieved) {
  if (!await getChannelById(raw.channelId)) {
    candidate = raw;
    break;
  }
}
if (!candidate) throw new Error('NO_FRESH_PRODUCTION_PROBE_CANDIDATE');

const observedAt = new Date().toISOString();
const nomination = await recordNomination({
  channelId: candidate.channelId,
  sourceType: 'automated_query',
  sourceActionId: 'stage1-prospective-production-probe',
  query,
  country,
  declaredLanguage: candidate.detectedLanguages?.[0]?.language,
  retrievalLane: 'VIDEO',
  searchOrdering: 'RELEVANCE',
  pageNumber: 1,
  resultRank: retrieved.findIndex(row => row.channelId === candidate!.channelId) + 1,
  matchedDocument: candidate.matchedDocument || { type: 'UNKNOWN' },
  rawObservation: {
    channelName: candidate.channelName,
    youtubeUrl: candidate.youtubeUrl,
    locationTag: candidate.locationTag || null,
    probe: true
  },
  observedAt
}, 'INVESTIGATION_QUEUED');

candidate.nominationId = nomination.id || undefined;
candidate.discoveryJobId = `stage1-probe:${Date.now()}`;
const outcome = await processDiscoveredChannel(candidate, country, 'automated_query');

const deadline = Date.now() + waitMs;
let lineage: any = null;
while (Date.now() <= deadline) {
  const result = await db.query(`
    WITH assignment AS (
      SELECT id,assigned_at,inclusion_basis_points
      FROM evaluation_cohort_assignments
      WHERE channel_id=$1 AND policy_key=$2 AND cohort<>'NOT_SELECTED' AND inclusion_basis_points>0
      ORDER BY assigned_at DESC,id DESC LIMIT 1
    ), diagnostic AS (
      SELECT d.id,d.created_at
      FROM production_classification_diagnostics d, assignment a
      WHERE d.channel_id=$1 AND d.created_at>=a.assigned_at
      ORDER BY d.created_at DESC,d.id DESC LIMIT 1
    )
    SELECT
      a.id AS assignment_id,a.assigned_at,a.inclusion_basis_points,
      d.id AS diagnostic_id,d.created_at AS diagnostic_at,
      f.id AS focus_snapshot_id,e.id AS coverage_snapshot_id,
      l.id AS independent_label_id,l.label AS independent_label
    FROM assignment a
    LEFT JOIN diagnostic d ON true
    LEFT JOIN LATERAL (
      SELECT x.id FROM creator_focus_classification_snapshots x
      WHERE x.classification_diagnostic_id=d.id
        AND x.classifier_version=$3 AND x.policy_version=$4
      ORDER BY x.observed_at DESC,x.id DESC LIMIT 1
    ) f ON true
    LEFT JOIN LATERAL (
      SELECT x.id FROM evidence_coverage_snapshots x
      WHERE x.classification_diagnostic_id=d.id AND x.policy_version=$5
      ORDER BY x.observed_at DESC,x.id DESC LIMIT 1
    ) e ON true
    LEFT JOIN LATERAL (
      SELECT x.id,x.label FROM evaluation_ground_truth_labels x
      WHERE x.channel_id=$1 AND x.provenance IN ('HUMAN_REVIEW','ADJUDICATION')
      ORDER BY x.labeled_at DESC,x.id DESC LIMIT 1
    ) l ON true
  `, [candidate.channelId, POLICY_KEY, CREATOR_FOCUS_CLASSIFIER_VERSION, CREATOR_FOCUS_POLICY_VERSION, EVIDENCE_COVERAGE_POLICY_VERSION]);
  lineage = result.rows[0] || null;
  if (lineage?.assignment_id && lineage?.diagnostic_id && lineage?.focus_snapshot_id && lineage?.coverage_snapshot_id) break;
  await new Promise(resolve => setTimeout(resolve, 750));
}

const readyForIndependentAdjudication = Boolean(
  lineage?.assignment_id &&
  lineage?.diagnostic_id &&
  lineage?.focus_snapshot_id &&
  lineage?.coverage_snapshot_id &&
  !lineage?.independent_label_id
);

const report = {
  reportType: 'STAGE1_PROSPECTIVE_PRODUCTION_PATH_PROBE',
  productionPath: true,
  exactlyOneSelectedCandidate: true,
  servingAuthorityGrantedByProbe: false,
  stage1AuthorityChanged: false,
  query,
  country,
  candidate: {
    channelId: candidate.channelId,
    channelName: candidate.channelName,
    youtubeUrl: candidate.youtubeUrl,
    observedAt
  },
  nomination: {
    id: nomination.id || null,
    ledgerEnabled: nomination.ledgerEnabled,
    created: nomination.created
  },
  outcome: {
    persisted: outcome.persisted,
    wasKnown: outcome.wasKnown,
    countryStatus: outcome.countryStatus,
    tradingStatus: outcome.tradingStatus
  },
  lineage,
  readyForIndependentAdjudication,
  nextAction: readyForIndependentAdjudication
    ? 'HUMAN_INDEPENDENT_ADJUDICATION_REQUIRED'
    : 'INSPECT_PROBE_LINEAGE_BEFORE_ANY_LABEL'
};

await mkdir('stage1-output', { recursive: true });
await writeFile('stage1-output/stage1-prospective-production-path-probe.json', `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
if (!readyForIndependentAdjudication) process.exitCode = 2;
