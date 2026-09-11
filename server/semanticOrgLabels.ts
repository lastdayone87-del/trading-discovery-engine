import { missingGeminiOrgLabels } from './evidenceEngine/providers/GeminiSemanticProvider';

/**
 * Production guardrail for semantic quota separation. Every configured
 * Gemini key slot must name an explicit account label so quota pools are
 * never inferred from key slots. Groq slots are independent accounts by
 * default (one key per org): GROQ_ORG_ID[_N] is optional and only needed to
 * declare that several keys share one org/quota pool, in which case those
 * routes share cooldown fate and never fail over between each other.
 * Slot-based fallback identities remain for tests and local development
 * (where no keys are typically configured), but production refuses to boot
 * without Gemini labels.
 */
export function validateSemanticOrgLabels(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== 'production') return;
  const missing = [...missingGeminiOrgLabels(env)];
  if (missing.length > 0) {
    throw new Error(
      `Explicit org labels required in production for every configured Gemini route; missing: ${missing.join(', ')}. ` +
      'Set GEMINI_ORG_ID[_N] matching each configured key slot so quota pools are declared, never inferred.'
    );
  }
}
