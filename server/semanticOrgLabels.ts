import { missingGeminiOrgLabels } from './evidenceEngine/providers/GeminiSemanticProvider';
import { missingGroqOrgLabels } from './evidenceEngine/providers/GroqSemanticProvider';

/**
 * Production guardrail for semantic quota separation. Every configured
 * Gemini/Groq key slot must name an explicit org/account label so quota
 * pools are never inferred from key slots: an unlabeled future key from an
 * existing account would otherwise be treated as an independent pool,
 * silently defeating per-org cooldowns and cross-org failover. Slot-based
 * fallback identities remain for tests and local development (where no keys
 * are typically configured), but production refuses to boot without labels.
 */
export function validateSemanticOrgLabels(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== 'production') return;
  const missing = [...missingGeminiOrgLabels(env), ...missingGroqOrgLabels(env)];
  if (missing.length > 0) {
    throw new Error(
      `Explicit org labels required in production for every configured semantic route; missing: ${missing.join(', ')}. ` +
      'Set GEMINI_ORG_ID[_N] / GROQ_ORG_ID[_N] matching each configured key slot so quota pools are declared, never inferred.'
    );
  }
}
