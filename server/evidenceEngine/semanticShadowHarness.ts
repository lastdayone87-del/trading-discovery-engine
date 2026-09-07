import type {
  EvidenceItem,
  EvidenceProvider,
  LayeredKnowledgeContext,
  RawChannelInput,
} from './types';

/**
 * Offline shadow-measurement harness for the Groq semantic provider.
 *
 * Compares Groq against Gemini over shared inputs without serving impact:
 * both providers run (live clients in ops shadow runs, injected stub clients
 * in tests), outputs are normalized to the governed taxonomy, and agreement
 * is measured on labels, abstention, polarity, and weight magnitude.
 * Provider failures are isolated per side per case (allSettled) and reported
 * separately — a throw on one side never discards the other's measurement.
 * Pure measurement: no writes, no traffic switching, no env reads.
 */

export interface ShadowSemanticOutput {
  label: string;
  abstained: boolean;
  polarity: EvidenceItem['polarity'];
  category: EvidenceItem['category'];
  rawWeight: number;
  finalWeight: number;
  confidence: number;
  modelVersion: string;
  reasonCodes: string[];
}

export interface ShadowCaseInput {
  id: string;
  input: RawChannelInput;
}

export interface ShadowCaseComparison {
  id: string;
  gemini: ShadowSemanticOutput | { error: string };
  groq: ShadowSemanticOutput | { error: string };
  agreeLabel: boolean;
  agreeAbstention: boolean;
  agreePolarity: boolean;
  absWeightDelta: number | null;
}

export interface ShadowComparisonReport {
  generatedAt: string;
  cases: number;
  evaluated: number;
  failures: Array<{ id: string; side: 'gemini' | 'groq'; error: string }>;
  agreement: { label: number; abstention: number; polarity: number };
  meanAbsWeightDelta: number | null;
  disagreements: ShadowCaseComparison[];
}

function normalize(item: EvidenceItem | undefined): ShadowSemanticOutput | null {
  if (!item) return null;
  return {
    label: item.provenance?.semantic?.taxonomyLabel || 'UNKNOWN',
    abstained: item.category === 'SEMANTIC_ABSTENTION',
    polarity: item.polarity,
    category: item.category,
    rawWeight: item.rawWeight,
    finalWeight: item.finalWeight,
    confidence: item.confidence,
    modelVersion: item.provenance?.semantic?.modelVersion || 'unknown',
    reasonCodes: item.provenance?.semantic?.reasonCodes || [],
  };
}

function isOutput(value: ShadowSemanticOutput | { error: string }): value is ShadowSemanticOutput {
  return !('error' in value);
}

export async function runSemanticShadowComparison(
  cases: ShadowCaseInput[],
  providers: { gemini: EvidenceProvider; groq: EvidenceProvider },
  knowledge: LayeredKnowledgeContext,
): Promise<ShadowComparisonReport> {
  const comparisons: ShadowCaseComparison[] = [];
  const failures: ShadowComparisonReport['failures'] = [];
  for (const { id, input } of cases) {
    const [geminiSettled, groqSettled] = await Promise.allSettled([
      providers.gemini.collectEvidence(input, knowledge),
      providers.groq.collectEvidence(input, knowledge),
    ]);
    const gemini: ShadowCaseComparison['gemini'] =
      geminiSettled.status === 'fulfilled'
        ? normalize(geminiSettled.value[0]) || { error: 'EMPTY_EVIDENCE' }
        : { error: geminiSettled.reason instanceof Error ? geminiSettled.reason.message : String(geminiSettled.reason) };
    const groq: ShadowCaseComparison['groq'] =
      groqSettled.status === 'fulfilled'
        ? normalize(groqSettled.value[0]) || { error: 'EMPTY_EVIDENCE' }
        : { error: groqSettled.reason instanceof Error ? groqSettled.reason.message : String(groqSettled.reason) };
    if (!isOutput(gemini)) failures.push({ id, side: 'gemini', error: (gemini as { error: string }).error });
    if (!isOutput(groq)) failures.push({ id, side: 'groq', error: (groq as { error: string }).error });
    if (!isOutput(gemini) || !isOutput(groq)) continue;
    comparisons.push({
      id,
      gemini,
      groq,
      agreeLabel: gemini.label === groq.label,
      agreeAbstention: gemini.abstained === groq.abstained,
      agreePolarity: gemini.polarity === groq.polarity,
      absWeightDelta: Math.abs(gemini.finalWeight - groq.finalWeight),
    });
  }
  const evaluated = comparisons.length;
  const agreement = {
    label: evaluated ? comparisons.filter(c => c.agreeLabel).length / evaluated : 0,
    abstention: evaluated ? comparisons.filter(c => c.agreeAbstention).length / evaluated : 0,
    polarity: evaluated ? comparisons.filter(c => c.agreePolarity).length / evaluated : 0,
  };
  const deltas = comparisons.map(c => c.absWeightDelta as number);
  return {
    generatedAt: new Date().toISOString(),
    cases: cases.length,
    evaluated,
    failures,
    agreement,
    meanAbsWeightDelta: deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : null,
    disagreements: comparisons.filter(c => !c.agreeLabel || !c.agreeAbstention || !c.agreePolarity),
  };
}
