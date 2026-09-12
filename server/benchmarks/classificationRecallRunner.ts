import { isTradingFocusedText } from '../evidenceEngine/multilingualTerminology';
import { getLayeredKnowledgeContext } from '../evidenceEngine/knowledgePacks';

export interface ClassificationBenchCase {
  channelId: string;
  country: string;
  description: string;
  videoTitles: string[];
  /** Ground truth from the 5-point protocol (facts C+D). */
  expected: 'TRADING' | 'NON_TRADING';
}

export interface ClassificationBenchDetail extends ClassificationBenchCase {
  predicted: 'TRADING' | 'NON_TRADING';
  correct: boolean;
}

export interface ClassificationBenchResult {
  evaluated: number;
  correct: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number | null;
  recall: number | null;
  details: ClassificationBenchDetail[];
}

/**
 * Offline classification recall/precision over frozen fixtures. Evaluates the
 * deterministic multilingual terminology layer only — the LLM evaluator is
 * explicitly out of offline scope (network + keys) and reported separately.
 * Zero live calls by construction: isTradingFocusedText is pure.
 */
export function runClassificationRecall(cases: ClassificationBenchCase[]): ClassificationBenchResult {
  const details: ClassificationBenchDetail[] = cases.map(item => {
    const context = getLayeredKnowledgeContext(item.country);
    const predicted = isTradingFocusedText(
      [item.description, ...item.videoTitles].filter(Boolean).join('\n'),
      context,
    )
      ? 'TRADING'
      : 'NON_TRADING';
    return { ...item, predicted, correct: predicted === item.expected };
  });
  const truePositives = details.filter(d => d.predicted === 'TRADING' && d.expected === 'TRADING').length;
  const falsePositives = details.filter(d => d.predicted === 'TRADING' && d.expected === 'NON_TRADING').length;
  const falseNegatives = details.filter(d => d.predicted === 'NON_TRADING' && d.expected === 'TRADING').length;
  return {
    evaluated: details.length,
    correct: details.filter(d => d.correct).length,
    truePositives,
    falsePositives,
    falseNegatives,
    precision: truePositives + falsePositives > 0 ? truePositives / (truePositives + falsePositives) : null,
    recall: truePositives + falseNegatives > 0 ? truePositives / (truePositives + falseNegatives) : null,
    details,
  };
}
