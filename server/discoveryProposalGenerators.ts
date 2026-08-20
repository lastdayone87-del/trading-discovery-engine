import { createHash } from 'node:crypto';
import { getDb } from './db';
import { buildDiscoveryNeighborhood, createNeighborhoodChecksum, type DiscoveryNeighborhoodDimensions } from './discoveryNeighborhood';
import { canonicalCountry, countryIsoAlias } from './countryInference';
import { computeEvidenceChecksum } from './countryNativeIntelligence';
import { QUALITY_CREATOR_SCORE_THRESHOLD } from './queryPerformance';

export type ProposalFamily =
  | 'LEARNED'
  | 'CREATOR_DERIVED'
  | 'CREATOR_NEIGHBORHOOD'
  | 'PLAYLIST_TOPIC'
  | 'COUNTRY_NATIVE'
  | 'COVERAGE_GAP'
  | 'TEMPORAL';

export type ProposalTrialStatus = 'PENDING' | 'TRIED' | 'EXPIRED' | 'DISABLED';

export interface DiscoveryFrontierProposal {
  proposalId?: string;
  dedupKey: string;
  proposalFamily: ProposalFamily;
  country: string;
  language: string | null;
  concept: string;
  targetNeighborhoodKey: string | null;
  targetDimensions: DiscoveryNeighborhoodDimensions;
  sourceProvenance: string;
  supportingEvidence: Record<string, unknown>;
  confidence: number;
  noveltyRationale: string;
  trialStatus: ProposalTrialStatus;
  expiresAt: string | null;
  createdAt?: string;
}

export interface ProposalGenerationConfig {
  globalCap?: number;
  perFamilyCap?: number;
  defaultTtlDays?: number;
}

/**
 * Creates a deterministic deduplication key for a frontier proposal hypothesis.
 */
export function createProposalDedupKey(
  proposalFamily: ProposalFamily,
  country: string,
  concept: string,
  targetNeighborhoodKey?: string | null
): string {
  const normFamily = proposalFamily.toUpperCase().trim();
  const normCountry = country.toUpperCase().trim();
  const normConcept = concept.normalize('NFKC').trim().toLowerCase();
  const normNeighborhood = (targetNeighborhoodKey || 'none').trim().toLowerCase();
  const raw = `${normFamily}|${normCountry}|${normConcept}|${normNeighborhood}`;
  return createHash('sha256').update(raw).digest('hex');
}

export function countryNativeEvidenceChecksum(evidence: Record<string, unknown>): string {
  const { evidenceChecksum: _previousChecksum, evidenceVersion: _previousVersion, ...mutableEvidence } = evidence;
  return computeEvidenceChecksum(mutableEvidence);
}

export function countryNativeEvidenceVersion(evidence: Record<string, unknown>, checksum: string): string {
  const observedAt = typeof evidence.lastObservedAt === 'string' && !Number.isNaN(Date.parse(evidence.lastObservedAt))
    ? new Date(evidence.lastObservedAt).toISOString()
    : '1970-01-01T00:00:00.000Z';
  const revision = String(evidence.evidenceRevision || '0').padStart(20, '0');
  return `${observedAt}|${revision}|${checksum}`;
}

export function effectiveProjectionProposalEvidence(row: {
  native_evidence_status: string;
  source_provenance_family: string;
  source_provenance_families?: string[];
  bootstrap_seed_count?: number | string;
  quality_creator_count?: number | string;
  native_quality_creator_count?: number | string;
  structured_entity_matched?: boolean;
}): { nativeEvidenceStatus: string; sourceProvenanceFamily: string; nativeGateSatisfied: boolean } {
  const nativeGateSatisfied = row.native_evidence_status === 'NATIVE_OBSERVED' &&
    (Number(row.native_quality_creator_count) >= 2 || Boolean(row.structured_entity_matched));
  const families = row.source_provenance_families || [];
  return {
    nativeGateSatisfied,
    nativeEvidenceStatus: nativeGateSatisfied ? row.native_evidence_status
      : Number(row.bootstrap_seed_count) > 0 ? 'BOOTSTRAP_SEED' : row.native_evidence_status,
    sourceProvenanceFamily: nativeGateSatisfied ? row.source_provenance_family
      : families.includes('COUNTRY_VOCABULARY') ? 'COUNTRY_VOCABULARY'
        : Number(row.bootstrap_seed_count) > 0 ? 'STATIC_BOOTSTRAP' : row.source_provenance_family
  };
}

/**
 * Constructs a candidate proposal object with deterministic dedup key and neighborhood.
 */
export function buildFrontierProposal(params: {
  proposalFamily: ProposalFamily;
  country: string;
  language?: string | null;
  concept: string;
  intent?: string;
  primaryTermFamily?: string;
  retrievalLane?: string;
  searchOrdering?: string;
  instrumentOrTheme?: string | null;
  sourceFamily?: string;
  sourceProvenance: string;
  supportingEvidence?: Record<string, unknown>;
  confidence?: number;
  noveltyRationale: string;
  ttlDays?: number;
  preserveCountryIdentity?: boolean;
}): DiscoveryFrontierProposal {
  const dimensions: DiscoveryNeighborhoodDimensions = {
    country: params.country,
    language: params.language || null,
    queryIntent: params.intent || 'GENERAL',
    primaryTermFamily: params.primaryTermFamily || params.concept,
    retrievalLane: params.retrievalLane || 'ORGANIC',
    searchOrdering: params.searchOrdering || 'RELEVANCE',
    instrumentOrTheme: params.instrumentOrTheme || null,
    sourceFamily: params.sourceFamily || 'frontier_proposal'
  };

  const neighborhood = buildDiscoveryNeighborhood(dimensions);
  const dedupKey = createProposalDedupKey(params.proposalFamily, params.country, params.concept, neighborhood.neighborhoodKey);

  const ttl = params.ttlDays ?? 14;
  const expiresAt = new Date(Date.now() + ttl * 86_400_000).toISOString();

  const supportingEvidence = params.supportingEvidence || {};
  const evidenceChecksum = countryNativeEvidenceChecksum(supportingEvidence);
  const versionedEvidence = params.proposalFamily === 'COUNTRY_NATIVE'
    ? { ...supportingEvidence, evidenceChecksum, evidenceVersion: countryNativeEvidenceVersion(supportingEvidence, evidenceChecksum) }
    : supportingEvidence;
  return {
    dedupKey,
    proposalFamily: params.proposalFamily,
    country: params.preserveCountryIdentity ? canonicalCountry(params.country) : params.country.toUpperCase().trim(),
    language: params.language ? params.language.trim() : null,
    concept: params.concept.trim(),
    targetNeighborhoodKey: neighborhood.neighborhoodKey,
    targetDimensions: neighborhood.dimensions,
    sourceProvenance: params.sourceProvenance,
    supportingEvidence: versionedEvidence,
    confidence: Math.max(0.0, Math.min(1.0, params.confidence ?? 0.5)),
    noveltyRationale: params.noveltyRationale,
    trialStatus: 'PENDING',
    expiresAt
  };
}

// 1. LEARNED / PROVEN Generator
export async function generateLearnedProposals(country: string, limit = 10): Promise<DiscoveryFrontierProposal[]> {
  const db = await getDb();
  const res = await db.query(
    `SELECT q.query, q.intent, q.primary_term, q.country
     FROM query_library q
     WHERE UPPER(q.country) = $1 AND q.status = 'ACTIVE'
     ORDER BY q.performance_score DESC, q.updated_at DESC
     LIMIT $2`,
    [country.toUpperCase(), limit]
  );

  return res.rows.map(row =>
    buildFrontierProposal({
      proposalFamily: 'LEARNED',
      country: row.country,
      concept: row.primary_term || row.query,
      intent: row.intent || 'GENERAL',
      sourceProvenance: `query_library:active_query:${row.query}`,
      supportingEvidence: { historicalPerformance: 'PROVEN' },
      confidence: 0.85,
      noveltyRationale: 'Exploitation baseline from historically high-performing terminology.'
    })
  );
}

// 2. CREATOR_DERIVED Generator
export async function generateCreatorDerivedProposals(country: string, limit = 10): Promise<DiscoveryFrontierProposal[]> {
  const db = await getDb();
  const res = await db.query(
    `SELECT c.channel_id, c.title, c.description, c.primary_market
     FROM channels c
     WHERE UPPER(c.country) = $1 AND c.trading_status = 'TRADING_CONFIRMED' AND c.quality_score >= ${QUALITY_CREATOR_SCORE_THRESHOLD}
     ORDER BY c.updated_at DESC
     LIMIT $2`,
    [country.toUpperCase(), limit]
  );

  const proposals: DiscoveryFrontierProposal[] = [];
  for (const row of res.rows) {
    const rawTitle = row.title || '';
    // Extract candidate trading keywords from channel title / description metadata
    const terms = rawTitle.split(/\s+/).filter((t: string) => t.length >= 4 && !/youtube|channel|video|official/i.test(t));
    const term = terms[0] || rawTitle;
    if (!term) continue;

    proposals.push(
      buildFrontierProposal({
        proposalFamily: 'CREATOR_DERIVED',
        country,
        concept: term,
        sourceProvenance: `creator_metadata:${row.channel_id}`,
        supportingEvidence: { channelId: row.channel_id, channelTitle: row.title },
        confidence: 0.70,
        noveltyRationale: `Derived from verified quality trading creator "${row.title}" metadata.`
      })
    );
  }
  return proposals;
}

// 3. CREATOR_NEIGHBORHOOD Generator
export async function generateCreatorNeighborhoodProposals(country: string, limit = 10): Promise<DiscoveryFrontierProposal[]> {
  const db = await getDb();
  const res = await db.query(
    `SELECT cf.featured_channel_id, cf.featured_title, c.country
     FROM creator_featured_channels cf
     JOIN channels c ON c.channel_id = cf.source_channel_id
     WHERE UPPER(c.country) = $1 AND cf.featured_title IS NOT NULL AND cf.featured_title <> ''
     ORDER BY cf.discovered_at DESC
     LIMIT $2`,
    [country.toUpperCase(), limit]
  ).catch(() => ({ rows: [] }));

  return res.rows.map(row =>
    buildFrontierProposal({
      proposalFamily: 'CREATOR_NEIGHBORHOOD',
      country,
      concept: row.featured_title,
      sourceProvenance: `featured_channel:${row.featured_channel_id}`,
      supportingEvidence: { featuredChannelId: row.featured_channel_id },
      confidence: 0.65,
      noveltyRationale: `Derived from existing creator-neighborhood featured channel link "${row.featured_title}".`
    })
  );
}

// 4. PLAYLIST_TOPIC Generator
export async function generatePlaylistTopicProposals(country: string, limit = 10): Promise<DiscoveryFrontierProposal[]> {
  const db = await getDb();
  const res = await db.query(
    `SELECT playlist_id, title, country
     FROM creator_playlists
     WHERE UPPER(country) = $1 AND title IS NOT NULL AND title <> ''
     ORDER BY discovered_at DESC
     LIMIT $2`,
    [country.toUpperCase(), limit]
  ).catch(() => ({ rows: [] }));

  return res.rows.map(row =>
    buildFrontierProposal({
      proposalFamily: 'PLAYLIST_TOPIC',
      country,
      concept: row.title,
      sourceProvenance: `creator_playlist:${row.playlist_id}`,
      supportingEvidence: { playlistId: row.playlist_id },
      confidence: 0.60,
      noveltyRationale: `Derived from governed creator playlist topic "${row.title}".`
    })
  );
}

// 5. COUNTRY_NATIVE Generator
const NATIVE_FINANCIAL_SEEDS: Record<string, string[]> = {
  JP: ['日経平均', '株式投資', 'FX自動売買', '先物取引', '暗号資産'],
  BR: ['B3 bolsa', 'mini indice', 'day trade acoes', 'investimentos tesouro', 'criptomoedas'],
  GB: ['FTSE 100 trading', 'spread betting', 'isa stocks', 'uk forex trader', 'crypto trading'],
  DE: ['DAX trading', 'boerse aktien', 'hebelprodukte', 'etf sparplan', 'krypto boerse'],
  US: ['S&P 500 futures', 'options trading', 'stock market analysis', 'crypto swing trading', 'forex strategy'],
  IN: ['Nifty 50 options', 'Bank Nifty daytrading', 'Indian stock market', 'Zerodha trading', 'crypto India']
};

export function projectionProposalProvenance(
  nativeEvidenceStatus: string,
  sourceProvenanceFamily: string,
  canonicalTermId: number
): { provenanceType: string; sourceProvenance: string } {
  const identity = `canonical_projection:${canonicalTermId}`;
  if (nativeEvidenceStatus === 'NATIVE_OBSERVED') {
    return { provenanceType: 'observed_native_evidence', sourceProvenance: `observed_native_evidence:${sourceProvenanceFamily.toLowerCase()}:${identity}` };
  }
  if (nativeEvidenceStatus === 'TRANSLATED_SEED' || sourceProvenanceFamily === 'TRANSLATED_QUERY') {
    return { provenanceType: 'translated_seed', sourceProvenance: `translated_seed:translated_query:${identity}` };
  }
  if (sourceProvenanceFamily === 'COUNTRY_VOCABULARY') {
    return { provenanceType: 'bootstrap_vocabulary', sourceProvenance: `bootstrap_vocabulary:country_vocabulary:${identity}` };
  }
  return { provenanceType: 'bootstrap_vocabulary', sourceProvenance: `bootstrap_vocabulary:static_bootstrap:${identity}` };
}

export async function generateCountryNativeProposals(country: string, limit = 10): Promise<DiscoveryFrontierProposal[]> {
  const canonicalC = canonicalCountry(country);
  const normC = canonicalC.toUpperCase();
  const seedKey = country.toUpperCase().trim();

  try {
    const db = await getDb().catch(() => null);
    if (db) {
      // 1. First, check Phase 10 proposal-eligible native projections from canonical_trading_terms
      const nativeProjRes = await db.query(
        `SELECT
           t.id AS canonical_term_id,
           t.canonical_term,
           t.concept_id,
           p.native_confidence_score,
           p.native_evidence_status,
           p.source_provenance_family,
           p.source_provenance_families,
           p.bootstrap_seed_count,
           p.quality_creator_count,
           p.native_quality_creator_count,
           p.distinct_creator_count,
           p.structured_entity_matched,
           p.evidence_revision,
           p.is_code_switched,
           p.code_switch_type,
           p.observed_creator_countries,
           p.observed_market_countries,
           p.last_observed_at
           ,p.updated_at AS projection_updated_at
         FROM country_native_evidence_projections p
         JOIN canonical_trading_terms t ON t.id = p.canonical_term_id
         WHERE UPPER(p.country) = $1 AND p.native_proposal_eligible = true
         ORDER BY p.native_confidence_score DESC, p.last_observed_at DESC, p.canonical_term_id ASC
         LIMIT $2`,
        [normC, limit]
      ).catch(() => ({ rows: [] }));

      if (nativeProjRes.rows.length > 0) {
        return nativeProjRes.rows.map(row => {
          const effective = effectiveProjectionProposalEvidence(row);
          const provenance = projectionProposalProvenance(
            effective.nativeEvidenceStatus,
            effective.sourceProvenanceFamily,
            Number(row.canonical_term_id)
          );
          return buildFrontierProposal({
            proposalFamily: 'COUNTRY_NATIVE',
            country: canonicalC,
            preserveCountryIdentity: true,
            concept: row.canonical_term,
            sourceProvenance: provenance.sourceProvenance,
            supportingEvidence: {
              provenanceType: provenance.provenanceType,
              nativeEvidenceStatus: effective.nativeEvidenceStatus,
              sourceProvenanceFamily: effective.sourceProvenanceFamily,
              canonicalTermId: Number(row.canonical_term_id),
              conceptId: row.concept_id || null,
              nativeConfidenceScore: Number(row.native_confidence_score),
              qualityCreatorCount: Number(row.quality_creator_count),
              nativeQualityCreatorCount: Number(row.native_quality_creator_count),
              distinctCreatorCount: Number(row.distinct_creator_count),
              isCodeSwitched: Boolean(row.is_code_switched),
              structuredEntityMatched: Boolean(row.structured_entity_matched),
              evidenceRevision: String(row.evidence_revision || '0'),
              projectionRevision: row.projection_updated_at instanceof Date
                ? row.projection_updated_at.toISOString() : row.projection_updated_at,
              codeSwitchType: row.code_switch_type || 'NONE',
              observedCreatorCountries: row.observed_creator_countries || [],
              observedMarketCountries: row.observed_market_countries || [],
              lastObservedAt: row.last_observed_at instanceof Date
                ? row.last_observed_at.toISOString()
                : row.last_observed_at,
              nativeTerm: row.canonical_term,
              market: canonicalC
            },
            confidence: Number(row.native_confidence_score),
            noveltyRationale: `Generated from eligible country-native concept projection for ${normC}.`
          });
        });
      }

      // 2. Fallback to country_vocabularies if present
      const vocabRes = await db.query(
        `SELECT native_trading_terminology, popular_instruments, local_market_phrases
         FROM country_vocabularies
         WHERE UPPER(country) = $1`,
        [normC]
      ).catch(() => ({ rows: [] }));

      if (vocabRes.rows.length > 0) {
        const row = vocabRes.rows[0];
        const parseList = (val: any): string[] => {
          if (!val) return [];
          if (Array.isArray(val)) return val.map(x => String(x).trim()).filter(Boolean);
          if (typeof val === 'string') {
            try {
              const parsed = JSON.parse(val);
              if (Array.isArray(parsed)) return parsed.map(x => String(x).trim()).filter(Boolean);
            } catch {
              return val.split(',').map(x => x.trim()).filter(Boolean);
            }
          }
          return [];
        };

        const observedTerms = Array.from(new Set([
          ...parseList(row.native_trading_terminology),
          ...parseList(row.popular_instruments),
          ...parseList(row.local_market_phrases)
        ])).slice(0, limit);

        if (observedTerms.length > 0) {
          return observedTerms.map(term =>
            buildFrontierProposal({
              proposalFamily: 'COUNTRY_NATIVE',
              country: canonicalC,
              preserveCountryIdentity: true,
              concept: term,
              sourceProvenance: `bootstrap_vocabulary:country_vocabularies:${term}`,
              supportingEvidence: {
                provenanceType: 'bootstrap_vocabulary',
                nativeEvidenceStatus: 'BOOTSTRAP_SEED',
                sourceProvenanceFamily: 'COUNTRY_VOCABULARY',
                sourceTable: 'country_vocabularies',
                nativeTerm: term,
                market: canonicalC
              },
              confidence: 0.85,
              noveltyRationale: `Generated from governed country vocabulary bootstrap evidence for ${normC}.`
            })
          );
        }
      }
    }
  } catch {
    // Database unavailable in unit test runtime; proceed to bootstrap vocabulary fallback
  }

  // 3. Fallback to static seed dictionary explicitly identified as bootstrap_vocabulary
  const isoSeedKey = countryIsoAlias(canonicalC);
  const seeds = (isoSeedKey ? NATIVE_FINANCIAL_SEEDS[isoSeedKey] : undefined) ||
    NATIVE_FINANCIAL_SEEDS[seedKey] || NATIVE_FINANCIAL_SEEDS[normC] ||
    ['local exchange trading', 'stock market investing', 'crypto trading'];
  return seeds.slice(0, limit).map(seed =>
    buildFrontierProposal({
      proposalFamily: 'COUNTRY_NATIVE',
      country: canonicalC,
      preserveCountryIdentity: true,
      concept: seed,
      sourceProvenance: `bootstrap_vocabulary:static_seed:${seed}`,
      supportingEvidence: {
        provenanceType: 'bootstrap_vocabulary',
        nativeEvidenceStatus: 'BOOTSTRAP_SEED',
        sourceProvenanceFamily: 'STATIC_BOOTSTRAP',
        isBootstrapSeed: true,
        nativeTerm: seed,
        market: canonicalC
      },
      confidence: 0.65,
      noveltyRationale: `Generated from bootstrap seed dictionary for ${normC}.`
    })
  );
}

/** Bounded Phase 10 materialization for the existing autonomous producer cycle. */
export async function materializeBoundedCountryNativeProposals(
  countries: string[],
  config: { globalCap?: number; perCountryCap?: number; fairnessCursor?: number } = {}
): Promise<{ generated: number; persisted: number; proposals: DiscoveryFrontierProposal[] }> {
  const globalCap = Math.min(100, Math.max(1, Math.floor(config.globalCap ?? 25)));
  const perCountryCap = Math.min(globalCap, Math.max(1, Math.floor(config.perCountryCap ?? 5)));
  const normalizedCountries = [...new Set(countries.map(canonicalCountry).filter(Boolean))].sort();
  const groups = await Promise.all(normalizedCountries.map(async country => ({
    country,
    proposals: await generateCountryNativeProposals(country, perCountryCap).catch(() => [])
  })));
  const proposals = selectFairCountryNativeProposals(groups, globalCap, config.fairnessCursor ?? 0);
  const persisted = await persistFrontierProposals(proposals);
  return { generated: proposals.length, persisted, proposals };
}

/** Deterministic rotating round-robin selection prevents lexicographic country starvation. */
export function selectFairCountryNativeProposals(
  groups: Array<{ country: string; proposals: DiscoveryFrontierProposal[] }>,
  globalCap: number,
  fairnessCursor: number
): DiscoveryFrontierProposal[] {
  const ordered = groups
    .map(group => ({ ...group, proposals: [...group.proposals] }))
    .filter(group => group.proposals.length > 0)
    .sort((a, b) => a.country.localeCompare(b.country));
  if (!ordered.length || globalCap <= 0) return [];
  const offset = Math.max(0, Math.floor(fairnessCursor)) % ordered.length;
  const rotated = [...ordered.slice(offset), ...ordered.slice(0, offset)];
  const seen = new Set<string>();
  const selected: DiscoveryFrontierProposal[] = [];
  const maxDepth = Math.max(...rotated.map(group => group.proposals.length));
  for (let depth = 0; depth < maxDepth && selected.length < globalCap; depth++) {
    for (const group of rotated) {
      const proposal = group.proposals[depth];
      if (proposal && !seen.has(proposal.dedupKey)) {
        seen.add(proposal.dedupKey);
        selected.push(proposal);
        if (selected.length >= globalCap) break;
      }
    }
  }
  return selected;
}

// 6. COVERAGE_GAP Generator
export async function generateCoverageGapProposals(country: string, limit = 10): Promise<DiscoveryFrontierProposal[]> {
  const db = await getDb();
  const res = await db.query(
    `SELECT segment_type, segment_key, underexplored_quota_percent
     FROM neighborhood_health_diagnostics
     WHERE coverage_gap_identified = true
       AND (
         (segment_type = 'COUNTRY' AND UPPER(segment_key) = $1) OR
         segment_type IN ('INTENT', 'INSTRUMENT', 'NEIGHBORHOOD')
       )
     ORDER BY underexplored_quota_percent ASC, calculated_at DESC
     LIMIT $2`,
    [country.toUpperCase(), limit]
  ).catch(() => ({ rows: [] }));

  return res.rows.map(row =>
    buildFrontierProposal({
      proposalFamily: 'COVERAGE_GAP',
      country,
      concept: row.segment_key,
      intent: row.segment_type === 'INTENT' ? row.segment_key : 'COVERAGE_EXPANSION',
      sourceProvenance: `health_diagnostic:${row.segment_type}:${row.segment_key}`,
      supportingEvidence: { underexploredQuotaPercent: row.underexplored_quota_percent },
      confidence: 0.80,
      noveltyRationale: `Hypothesis targeting identified discovery coverage gap in segment ${row.segment_type}:${row.segment_key}.`
    })
  );
}

// 7. TEMPORAL Generator
export async function generateTemporalProposals(country: string, limit = 10): Promise<DiscoveryFrontierProposal[]> {
  const db = await getDb();
  const res = await db.query(
    `SELECT event_key, title
     FROM temporal_research_events
     WHERE event_status = 'ACTIVE'
     ORDER BY created_at DESC
     LIMIT $2`,
    [limit]
  ).catch(() => ({ rows: [] }));

  return res.rows.map(row =>
    buildFrontierProposal({
      proposalFamily: 'TEMPORAL',
      country,
      concept: row.title || row.event_key,
      sourceProvenance: `temporal_event:${row.event_key}`,
      supportingEvidence: { eventKey: row.event_key },
      confidence: 0.70,
      noveltyRationale: `Derived from active temporal research event "${row.title || row.event_key}".`
    })
  );
}

/**
 * Persists proposals with stable identity; COUNTRY_NATIVE evidence upgrades only
 * when deterministic provenance precedence is stronger, or same-tier evidence
 * improves monotonically without losing an already persisted signal.
 */
export async function persistFrontierProposals(
  proposals: DiscoveryFrontierProposal[]
): Promise<number> {
  if (!proposals.length) return 0;
  const db = await getDb();
  let inserted = 0;

  for (const p of proposals) {
    let client: any = null;
    let runner: any = db;
    try {
      const canonicalTermId = Number(p.supportingEvidence.canonicalTermId);
      if (p.proposalFamily === 'COUNTRY_NATIVE' && Number.isSafeInteger(canonicalTermId) && canonicalTermId > 0) {
        client = await db.connect();
        runner = client;
        await runner.query('BEGIN');
        await runner.query('SELECT id FROM canonical_trading_terms WHERE id=$1 FOR SHARE', [canonicalTermId]);
        const authoritative = await runner.query(
          `SELECT native_evidence_status,source_provenance_family,source_provenance_families,
                  bootstrap_seed_count,native_quality_creator_count,structured_entity_matched,
                  native_proposal_eligible,evidence_revision,updated_at
           FROM country_native_evidence_projections
           WHERE canonical_term_id=$1 FOR SHARE`,
          [canonicalTermId]
        );
        if (!authoritative.rowCount) {
          await runner.query('ROLLBACK'); client.release(); client = null; continue;
        }
        const row = authoritative.rows[0];
        const effective = effectiveProjectionProposalEvidence(row);
        const incomingProjectionRevision = new Date(String(p.supportingEvidence.projectionRevision || 0)).getTime();
        const currentProjectionRevision = new Date(row.updated_at).getTime();
        const currentRevision = String(row.evidence_revision || '0');
        if (!row.native_proposal_eligible || incomingProjectionRevision !== currentProjectionRevision ||
            String(p.supportingEvidence.evidenceRevision || '0') !== currentRevision ||
            p.supportingEvidence.nativeEvidenceStatus !== effective.nativeEvidenceStatus ||
            p.supportingEvidence.sourceProvenanceFamily !== effective.sourceProvenanceFamily) {
          await runner.query('ROLLBACK'); client.release(); client = null; continue;
        }
      }
      if (p.targetNeighborhoodKey) {
      const d = p.targetDimensions;
      await runner.query(
        `INSERT INTO discovery_neighborhoods(
           neighborhood_key,neighborhood_checksum,country,language,query_intent,
           primary_term_family,retrieval_lane,search_ordering,instrument_or_theme,source_family,metadata
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'{}'::jsonb)
         ON CONFLICT(neighborhood_key) DO NOTHING`,
        [p.targetNeighborhoodKey, createNeighborhoodChecksum(p.targetNeighborhoodKey), d.country, d.language,
          d.queryIntent, d.primaryTermFamily, d.retrievalLane, d.searchOrdering, d.instrumentOrTheme, d.sourceFamily]
      );
      }
      const res = await runner.query(
      `INSERT INTO frontier_discovery_proposals(
         dedup_key, proposal_family, country, language, concept,
         target_neighborhood_key, target_dimensions, source_provenance,
         supporting_evidence, confidence, novelty_rationale, trial_status, expires_at
       )
       VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT(dedup_key) DO UPDATE SET
         country=excluded.country,
         language=excluded.language,
         target_neighborhood_key=excluded.target_neighborhood_key,
         target_dimensions=excluded.target_dimensions,
         source_provenance=excluded.source_provenance,
         supporting_evidence=excluded.supporting_evidence,
         confidence=excluded.confidence,
         novelty_rationale=excluded.novelty_rationale,
         trial_status=CASE
           WHEN frontier_discovery_proposals.trial_status IN ('TRIED','EXPIRED') THEN frontier_discovery_proposals.trial_status
           WHEN frontier_discovery_proposals.trial_status='DISABLED' THEN excluded.trial_status
           ELSE frontier_discovery_proposals.trial_status
         END,
         expires_at=excluded.expires_at
       WHERE frontier_discovery_proposals.proposal_family='COUNTRY_NATIVE'
         AND excluded.proposal_family='COUNTRY_NATIVE'
         AND ((CASE
           WHEN excluded.supporting_evidence->>'nativeEvidenceStatus'='NATIVE_OBSERVED' THEN 400
           WHEN excluded.supporting_evidence->>'sourceProvenanceFamily'='COUNTRY_VOCABULARY' THEN 300
           WHEN excluded.supporting_evidence->>'nativeEvidenceStatus'='TRANSLATED_SEED' THEN 200
           WHEN excluded.supporting_evidence->>'sourceProvenanceFamily'='STATIC_BOOTSTRAP' THEN 100
           ELSE 0 END)
         > (CASE
           WHEN frontier_discovery_proposals.supporting_evidence->>'nativeEvidenceStatus'='NATIVE_OBSERVED' THEN 400
           WHEN frontier_discovery_proposals.supporting_evidence->>'sourceProvenanceFamily'='COUNTRY_VOCABULARY' THEN 300
           WHEN frontier_discovery_proposals.supporting_evidence->>'nativeEvidenceStatus'='TRANSLATED_SEED' THEN 200
           WHEN frontier_discovery_proposals.supporting_evidence->>'sourceProvenanceFamily'='STATIC_BOOTSTRAP' THEN 100
           ELSE 0 END)
         OR (
           (CASE
             WHEN excluded.supporting_evidence->>'nativeEvidenceStatus'='NATIVE_OBSERVED' THEN 400
             WHEN excluded.supporting_evidence->>'sourceProvenanceFamily'='COUNTRY_VOCABULARY' THEN 300
             WHEN excluded.supporting_evidence->>'nativeEvidenceStatus'='TRANSLATED_SEED' THEN 200
             WHEN excluded.supporting_evidence->>'sourceProvenanceFamily'='STATIC_BOOTSTRAP' THEN 100
             ELSE 0 END)
           = (CASE
             WHEN frontier_discovery_proposals.supporting_evidence->>'nativeEvidenceStatus'='NATIVE_OBSERVED' THEN 400
             WHEN frontier_discovery_proposals.supporting_evidence->>'sourceProvenanceFamily'='COUNTRY_VOCABULARY' THEN 300
             WHEN frontier_discovery_proposals.supporting_evidence->>'nativeEvidenceStatus'='TRANSLATED_SEED' THEN 200
             WHEN frontier_discovery_proposals.supporting_evidence->>'sourceProvenanceFamily'='STATIC_BOOTSTRAP' THEN 100
             ELSE 0 END)
           AND (
             COALESCE((excluded.supporting_evidence->>'lastObservedAt')::timestamptz,'epoch'::timestamptz)
               > COALESCE((frontier_discovery_proposals.supporting_evidence->>'lastObservedAt')::timestamptz,'epoch'::timestamptz)
             OR (
               COALESCE((excluded.supporting_evidence->>'lastObservedAt')::timestamptz,'epoch'::timestamptz)
                 = COALESCE((frontier_discovery_proposals.supporting_evidence->>'lastObservedAt')::timestamptz,'epoch'::timestamptz)
               AND (
                 COALESCE((excluded.supporting_evidence->>'evidenceRevision')::numeric,0)
                   > COALESCE((frontier_discovery_proposals.supporting_evidence->>'evidenceRevision')::numeric,0)
                 OR (
                   COALESCE((excluded.supporting_evidence->>'evidenceRevision')::numeric,0)
                     = COALESCE((frontier_discovery_proposals.supporting_evidence->>'evidenceRevision')::numeric,0)
                   AND COALESCE((excluded.supporting_evidence->>'projectionRevision')::timestamptz,'epoch'::timestamptz)
                     > COALESCE((frontier_discovery_proposals.supporting_evidence->>'projectionRevision')::timestamptz,'epoch'::timestamptz)
                 )
               )
             )
           )
         )
         OR (
           excluded.supporting_evidence ? 'projectionRevision'
           AND excluded.supporting_evidence->>'canonicalTermId' = frontier_discovery_proposals.supporting_evidence->>'canonicalTermId'
           AND excluded.supporting_evidence->>'nativeEvidenceStatus' IS DISTINCT FROM frontier_discovery_proposals.supporting_evidence->>'nativeEvidenceStatus'
           AND COALESCE((excluded.supporting_evidence->>'projectionRevision')::timestamptz,'epoch'::timestamptz)
             > COALESCE((frontier_discovery_proposals.supporting_evidence->>'projectionRevision')::timestamptz,'epoch'::timestamptz)
         ))`,
      [
        p.dedupKey,
        p.proposalFamily,
        p.country,
        p.language,
        p.concept,
        p.targetNeighborhoodKey,
        JSON.stringify(p.targetDimensions),
        p.sourceProvenance,
        JSON.stringify(p.supportingEvidence),
        p.confidence,
        p.noveltyRationale,
        p.trialStatus,
        p.expiresAt
      ]
    );
      if (res.rowCount) inserted++;
      if (client) await runner.query('COMMIT');
    } catch (error) {
      if (client) await runner.query('ROLLBACK');
      throw error;
    } finally {
      if (client) client.release();
    }
  }

  return inserted;
}

/**
 * Runs all 7 proposal generators for a country, applying governance caps and deduplication.
 */
export async function generateFrontierProposalsForCountry(
  country: string,
  config: ProposalGenerationConfig = {}
): Promise<{ generated: number; persisted: number; proposals: DiscoveryFrontierProposal[] }> {
  const perFamilyCap = config.perFamilyCap ?? 5;
  const globalCap = config.globalCap ?? 25;

  const [
    learned,
    derived,
    neighborhood,
    playlist,
    native,
    coverageGap,
    temporal
  ] = await Promise.all([
    generateLearnedProposals(country, perFamilyCap).catch(() => []),
    generateCreatorDerivedProposals(country, perFamilyCap).catch(() => []),
    generateCreatorNeighborhoodProposals(country, perFamilyCap).catch(() => []),
    generatePlaylistTopicProposals(country, perFamilyCap).catch(() => []),
    generateCountryNativeProposals(country, perFamilyCap).catch(() => []),
    generateCoverageGapProposals(country, perFamilyCap).catch(() => []),
    generateTemporalProposals(country, perFamilyCap).catch(() => [])
  ]);

  const allProposals = [
    ...learned,
    ...derived,
    ...neighborhood,
    ...playlist,
    ...native,
    ...coverageGap,
    ...temporal
  ];

  // Deduplicate in memory first
  const seenDedupKeys = new Set<string>();
  const deduped: DiscoveryFrontierProposal[] = [];

  for (const p of allProposals) {
    if (seenDedupKeys.has(p.dedupKey)) continue;
    seenDedupKeys.add(p.dedupKey);
    deduped.push(p);
    if (deduped.length >= globalCap) break;
  }

  const persistedCount = await persistFrontierProposals(deduped);
  return {
    generated: deduped.length,
    persisted: persistedCount,
    proposals: deduped
  };
}
