/**
 * Evidence-first discovery Phase 1 — ingestion integration runner.
 *
 * Wires extraction → baseline loading → deterministic screening → idempotent
 * staging behind the app_settings flag `discovery_extraction_enabled`
 * (absent key => OFF). The caller invokes this fire-and-forget; the runner
 * itself makes no provider/network calls, honors the terminology kill switch,
 * and only ever writes the staging domain.
 *
 * Failure contract: settings-read failure degrades to OFF; baseline lookup
 * failures fail screening closed (never write); staging errors propagate to the
 * caller's swallow-and-log boundary (see ingestionPipeline hook). Nothing here
 * reads or writes serving paths, eligibility gates, or `search_eligible`.
 */

import { getAppSetting, getDb } from '../dbCore';
import { canonicalCountry } from '../countryInference';
import { isTerminologyKillSwitchActive } from '../terminologyKillSwitch';
import { selectExplicitTerminologyLanguageContext } from '../terminologyLanguageContext';
import {
  EVIDENCE_EXTRACTION_VERSION,
  extractEvidenceCandidates,
  type EvidenceExtractionInput,
} from './evidenceExtraction';
import {
  EVIDENCE_SCREENING_POLICY_VERSION,
  screenEvidenceCandidates,
  type EvidenceScreeningBaseline,
} from './evidenceScreening';
import {
  stageEvidenceCandidates,
  type EvidenceStagingClient,
  type EvidenceStagingResult,
} from './evidenceStaging';

export const DISCOVERY_EXTRACTION_FLAG_KEY = 'discovery_extraction_enabled';

export interface DiscoveryExtractionInput extends EvidenceExtractionInput {
  detectedLanguages?: Array<{ language: string; confidence?: number }>;
  transcriptExcerpts?: Array<{ language?: string }>;
  /** Creator-level country evidence when known (evidence only, never inferred). */
  creatorCountry?: string | null;
  /** Retrieval-context country used as the staging country only when creator evidence is absent. */
  fallbackCountry: string;
}

export interface DiscoveryExtractionDeps {
  /** Injectable settings reader (flag + terminology kill switch). */
  readSetting?: (key: string) => Promise<string>;
  /** Injectable queryable; defaults to the app pool when DATABASE_URL is configured. */
  client?: EvidenceStagingClient;
}

export interface DiscoveryExtractionRunSummary {
  skipped: boolean;
  reason?: string;
  extracted: number;
  probeEligible: number;
  rejected: number;
  stagedCount: number;
  duplicateCount: number;
  observationCount: number;
  reasonCounts: Record<string, number>;
  durationMs: number;
  extractorVersion: string;
  screeningPolicyVersion: string;
}

function toTermArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
}

/** Runs the flag-gated extraction pass. Never throws on suppression conditions. */
export async function maybeRunDiscoveryEvidenceExtraction(
  input: DiscoveryExtractionInput,
  deps?: DiscoveryExtractionDeps
): Promise<DiscoveryExtractionRunSummary> {
  const startedAt = Date.now();
  const baseSummary = (): Omit<DiscoveryExtractionRunSummary, 'skipped'> => ({
    extracted: 0,
    probeEligible: 0,
    rejected: 0,
    stagedCount: 0,
    duplicateCount: 0,
    observationCount: 0,
    reasonCounts: {},
    durationMs: Date.now() - startedAt,
    extractorVersion: EVIDENCE_EXTRACTION_VERSION,
    screeningPolicyVersion: EVIDENCE_SCREENING_POLICY_VERSION,
  });
  const skippedSummary = (reason: string): DiscoveryExtractionRunSummary => ({
    skipped: true,
    reason,
    ...baseSummary(),
  });

  const readSetting =
    deps?.readSetting ??
    ((key: string) => getAppSetting(key, key === DISCOVERY_EXTRACTION_FLAG_KEY ? 'false' : ''));

  let flagValue: string;
  try {
    flagValue = String(await readSetting(DISCOVERY_EXTRACTION_FLAG_KEY)).trim().toLowerCase();
  } catch {
    return skippedSummary('FLAG_READ_FAILED');
  }
  if (flagValue !== 'true') return skippedSummary('FLAG_OFF');

  if (await isTerminologyKillSwitchActive({ readSetting })) {
    return skippedSummary('KILL_SWITCH_ACTIVE');
  }

  const client =
    deps?.client ??
    (process.env.DATABASE_URL
      ? ((await getDb()) as unknown as EvidenceStagingClient)
      : null);
  if (!client) return skippedSummary('NO_DATABASE');

  const extracted = extractEvidenceCandidates(input);
  if (extracted.length === 0) {
    return { skipped: false, ...baseSummary() };
  }

  const languageContext = selectExplicitTerminologyLanguageContext({
    detectedLanguages: input.detectedLanguages,
    // Videos are metadata text for extraction; only their language hint (when a
    // future payload carries one) participates in deterministic context selection.
    videos: input.videos?.map(video => ({ language: (video as { language?: string }).language })),
    transcriptExcerpts: input.transcriptExcerpts,
  });
  const rawCountry = ((input.creatorCountry || '').trim() || input.fallbackCountry.trim());
  const country = canonicalCountry(rawCountry);

  let vocabOk = true;
  let vocabLanguages: string[] | null = null;
  let curatedTerms: string[] = [];
  try {
    const fetchVocab = (c: string) =>
      client.query(
        `SELECT languages, native_trading_terminology, popular_instruments, local_market_phrases, common_content_format_names FROM country_vocabularies WHERE country=$1`,
        [c]
      );
    let row = (await fetchVocab(country)).rows[0];
    if (!row && country !== rawCountry) row = (await fetchVocab(rawCountry)).rows[0];
    if (row) {
      vocabLanguages = toTermArray(row.languages);
      curatedTerms = [
        ...toTermArray(row.native_trading_terminology),
        ...toTermArray(row.popular_instruments),
        ...toTermArray(row.local_market_phrases),
        ...toTermArray(row.common_content_format_names),
      ];
    }
  } catch {
    vocabOk = false;
  }

  let catalogOk = true;
  let catalogTerms: string[] = [];
  try {
    const res = await client.query(
      `SELECT normalized_term FROM canonical_trading_terms WHERE country=$1`,
      [country]
    );
    catalogTerms = res.rows.map(row => String(row.normalized_term ?? '')).filter(Boolean);
  } catch {
    catalogOk = false;
  }

  const baseline: EvidenceScreeningBaseline = {
    country,
    catalogOk,
    catalogTerms,
    vocabOk,
    vocabLanguages,
    curatedTerms,
    language: languageContext?.language,
  };
  const screened = screenEvidenceCandidates(extracted, baseline);

  const reasonCounts: Record<string, number> = {};
  for (const result of screened) {
    for (const reason of result.reasons) {
      reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
    }
  }
  const eligible = screened
    .filter(result => result.decision === 'PROBE_ELIGIBLE')
    .map(result => result.candidate);

  let staging: EvidenceStagingResult = { stagedCount: 0, duplicateCount: 0, observationCount: 0 };
  if (eligible.length > 0) {
    staging = await stageEvidenceCandidates(
      eligible,
      { channelId: input.channelId, country, language: languageContext?.language ?? null },
      client
    );
  }

  const summary: DiscoveryExtractionRunSummary = {
    skipped: false,
    extracted: extracted.length,
    probeEligible: eligible.length,
    rejected: screened.length - eligible.length,
    stagedCount: staging.stagedCount,
    duplicateCount: staging.duplicateCount,
    observationCount: staging.observationCount,
    reasonCounts,
    durationMs: Date.now() - startedAt,
    extractorVersion: EVIDENCE_EXTRACTION_VERSION,
    screeningPolicyVersion: EVIDENCE_SCREENING_POLICY_VERSION,
  };
  console.log(
    `[DiscoveryExtraction] channel=${input.channelId} country=${country} extracted=${summary.extracted} probeEligible=${summary.probeEligible} rejected=${summary.rejected} staged=${summary.stagedCount} duplicates=${summary.duplicateCount} observations=${summary.observationCount} durationMs=${summary.durationMs} reasons=${JSON.stringify(reasonCounts)}`
  );
  return summary;
}
