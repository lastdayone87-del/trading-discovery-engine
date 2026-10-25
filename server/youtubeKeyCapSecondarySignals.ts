/**
 * Rolling secondary failure signals for the YouTube per-key cap monitor.
 *
 * `job_attempts` is the single authoritative execution ledger: `failJob`
 * writes the same message to `job_attempts.error` and `jobs.last_error`, so
 * counting both tables would double every ordinary quota failure. A refused
 * cap dispatch never reaches `job_attempts`; those refusals are counted by the
 * durable `youtube_key_cap_refusal_counters` table instead.
 *
 * Structured error codes are persisted by `failJob` as a `CODE: message`
 * prefix. Provider quota errors already carry `quotaExceeded` or
 * `dailyLimitExceeded` in their message, so both forms are matched here.
 */

export interface SecondarySignalQueryClient {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface YouTubeKeyCapSecondarySignals {
  capUnavailable: number;
  quotaExhausted: number;
}

export const READ_SECONDARY_SIGNALS_SQL = `
SELECT
  COUNT(*) FILTER (WHERE error LIKE '%YOUTUBE_KEY_CAP_UNAVAILABLE%')::int AS cap_unavailable,
  COUNT(*) FILTER (WHERE error LIKE '%QUOTA_ALLOCATION_EXHAUSTED%'
                      OR error LIKE '%YOUTUBE_QUOTA_EXCEEDED%'
                      OR error ILIKE '%quota allocation is exhausted%'
                      OR error ILIKE '%quotaExceeded%'
                      OR error ILIKE '%dailyLimitExceeded%')::int AS quota_exhausted
  FROM job_attempts
 WHERE finished_at > $1
   AND error IS NOT NULL
`;

export async function readYouTubeKeyCapSecondarySignals(
  client: SecondarySignalQueryClient,
  windowStart: Date,
): Promise<YouTubeKeyCapSecondarySignals> {
  const result = await client.query(READ_SECONDARY_SIGNALS_SQL, [windowStart]);
  const row = result.rows?.[0] || {};
  return {
    capUnavailable: Number(row.cap_unavailable) || 0,
    quotaExhausted: Number(row.quota_exhausted) || 0,
  };
}
