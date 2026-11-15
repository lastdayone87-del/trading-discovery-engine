/**
 * Measured production model defaults.
 *
 * These are the values the deployment must use when the corresponding
 * environment overrides are absent. They are kept in a lightweight module so
 * the production config verifier can check them without importing provider
 * clients or their runtime dependencies.
 */
export const DEFAULT_MULTILINGUAL_CANDIDATE_MODEL = 'gemini-3.5-flash-lite';
export const DEFAULT_MULTILINGUAL_ADJUDICATOR_MODEL = 'gemini-3.5-flash-lite';
export const DEFAULT_GROQ_CANDIDATE_MODEL = 'openai/gpt-oss-20b';

/**
 * The Groq adjudicator remains on the existing fallback model. It is not
 * overridden in production, so changing it here would be a behavior change.
 */
export const DEFAULT_GROQ_ADJUDICATOR_MODEL = 'openai/gpt-oss-120b';
