/**
 * Bounded LLM Assistance (P-E: assistive classification under validators).
 *
 * LLMs may assist ONLY with: page-type classification review, semantic link
 * interpretation, ambiguous navigation decisions, and evidence
 * interpretation — and only through bounded tasks whose outputs are
 * machine-validated before use. The validator rejects anything ungrounded:
 * URLs not present in the task's candidate set, evidence not traceable to
 * provided text spans, missing confidence, or missing rationale. Every task
 * has a deterministic fallback that applies when the gateway is disabled,
 * the task is not allowlisted, budgets are exhausted, or validation fails.
 *
 * Hard prohibitions (enforced by validators + tests, not policy prose):
 * invented URLs, invented evidence, live benchmark tuning, benchmark
 * methodology changes, and serving-path auto-promotion. No live provider
 * is wired here: the gateway interface, budgets, audit, and fallbacks are
 * the complete P-E surface; provider wiring requires separate approval.
 *
 * Budget values below are conservative initial values pending
 * frozen-fixture derivation (TBD-for-planning); tighter is always
 * acceptable, looser requires a separately approved experiment.
 */
import { getAppSetting } from './dbCore';

export const LLM_ASSIST_POLICY_VERSION = 'llm-assist-v1';
export const LLM_ASSIST_SETTING_KEY = 'llm_assist_enabled';

/** Conservative initial bounds (TBD-for-planning). */
export const MAX_LLM_CALLS_PER_INSPECTION = 3;
export const MAX_LLM_INPUT_CHARS = 8000;

export type LlmAssistTask =
  | 'PAGE_TYPE_REVIEW'
  | 'LINK_INTERPRETATION'
  | 'AMBIGUOUS_NAVIGATION'
  | 'EVIDENCE_INTERPRETATION';

export const LLM_ASSIST_TASKS: LlmAssistTask[] = [
  'PAGE_TYPE_REVIEW',
  'LINK_INTERPRETATION',
  'AMBIGUOUS_NAVIGATION',
  'EVIDENCE_INTERPRETATION',
];

export interface LlmAssistInput {
  task: LlmAssistTask;
  /** Candidate URLs the decision may reference. Anything else is invented. */
  candidateUrls: string[];
  /** Text spans the decision may cite as evidence. Anything else is ungrounded. */
  evidenceSpans: string[];
  /** Deterministic baseline the task reviews or extends (never replaced blindly). */
  baseline: string;
  contextUrl: string;
}

export interface LlmAssistDecision {
  task: LlmAssistTask;
  /** Must be a member of input.candidateUrls when set. */
  selectedUrl: string | null;
  /** Every entry must be traceable to input.evidenceSpans. */
  citedEvidence: string[];
  confidence: number;
  rationale: string;
}

export interface LlmValidation {
  valid: boolean;
  reasonCodes: string[];
}

const normalizeUrl = (raw: string): string | null => {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
};

/** Validate one bounded decision. Pure and deterministic. Rejects: unknown
 * task, invented URLs, ungrounded evidence, missing/out-of-range
 * confidence, empty rationale. Never throws on malformed input. */
export function validateLlmDecision(input: LlmAssistInput, decision: Partial<LlmAssistDecision> | null | undefined): LlmValidation {
  const reasonCodes: string[] = [];
  if (!decision || typeof decision !== 'object') return { valid: false, reasonCodes: ['DECISION_MISSING'] };
  if (decision.task !== input.task || !LLM_ASSIST_TASKS.includes(decision.task as LlmAssistTask)) {
    reasonCodes.push('TASK_MISMATCH');
  }
  if (decision.selectedUrl !== null && decision.selectedUrl !== undefined) {
    const selected = normalizeUrl(String(decision.selectedUrl));
    const allowed = new Set(
      input.candidateUrls.map(candidate => normalizeUrl(candidate)).filter((url): url is string => url !== null),
    );
    if (!selected || !allowed.has(selected)) reasonCodes.push('INVENTED_URL');
  }
  const cited = Array.isArray(decision.citedEvidence) ? decision.citedEvidence : null;
  if (!cited) {
    reasonCodes.push('EVIDENCE_MISSING');
  } else {
    for (const entry of cited) {
      if (typeof entry !== 'string' || !input.evidenceSpans.some(span => typeof span === 'string' && span.includes(entry) && entry.length > 0)) {
        reasonCodes.push('UNGROUNDED_EVIDENCE');
        break;
      }
    }
  }
  if (typeof decision.confidence !== 'number' || !Number.isFinite(decision.confidence) || decision.confidence < 0 || decision.confidence > 1) {
    reasonCodes.push('CONFIDENCE_INVALID');
  }
  if (typeof decision.rationale !== 'string' || !decision.rationale.trim()) {
    reasonCodes.push('RATIONALE_MISSING');
  }
  return { valid: reasonCodes.length === 0, reasonCodes };
}

export interface LlmAssistCall {
  task: LlmAssistTask;
  contextUrl: string;
  outcome: 'APPLIED' | 'REJECTED' | 'FALLBACK';
  reasonCodes: string[];
  at: string;
}

/** Policy gate for one assistance call. Closed unless: gateway enabled,
 * task allowlisted, per-inspection call budget remaining, and inputs fit
 * the char budget. Pure given its inputs; the caller supplies counts. */
export function evaluateLlmAssistGate(input: {
  enabled: boolean;
  allowlistedTasks: LlmAssistTask[];
  task: LlmAssistTask;
  callsUsed: number;
  inputChars: number;
}): { allowed: boolean; reasonCodes: string[] } {
  const reasonCodes: string[] = [];
  if (!input.enabled) reasonCodes.push('GATEWAY_DISABLED');
  if (!input.allowlistedTasks.includes(input.task)) reasonCodes.push('TASK_NOT_ALLOWLISTED');
  if (input.callsUsed >= MAX_LLM_CALLS_PER_INSPECTION) reasonCodes.push('CALL_BUDGET_EXHAUSTED');
  if (input.inputChars > MAX_LLM_INPUT_CHARS) reasonCodes.push('INPUT_OVER_BUDGET');
  return { allowed: reasonCodes.length === 0, reasonCodes };
}

export async function isLlmAssistEnabled(
  readSetting: (key: string, fallback: string) => Promise<string> = getAppSetting,
): Promise<boolean> {
  return (await readSetting(LLM_ASSIST_SETTING_KEY, 'false')) === 'true';
}
