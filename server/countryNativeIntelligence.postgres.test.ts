import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './db';
import { observeTerminology } from './terminologyIntelligence';
import { generateCountryNativeProposals } from './discoveryProposalGenerators';
import { attributeCountryNativePerformance } from './countryNativeIntelligence';

const databaseUrl = process.env.PHASE10_POSTGRES_URL;

test('Phase 10 PostgreSQL: migration, replay, projection persistence, legacy neutrality, and proposal eligibility', {
  skip: databaseUrl ? false : 'PHASE10_POSTGRES_URL is required for PostgreSQL integration coverage'
}, async () => {
  process.env.DATABASE_URL = databaseUrl!;
  process.env.PGSSL = 'disable';
  const db = await getDb();
  const suffix = `${Date.now()}_${process.pid}`;
  const country = `P${String(process.pid).slice(-2)}`;
  const term = `native integration ${suffix}`;
  const channels = [`P10_CREATOR_A_${suffix}`, `P10_CREATOR_B_${suffix}`];

  try {
    const migration = await db.query('SELECT name FROM schema_migrations WHERE version = 106');
    assert.equal(migration.rows[0]?.name, '106_country_native_intelligence.sql');

    const quotaColumn = await db.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'country_native_performance_attribution'
         AND column_name = 'quota_consumed'`
    );
    assert.equal(quotaColumn.rowCount, 1, 'migration 106 must create the snake_case column used by production writes');

    for (const channelId of channels) {
      await db.query(
        `INSERT INTO channels(
           channel_id, channel_name, youtube_url, country, country_status,
           discord_status, scan_status, discovery_source, first_seen,
           quality_score, trading_status
         ) VALUES($1,$1,$2,$3,'CONFIRMED','UNKNOWN','PENDING','phase10-test',now(),90,'TRADING_CONFIRMED')`,
        [channelId, `https://youtube.com/channel/${channelId}`, country]
      );
    }

    const firstId = await observeTerminology({
      term, country, termType: 'TERMINOLOGY', observationType: 'VIDEO_TITLE',
      channelId: channels[0], videoId: `video-a-${suffix}`, locale: 'pt-BR'
    }, db);
    assert.ok(firstId);
    const firstRecency = await db.query('SELECT last_observed_at FROM canonical_trading_terms WHERE id=$1', [firstId]);

    const replayId = await observeTerminology({
      term, country, termType: 'TERMINOLOGY', observationType: 'VIDEO_TITLE',
      channelId: channels[0], videoId: `video-a-${suffix}`, locale: 'pt-BR'
    }, db);
    assert.equal(replayId, firstId);

    const replayState = await db.query(
      `SELECT t.last_observed_at, count(o.id)::int observation_count
       FROM canonical_trading_terms t
       JOIN terminology_observations o ON o.canonical_term_id=t.id
       WHERE t.id=$1 GROUP BY t.id`,
      [firstId]
    );
    assert.equal(replayState.rows[0].observation_count, 1);
    assert.equal(new Date(replayState.rows[0].last_observed_at).toISOString(), new Date(firstRecency.rows[0].last_observed_at).toISOString());

    await observeTerminology({
      term, country, termType: 'TERMINOLOGY', observationType: 'VIDEO_TITLE',
      channelId: channels[1], videoId: `video-b-${suffix}`, locale: 'pt-BR'
    }, db);

    const projection = await db.query(
      `SELECT native_evidence_status, native_observed_count, quality_creator_count,
              native_proposal_eligible, last_observed_at
       FROM country_native_evidence_projections WHERE canonical_term_id=$1`,
      [firstId]
    );
    assert.equal(projection.rows[0].native_evidence_status, 'NATIVE_OBSERVED');
    assert.equal(projection.rows[0].native_observed_count, 2);
    assert.equal(projection.rows[0].quality_creator_count, 2);
    assert.equal(projection.rows[0].native_proposal_eligible, true);

    await attributeCountryNativePerformance({
      canonicalTermId: firstId!, country,
      nativeEvidenceStatus: 'NATIVE_OBSERVED', sourceProvenanceFamily: 'CREATOR_METADATA',
      quotaConsumed: 100, rawResults: 5, uniqueCreators: 2, newCreators: 1
    }, db);
    const attribution = await db.query(
      'SELECT quota_consumed FROM country_native_performance_attribution WHERE canonical_term_id=$1',
      [firstId]
    );
    assert.equal(attribution.rows[0].quota_consumed, 100);

    const legacy = await db.query(
      `INSERT INTO canonical_trading_terms(canonical_term,normalized_term,country,term_type,first_observed_at,last_observed_at)
       VALUES($1,$2,$3,'TERMINOLOGY',now(),now()) RETURNING id`,
      [`legacy ${suffix}`, `legacy ${suffix}`, country]
    );
    await db.query(
      `INSERT INTO terminology_observations(canonical_term_id,observation_type,evidence)
       VALUES($1,'CHANNEL_NAME','{}'::jsonb)`,
      [legacy.rows[0].id]
    );
    const { recomputeNativeEvidenceProjection } = await import('./countryNativeIntelligence');
    assert.equal(await recomputeNativeEvidenceProjection(Number(legacy.rows[0].id), db), null);
    assert.equal((await db.query('SELECT count(*)::int count FROM country_native_evidence_projections WHERE canonical_term_id=$1', [legacy.rows[0].id])).rows[0].count, 0);

    const proposals = await generateCountryNativeProposals(country, 10);
    const persisted = proposals.find(proposal => proposal.supportingEvidence.canonicalTermId === firstId);
    assert.ok(persisted, 'persisted eligible native projection must feed the production proposal generator');
    assert.equal(persisted.supportingEvidence.nativeEvidenceStatus, 'NATIVE_OBSERVED');
  } finally {
    await db.end();
  }
});
