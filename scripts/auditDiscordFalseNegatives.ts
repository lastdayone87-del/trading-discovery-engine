import 'dotenv/config';
import pg from 'pg';

/**
 * Read-only historical audit: channels projected as NOT_FOUND / NOT_DISCOVERED
 * whose inspection trail still carries structured Discord invite evidence.
 * Does not rewrite any records.
 */
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  ssl: process.env.PGSSL === 'disable' ? false : process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined
});

const db = await pool.connect();
try {
  await db.query('BEGIN TRANSACTION READ ONLY');
  const result = await db.query(`
    WITH candidates AS (
      SELECT
        c.channel_id,
        c.channel_name,
        c.discord_status,
        c.discord_discovery_status,
        c.discord_validation_status,
        c.scan_status,
        c.discord_candidate_locator,
        step.elem->>'status' AS step_status,
        step.elem->>'detectedInvite' AS detected_invite,
        step.elem->>'title' AS step_title
      FROM channels c
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(c.inspection_trail, '[]'::jsonb)) AS step(elem)
      WHERE c.discord_status = 'NOT_FOUND'
        AND COALESCE(c.discord_discovery_status, 'NOT_DISCOVERED') = 'NOT_DISCOVERED'
        AND (
          step.elem->>'status' = 'FOUND'
          OR NULLIF(step.elem->>'detectedInvite', '') IS NOT NULL
          OR step.elem->>'details' ILIKE '%discord.gg/%'
          OR step.elem->>'details' ILIKE '%discord.com/invite/%'
          OR step.elem->>'details' ILIKE '%Invite Code%'
        )
    )
    SELECT DISTINCT ON (channel_id)
      channel_id, channel_name, discord_status, discord_discovery_status,
      discord_validation_status, scan_status, discord_candidate_locator,
      step_status, detected_invite, step_title
    FROM candidates
    ORDER BY channel_id, step_status DESC
  `);
  await db.query('ROLLBACK');
  console.log(JSON.stringify({
    report: 'discord-false-negative-audit-v1',
    servingAuthority: false,
    count: result.rowCount,
    channels: result.rows
  }, null, 2));
} catch (error) {
  await db.query('ROLLBACK').catch(() => undefined);
  throw error;
} finally {
  db.release();
  await pool.end();
}
