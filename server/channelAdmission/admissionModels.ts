/**
 * Admission judge model defaults.
 *
 * The admission judge is deliberately separate from the classification
 * evidence engine: the measured production baseline for admission is
 * `gemini-flash-lite-latest` (sealed 200-channel cohort: precision 100.0%,
 * recall 99.3%, F1 99.6%), while classification remains on
 * `gemini-3.5-flash-lite`.
 *
 * Keep these as code defaults so a bare redeploy cannot silently fall back to
 * the classification model when the Coolify environment override is missing.
 * Operators can still override either value at runtime.
 *
 * `-latest` is a tracked alias. If Google retargets it, re-run the sealed
 * admission cohort and bump `ADMISSION_PROMPT_VERSION` so cached admission
 * judgments do not outlive the model behavior change.
 */
export const DEFAULT_ADMISSION_PRIMARY_MODEL = 'gemini-flash-lite-latest';

/**
 * Admission's Groq fallback is independent of the classification Groq
 * candidate default. Keeping it at 120b preserves the pre-change admission
 * behavior when ADMISSION_SECONDARY_MODEL is unset.
 */
export const DEFAULT_ADMISSION_SECONDARY_MODEL = 'openai/gpt-oss-120b';

export function resolveAdmissionPrimaryModel(env: NodeJS.ProcessEnv = process.env): string {
  return String(env.ADMISSION_PRIMARY_MODEL || '').trim() || DEFAULT_ADMISSION_PRIMARY_MODEL;
}

export function resolveAdmissionSecondaryModel(env: NodeJS.ProcessEnv = process.env): string {
  return String(env.ADMISSION_SECONDARY_MODEL || '').trim() || DEFAULT_ADMISSION_SECONDARY_MODEL;
}
