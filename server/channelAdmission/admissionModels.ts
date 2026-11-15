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
 */
export const DEFAULT_ADMISSION_PRIMARY_MODEL = 'gemini-flash-lite-latest';
