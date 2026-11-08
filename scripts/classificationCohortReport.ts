import { readFileSync } from 'node:fs';
import { EvidenceBasedTradingEngine } from '../server/evidenceEngine/index';
import { ChannelMetadataProvider } from '../server/evidenceEngine/providers/ChannelMetadataProvider';
import { CountryKnowledgeProvider } from '../server/evidenceEngine/providers/CountryKnowledgeProvider';
import { DiscordProvider } from '../server/evidenceEngine/providers/DiscordProvider';
import { ExternalLinkProvider } from '../server/evidenceEngine/providers/ExternalLinkProvider';
import { MultilingualContextProvider } from '../server/evidenceEngine/providers/MultilingualContextProvider';
import { VideoMetadataProvider } from '../server/evidenceEngine/providers/VideoMetadataProvider';
import type { RawChannelInput } from '../server/evidenceEngine/types';
import { classificationInputChecksum } from '../server/classificationInputChecksum';

/**
 * Read-only classification cohort report.
 *
 * Usage:
 *   npx tsx scripts/classificationCohortReport.ts --input diagnostics.json
 *   npx tsx scripts/classificationCohortReport.ts --input diagnostics.jsonl --replay
 *
 * The input is an exported JSON array, an object with a `rows` array, or
 * newline-delimited JSON. Rows may come straight from
 * production_classification_diagnostics: `decision` and `normalized_input` can
 * be JSON strings. No database connection is opened and no row is modified.
 */

interface DiagnosticRow {
  channel_id?: string;
  decision?: unknown;
  normalized_input?: unknown;
}

interface ParsedRow {
  channelId: string;
  decision: Record<string, any>;
  normalizedInput?: RawChannelInput;
}

function loadRows(path: string): DiagnosticRow[] {
  const raw = readFileSync(path, 'utf8').trim();
  if (!raw) return [];
  if (raw.startsWith('[')) return JSON.parse(raw) as DiagnosticRow[];
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw) as DiagnosticRow | { rows?: DiagnosticRow[] };
      if (Array.isArray((parsed as { rows?: DiagnosticRow[] }).rows)) {
        return (parsed as { rows: DiagnosticRow[] }).rows;
      }
      return [parsed as DiagnosticRow];
    } catch {
      // Multiple JSON objects (JSONL) also start with `{`; fall through to
      // line-by-line parsing instead of rejecting the whole export.
    }
  }
  return raw.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line) as DiagnosticRow);
}

function parseMaybeJson(value: unknown): any {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function unwrapRows(rows: DiagnosticRow[]): ParsedRow[] {
  return rows.flatMap(row => {
    const decision = parseMaybeJson(row.decision);
    if (!decision || typeof decision !== 'object') return [];
    return [{
      channelId: String(row.channel_id || (decision as any).channelId || 'unknown'),
      decision: decision as Record<string, any>,
      normalizedInput: parseMaybeJson(row.normalized_input) as RawChannelInput | undefined,
    }];
  });
}

function increment(counts: Record<string, number>, key: string | undefined | null): void {
  if (!key) return;
  counts[key] = (counts[key] || 0) + 1;
}

function deterministicEngine(): EvidenceBasedTradingEngine {
  // Replay is deliberately deterministic and offline. Clear semantic selector
  // and cache env so a loaded production environment cannot make a paid model
  // call or write the semantic cache.
  for (const key of [
    'SEMANTIC_PROVIDER', 'SEMANTIC_PROVIDER_FORCE_GEMINI', 'SEMANTIC_RESULT_CACHE_ENABLED',
    'GEMINI_API_KEY', 'GOOGLE_AI_STUDIO.GEMINI_API_KEY', 'GEMINI_FREE_API_KEY', 'GROQ_API_KEY',
  ]) {
    delete process.env[key];
  }
  return new EvidenceBasedTradingEngine([
    new ChannelMetadataProvider(),
    new VideoMetadataProvider(),
    new ExternalLinkProvider(),
    new CountryKnowledgeProvider(),
    new MultilingualContextProvider(),
    new DiscordProvider(),
  ]);
}

const SEMANTIC_PROVIDERS = new Set(['gemini_semantic', 'groq_semantic', 'gemini_free_semantic']);

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const inputIndex = args.indexOf('--input');
  const inputPath = inputIndex >= 0 ? args[inputIndex + 1] : undefined;
  const replay = args.includes('--replay');
  if (!inputPath) {
    console.error('Usage: npx tsx scripts/classificationCohortReport.ts --input <diagnostics.json|jsonl> [--replay]');
    process.exitCode = 2;
    return;
  }

  const rows = unwrapRows(loadRows(inputPath));
  const statuses: Record<string, number> = {};
  const focuses: Record<string, number> = {};
  const reasonCodes: Record<string, number> = {};
  const negativeRoles: Record<string, number> = {};
  const policyVersions: Record<string, number> = {};
  const compositions: Record<string, number> = {};
  const coverageHistogram: Record<string, number> = {
    'none': 0, '0': 0, '(0,0.34)': 0, '[0.34,0.5)': 0, '[0.5,0.75)': 0, '[0.75,1]': 0,
  };
  let duplicateCollapsed = 0;
  let suppressedTerms = 0;
  let checksumRows = 0;
  let mixedNegativeWithholdings = 0;

  for (const row of rows) {
    const decision = row.decision;
    increment(statuses, decision.status);
    const composition = decision.composition;
    increment(focuses, composition?.focus);
    increment(compositions, composition?.version);
    const coverage = typeof composition?.tradingCoverage === 'number' ? composition.tradingCoverage : undefined;
    if (coverage === undefined) coverageHistogram.none++;
    else if (coverage <= 0) coverageHistogram['0']++;
    else if (coverage < 0.34) coverageHistogram['(0,0.34)']++;
    else if (coverage < 0.5) coverageHistogram['[0.34,0.5)']++;
    else if (coverage < 0.75) coverageHistogram['[0.5,0.75)']++;
    else coverageHistogram['[0.75,1]']++;
    const stageReasons = (decision.stagedClassification?.stages || []).flatMap((stage: any) => stage.reasonCodes || []);
    if (stageReasons.includes('MIXED_EVIDENCE_TERMINAL_REJECTION_WITHHELD')) mixedNegativeWithholdings++;
    duplicateCollapsed += Number(composition?.duplicateFamiliesCollapsed || 0);
    for (const family of composition?.familyClassifications || []) {
      suppressedTerms += Array.isArray(family?.suppressedSignals) ? family.suppressedSignals.length : 0;
    }
    for (const reason of decision.decisionPolicy?.reasonCodes || []) increment(reasonCodes, reason);
    for (const item of decision.negativeEvidence || []) increment(negativeRoles, item?.role);
    for (const [name, version] of Object.entries(decision.policyVersions || {})) {
      increment(policyVersions, `${name}:${String(version)}`);
    }
    if (decision.replay?.inputChecksum) checksumRows++;
  }

  const report: Record<string, unknown> = {
    rows: rows.length,
    statuses,
    focuses,
    reasonCodes,
    negativeRoles,
    policyVersions,
    compositions,
    coverageHistogram,
    mixedNegativeWithholdings,
    duplicateFamiliesCollapsed: duplicateCollapsed,
    suppressedTerms,
    rowsWithReplayChecksum: checksumRows,
  };

  if (replay) {
    const engine = deterministicEngine();
    let matched = 0;
    const replayedStatuses: Record<string, number> = {};
    const mismatches: Array<{ channelId: string; stored?: string; replayed?: string }> = [];
    const semanticRowsExcluded: string[] = [];
    const semanticRowReplays: Array<{ channelId: string; stored?: string; replayed?: string }> = [];
    const semanticReplayStatuses: Record<string, number> = {};
    const checksumMismatches: Array<{ channelId: string; stored?: string; recomputed: string }> = [];
    const errors: Array<{ channelId: string; error: string }> = [];
    for (const row of rows) {
      if (!row.normalizedInput) continue;
      const storedChecksum = row.decision.replay?.inputChecksum;
      const recomputed = classificationInputChecksum(row.normalizedInput);
      if (storedChecksum && storedChecksum !== recomputed) {
        checksumMismatches.push({ channelId: row.channelId, stored: storedChecksum, recomputed });
        continue;
      }
      const providers = row.decision.evidenceCollection?.providers || [];
      const usedSemantic = Boolean(row.decision.geminiSemanticSummary)
        || providers.some((provider: any) =>
          SEMANTIC_PROVIDERS.has(provider?.provider)
          && provider?.outcome === 'EXECUTED_WITH_EVIDENCE');
      if (usedSemantic) {
        // The deterministic replay intentionally omits semantic evidence.
        // Report these rows separately instead of counting them as true
        // classification mismatches.
        semanticRowsExcluded.push(row.channelId);
        try {
          const replayed = await engine.evaluateChannel(row.normalizedInput);
          increment(semanticReplayStatuses, replayed.status);
          semanticRowReplays.push({ channelId: row.channelId, stored: row.decision.status, replayed: replayed.status });
        } catch (error) {
          errors.push({ channelId: row.channelId, error: error instanceof Error ? error.message : String(error) });
        }
        continue;
      }
      try {
        const replayed = await engine.evaluateChannel(row.normalizedInput);
        increment(replayedStatuses, replayed.status);
        if (replayed.status === row.decision.status) matched++;
        else mismatches.push({ channelId: row.channelId, stored: row.decision.status, replayed: replayed.status });
      } catch (error) {
        errors.push({ channelId: row.channelId, error: error instanceof Error ? error.message : String(error) });
      }
    }
    report.replay = {
      deterministicOnly: true,
      evaluated: matched + mismatches.length,
      matched,
      mismatched: mismatches.length,
      statuses: replayedStatuses,
      semanticRowsExcluded: semanticRowsExcluded.length,
      semanticExcludedChannelIds: semanticRowsExcluded.slice(0, 50),
      semanticReplayStatuses,
      semanticRowReplays: semanticRowReplays.slice(0, 50),
      checksumMismatches: checksumMismatches.length,
      checksumMismatchDetails: checksumMismatches.slice(0, 50),
      errors: errors.length,
      errorDetails: errors.slice(0, 50),
      mismatches: mismatches.slice(0, 50),
    };
  }

  console.log(JSON.stringify(report, null, 2));
}

void main();
