import { missingGeminiOrgLabels } from './evidenceEngine/providers/GeminiSemanticProvider';
import { missingGroqOrgLabels } from './evidenceEngine/providers/GroqSemanticProvider';

/**
 * Startup advisory for semantic quota separation. Every configured key slot
 * is an independent account/quota pool by default (one key per account), so
 * production boots without any org labels. Explicit GEMINI_ORG_ID[_N] /
 * GROQ_ORG_ID[_N] labels remain supported solely to declare that several
 * keys intentionally share one account/quota pool — those routes then share
 * cooldown fate and never fail over between each other. This check never
 * throws: it logs the unlabeled slots so a future same-account key cannot
 * silently gain independent treatment without the operator noticing.
 */
export function validateSemanticOrgLabels(env: NodeJS.ProcessEnv = process.env): void {
  const missing = [...missingGeminiOrgLabels(env), ...missingGroqOrgLabels(env)];
  if (missing.length > 0) {
    console.warn(
      `[SemanticOrgLabels] No explicit org label for key slot(s): ${missing.join(', ')}. ` +
      'Each is treated as an independent account/quota pool. ' +
      'If any of these keys share an account, set matching GEMINI_ORG_ID[_N] / GROQ_ORG_ID[_N] labels so they share cooldown fate.'
    );
  }
}
