/**
 * Live-PostgreSQL vocabulary race verification (PR #522 follow-up).
 *
 * Proves the advisory-lock serialization and derived occurrence counts of
 * saveExtractedTerm / defaultReconcileExtractedTerm under genuine concurrent
 * connections — the requirement deterministic fakes cannot satisfy.
 *
 * Staging/disposable database only. Requires STAGING_OK=true and a writable
 * DATABASE_URL (or PHASE10_POSTGRES_URL). Migrations must already be applied
 * (npx tsx scripts/runMigrations.ts).
 *
 * Run: STAGING_OK=true DATABASE_URL=<staging> npx tsx scripts/terminologyVocabRace.ts
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { getDb } from '../server/db';
import { observeTerminologyDetailed } from '../server/terminologyIntelligence';
import { saveExtractedTerm } from '../server/dbCore';
import { defaultReconcileExtractedTerm } from '../server/queryIntelligence';

const connectionString = process.env.PHASE10_POSTGRES_URL || process.env.DATABASE_URL;
if (process.env.STAGING_OK !== 'true' || !connectionString) {
  console.error('Refusing to run: set STAGING_OK=true and PHASE10_POSTGRES_URL (or DATABASE_URL) to a writable staging database.');
  process.exit(2);
}

const COUNTRY_ALIAS = 'US';
const COUNTRY_CANON = 'United States';
const TERM = `race probe ${randomUUID().slice(0, 8)}`;
const CHANNELS = ['race-ch-1', 'race-ch-2', 'race-ch-3', 'race-ch-4'];
const OBS_PER_CHANNEL = 1;

let failures = 0;
function check(name: string, cond: boolean, evidence: unknown) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(evidence)}`);
  if (!cond) failures += 1;
}

async function main() {
  process.env.DATABASE_URL = connectionString!;
  const db = await getDb();
  for (const channelId of CHANNELS) {
    await db.query(
      `INSERT INTO channels(channel_id,channel_name,youtube_url,country,country_status,discord_status,scan_status,discovery_source,first_seen,quality_score,trading_status)
       VALUES($1,$1,$2,$3,'CONFIRMED','UNKNOWN','PENDING','vocab-race',now(),90,'TRADING_CONFIRMED')
       ON CONFLICT(channel_id) DO UPDATE SET trading_status='TRADING_CONFIRMED',quality_score=90`,
      [channelId, `https://youtube.com/channel/${channelId}`, COUNTRY_CANON]
    );
  }
  // Committed observation evidence all racers must converge to.
  for (const channelId of CHANNELS) {
    for (let v = 0; v < OBS_PER_CHANNEL; v++) {
      const videoId = `race-${channelId}-v${v}`;
      await observeTerminologyDetailed({
        term: TERM, country: COUNTRY_ALIAS, termType: 'TERMINOLOGY', observationType: 'VIDEO_TITLE',
        channelId, videoId,
        evidence: {
          extractor: 'GEMINI', qualityVersion: 'native-v1', literal: true,
          sourceRef: { kind: 'VIDEO_TITLE', index: 0, span: TERM, videoId, sourceHash: `race-${videoId}` },
          novel: true, knownAs: null, generic: false, spamConfirmed: false, spamSignals: [], translationRisk: null,
        },
      });
    }
  }
  const expected = await db.query(
    `SELECT COUNT(*)::int n FROM terminology_observations o JOIN canonical_trading_terms t ON t.id=o.canonical_term_id
     WHERE t.country=$1 AND t.normalized_term=$2`, [COUNTRY_CANON, TERM.toLowerCase()]
  );
  const expectedCount = Number(expected.rows[0]?.n);
  check('race preconditions committed', expectedCount === CHANNELS.length * OBS_PER_CHANNEL, { expectedCount });

  // Genuine overlap: separate pools so advisory-lock blocking is real.
  const pools = [new pg.Pool({ connectionString }), new pg.Pool({ connectionString })];
  const racers: Array<Promise<unknown>> = [];
  CHANNELS.forEach((channelId, i) => {
    const runner = { query: (text: string, params?: unknown[]) => pools[i % pools.length].query(text, params as unknown[]) };
    racers.push(saveExtractedTerm(COUNTRY_ALIAS, TERM, 'terminology', channelId, runner as never));
    racers.push(saveExtractedTerm(COUNTRY_ALIAS, TERM, 'terminology', channelId, runner as never));
    racers.push(defaultReconcileExtractedTerm(COUNTRY_ALIAS, TERM, 'terminology', channelId, runner as never));
  });
  await Promise.all(racers);
  await Promise.all(pools.map(pool => pool.end()));

  const rows = await db.query(
    `SELECT country,term,occurrences FROM extracted_trading_vocabulary WHERE term=$1`, [TERM]
  );
  check('exactly one vocabulary row', rows.rows.length === 1, rows.rows);
  check('row under canonical country', rows.rows[0]?.country === COUNTRY_CANON, rows.rows[0]);
  check('occurrences converged to committed evidence', Number(rows.rows[0]?.occurrences) === expectedCount, { got: rows.rows[0]?.occurrences, expectedCount });

  console.log(failures === 0 ? 'VOCAB RACE COMPLETE' : `VOCAB RACE FAILED (${failures} checks)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(error => { console.error('VOCAB RACE ERROR', error); process.exit(1); });
