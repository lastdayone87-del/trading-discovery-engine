import test from 'node:test';
import assert from 'node:assert/strict';
import { completeQueryRun, getChannelById, getDb, upsertChannel } from './db';
import { observeTerminology } from './terminologyIntelligence';
import { buildFrontierProposal, generateCountryNativeProposals, persistFrontierProposals } from './discoveryProposalGenerators';
import { attributeCountryNativePerformance } from './countryNativeIntelligence';
import { recomputeNativeEvidenceProjection, refreshCountryNativeProjectionsForCreator } from './countryNativeIntelligence';
import { quarantineUnexecutableAllocation } from './discoveryFrontierAllocator';

const databaseUrl = process.env.PHASE10_POSTGRES_URL;

test('Phase 10 PostgreSQL concurrency: canonical-term serialization converges creator and observation races', {
  skip: databaseUrl ? false : 'PHASE10_POSTGRES_URL is required for PostgreSQL concurrency coverage'
}, async () => {
  process.env.DATABASE_URL = databaseUrl!;
  process.env.PGSSL = 'disable';
  const db = await getDb();
  const suffix = `race_${Date.now()}_${process.pid}`;
  const country = `R${String(process.pid).slice(-2)}`;
  const creatorA = `RACE_A_${suffix}`;
  const creatorB = `RACE_B_${suffix}`;
  let termId = 0;
  try {
    for (const channelId of [creatorA, creatorB]) {
      await db.query(`INSERT INTO channels(channel_id,channel_name,youtube_url,country,country_status,discord_status,scan_status,discovery_source,first_seen,quality_score,trading_status)
        VALUES($1,$1,$2,$3,'CONFIRMED','UNKNOWN','PENDING','phase10-race',now(),90,'TRADING_CONFIRMED')`,
      [channelId, `https://youtube.com/channel/${channelId}`, country]);
    }
    termId = Number(await observeTerminology({ term: `serialized ${suffix}`, country, termType: 'TERMINOLOGY', observationType: 'VIDEO_TITLE', channelId: creatorA, videoId: `${suffix}-a` }, db));
    await observeTerminology({ term: `serialized ${suffix}`, country, termType: 'TERMINOLOGY', observationType: 'VIDEO_TITLE', channelId: creatorB, videoId: `${suffix}-b` }, db);

    // Hold the canonical authority while committing a downgrade. A recompute
    // already started on another connection must wait and then read the commit.
    const mutator = await db.connect();
    await mutator.query('BEGIN');
    await mutator.query('SELECT id FROM canonical_trading_terms WHERE id=$1 FOR UPDATE', [termId]);
    await mutator.query("UPDATE channels SET quality_score=10 WHERE channel_id=$1", [creatorA]);
    const waitingRecompute = recomputeNativeEvidenceProjection(termId, db);
    await new Promise(resolve => setTimeout(resolve, 50));
    await mutator.query('COMMIT');
    mutator.release();
    await waitingRecompute;
    assert.equal((await db.query('SELECT native_quality_creator_count FROM country_native_evidence_projections WHERE canonical_term_id=$1', [termId])).rows[0].native_quality_creator_count, 1,
      'an observation-side recompute cannot overwrite the committed downgrade with an old aggregate');

    // Opposite creator classifications serialize on the same canonical term;
    // the transaction that commits last is reflected by the final projection.
    const down = await db.connect();
    const up = await db.connect();
    await down.query('BEGIN');
    await down.query("UPDATE channels SET quality_score=10 WHERE channel_id=$1", [creatorB]);
    await refreshCountryNativeProjectionsForCreator(creatorB, down);
    const restore = (async () => {
      await up.query('BEGIN');
      await up.query("UPDATE channels SET quality_score=90 WHERE channel_id=$1", [creatorB]);
      await refreshCountryNativeProjectionsForCreator(creatorB, up);
      await up.query('COMMIT');
    })();
    await new Promise(resolve => setTimeout(resolve, 50));
    await down.query('COMMIT');
    await restore;
    down.release(); up.release();
    assert.equal((await db.query('SELECT native_quality_creator_count FROM country_native_evidence_projections WHERE canonical_term_id=$1', [termId])).rows[0].native_quality_creator_count, 1,
      'the last authoritative creator classification is reflected (A down, B restored)');

    // Concurrent append-only observations remain deterministic and the maximum
    // observation id is the durable evidence revision.
    await db.query("UPDATE channels SET quality_score=90 WHERE channel_id=ANY($1::text[])", [[creatorA, creatorB]]);
    await Promise.all([
      observeTerminology({ term: `concurrent ${suffix}`, country, termType: 'TERMINOLOGY', observationType: 'VIDEO_TITLE', channelId: creatorA, videoId: `${suffix}-c` }, db),
      observeTerminology({ term: `concurrent ${suffix}`, country, termType: 'TERMINOLOGY', observationType: 'VIDEO_TITLE', channelId: creatorB, videoId: `${suffix}-d` }, db)
    ]);
    const concurrent = await db.query(`SELECT p.raw_observation_count,p.evidence_revision,max(o.id)::text max_revision,t.last_observed_at
      FROM canonical_trading_terms t JOIN country_native_evidence_projections p ON p.canonical_term_id=t.id
      JOIN terminology_observations o ON o.canonical_term_id=t.id WHERE t.normalized_term=$1 AND t.country=$2 GROUP BY p.raw_observation_count,p.evidence_revision,t.last_observed_at`,
    [`concurrent ${suffix}`, country]);
    assert.equal(concurrent.rows[0].raw_observation_count, 2);
    assert.equal(String(concurrent.rows[0].evidence_revision), concurrent.rows[0].max_revision);
    assert.ok(concurrent.rows[0].last_observed_at);
  } finally {
    await db.query('DELETE FROM terminology_observations WHERE canonical_term_id IN (SELECT id FROM canonical_trading_terms WHERE country=$1)', [country]).catch(() => undefined);
    await db.query('DELETE FROM country_native_evidence_projections WHERE country=$1', [country]).catch(() => undefined);
    await db.query('DELETE FROM canonical_trading_terms WHERE country=$1', [country]).catch(() => undefined);
    await db.query('DELETE FROM channels WHERE channel_id=ANY($1::text[])', [[creatorA, creatorB]]).catch(() => undefined);
  }
});

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
      `SELECT native_evidence_status, native_observed_count, quality_creator_count, native_quality_creator_count,
              native_proposal_eligible, last_observed_at
       FROM country_native_evidence_projections WHERE canonical_term_id=$1`,
      [firstId]
    );
    assert.equal(projection.rows[0].native_evidence_status, 'NATIVE_OBSERVED');
    assert.equal(projection.rows[0].native_observed_count, 2);
    assert.equal(projection.rows[0].quality_creator_count, 2);
    assert.equal(projection.rows[0].native_quality_creator_count, 2);
    assert.equal(projection.rows[0].native_proposal_eligible, true);

    const reclassified = await getChannelById(channels[0]);
    assert.ok(reclassified);
    reclassified!.quality_score = 50;
    await upsertChannel(reclassified!);
    let refreshedQuality = await db.query(
      `SELECT native_quality_creator_count,native_proposal_eligible,updated_at FROM country_native_evidence_projections WHERE canonical_term_id=$1`,
      [firstId]
    );
    assert.equal(refreshedQuality.rows[0].native_quality_creator_count, 1, '56+ to 50 removes native quality qualification');
    assert.equal(refreshedQuality.rows[0].native_proposal_eligible, false);

    reclassified!.quality_score = 54;
    await upsertChannel(reclassified!);
    reclassified!.quality_score = 55;
    await upsertChannel(reclassified!);
    refreshedQuality = await db.query(
      `SELECT native_quality_creator_count,native_proposal_eligible,updated_at FROM country_native_evidence_projections WHERE canonical_term_id=$1`,
      [firstId]
    );
    assert.equal(refreshedQuality.rows[0].native_quality_creator_count, 2, '54 to 55 adds native quality qualification');
    assert.equal(refreshedQuality.rows[0].native_proposal_eligible, true);

    reclassified!.trading_status = 'NON_TRADING';
    await upsertChannel(reclassified!);
    refreshedQuality = await db.query(
      `SELECT native_quality_creator_count,native_proposal_eligible,updated_at FROM country_native_evidence_projections WHERE canonical_term_id=$1`,
      [firstId]
    );
    assert.equal(refreshedQuality.rows[0].native_quality_creator_count, 1, 'trading-confirmed to non-trading removes qualification');
    const affectedUpdatedAt = new Date(refreshedQuality.rows[0].updated_at).toISOString();

    const unrelatedId = `P10_UNRELATED_${suffix}`;
    await db.query(
      `INSERT INTO channels(channel_id,channel_name,youtube_url,country,country_status,discord_status,scan_status,discovery_source,first_seen,quality_score,trading_status)
       VALUES($1,$1,$2,$3,'CONFIRMED','UNKNOWN','PENDING','phase10-test',now(),90,'TRADING_CONFIRMED')`,
      [unrelatedId, `https://youtube.com/channel/${unrelatedId}`, country]
    );
    const unrelated = await getChannelById(unrelatedId);
    unrelated!.quality_score = 10;
    await upsertChannel(unrelated!);
    assert.equal(new Date((await db.query('SELECT updated_at FROM country_native_evidence_projections WHERE canonical_term_id=$1',[firstId])).rows[0].updated_at).toISOString(), affectedUpdatedAt,
      'unrelated creator reclassification must not touch the projection');

    reclassified!.trading_status = 'TRADING_CONFIRMED';
    await upsertChannel(reclassified!);
    assert.equal((await db.query('SELECT native_quality_creator_count FROM country_native_evidence_projections WHERE canonical_term_id=$1',[firstId])).rows[0].native_quality_creator_count, 2);

    await attributeCountryNativePerformance({
      attributionKey: `native-attribution:${firstId}:run-1`,
      canonicalTermId: firstId!, country,
      nativeEvidenceStatus: 'NATIVE_OBSERVED', sourceProvenanceFamily: 'CREATOR_METADATA',
      quotaConsumed: 100, rawResults: 5, uniqueCreators: 2, newCreators: 1
    }, db);
    await attributeCountryNativePerformance({
      attributionKey: `native-attribution:${firstId}:run-1`,
      canonicalTermId: firstId!, country,
      nativeEvidenceStatus: 'NATIVE_OBSERVED', sourceProvenanceFamily: 'CREATOR_METADATA',
      quotaConsumed: 100, rawResults: 5, uniqueCreators: 2, newCreators: 1
    }, db);
    const attribution = await db.query(
      'SELECT count(*)::int count, max(quota_consumed)::int quota_consumed FROM country_native_performance_attribution WHERE canonical_term_id=$1',
      [firstId]
    );
    assert.equal(attribution.rows[0].count, 1, 'exact attribution replay must not double-count one query run');
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
    assert.equal(persisted.supportingEvidence.nativeQualityCreatorCount, 2, 'persisted proposal evidence uses the production quality definition');

    const governedTerm = await db.query(
      `INSERT INTO canonical_trading_terms(canonical_term,normalized_term,country,term_type,first_observed_at,last_observed_at)
       VALUES($1,$1,$2,'TERMINOLOGY',now(),now()) RETURNING id`,
      [`governed downgrade ${suffix}`, country]
    );
    await db.query(
      `INSERT INTO terminology_observations(canonical_term_id,observation_type,evidence,native_evidence_status,source_provenance_family)
       VALUES($1,'ENRICHMENT','{}'::jsonb,'BOOTSTRAP_SEED','COUNTRY_VOCABULARY')`,
      [governedTerm.rows[0].id]
    );
    for (const channelId of channels) {
      await db.query(
        `INSERT INTO terminology_observations(canonical_term_id,source_channel_id,observation_type,evidence,native_evidence_status,source_provenance_family)
         VALUES($1,$2,'VIDEO_TITLE','{}'::jsonb,'NATIVE_OBSERVED','CREATOR_METADATA')`,
        [governedTerm.rows[0].id, channelId]
      );
    }
    await recomputeNativeEvidenceProjection(Number(governedTerm.rows[0].id), db);
    const governedNative = (await generateCountryNativeProposals(country, 30)).find(p => p.supportingEvidence.canonicalTermId === Number(governedTerm.rows[0].id));
    assert.equal(governedNative?.supportingEvidence.nativeEvidenceStatus, 'NATIVE_OBSERVED');
    await persistFrontierProposals([governedNative!]);
    reclassified!.quality_score = 50;
    await upsertChannel(reclassified!);
    let governedStored = await db.query('SELECT trial_status,supporting_evidence FROM frontier_discovery_proposals WHERE dedup_key=$1',[governedNative!.dedupKey]);
    assert.equal(governedStored.rows[0].trial_status, 'DISABLED', 'stale native tier is immediately non-allocatable');
    assert.equal(await persistFrontierProposals([governedNative!]), 0, 'stale materialization cannot resurrect a proposal disabled by newer projection state');
    assert.equal((await db.query('SELECT trial_status FROM frontier_discovery_proposals WHERE dedup_key=$1',[governedNative!.dedupKey])).rows[0].trial_status, 'DISABLED');
    const governedBootstrap = (await generateCountryNativeProposals(country, 30)).find(p => p.supportingEvidence.canonicalTermId === Number(governedTerm.rows[0].id));
    assert.equal(governedBootstrap?.supportingEvidence.nativeEvidenceStatus, 'BOOTSTRAP_SEED');
    assert.equal(governedBootstrap?.dedupKey, governedNative?.dedupKey);
    await persistFrontierProposals([governedBootstrap!]);
    governedStored = await db.query('SELECT trial_status,supporting_evidence FROM frontier_discovery_proposals WHERE dedup_key=$1',[governedNative!.dedupKey]);
    assert.equal(governedStored.rows[0].trial_status, 'PENDING');
    assert.equal(governedStored.rows[0].supporting_evidence.nativeEvidenceStatus, 'BOOTSTRAP_SEED');
    reclassified!.quality_score = 55;
    await upsertChannel(reclassified!);
    const governedRestored = (await generateCountryNativeProposals(country, 30)).find(p => p.supportingEvidence.canonicalTermId === Number(governedTerm.rows[0].id));
    await persistFrontierProposals([governedRestored!]);
    governedStored = await db.query('SELECT trial_status,supporting_evidence FROM frontier_discovery_proposals WHERE dedup_key=$1',[governedNative!.dedupKey]);
    assert.equal(governedStored.rows[0].trial_status, 'PENDING');
    assert.equal(governedStored.rows[0].supporting_evidence.nativeEvidenceStatus, 'NATIVE_OBSERVED');

    const staleWithoutRow = governedRestored!;
    await db.query('DELETE FROM frontier_discovery_proposals WHERE dedup_key=$1',[staleWithoutRow.dedupKey]);
    reclassified!.quality_score = 50;
    await upsertChannel(reclassified!);
    assert.equal(await persistFrontierProposals([staleWithoutRow]), 0, 'stale projection cannot insert a new PENDING proposal after downgrade');
    assert.equal((await db.query('SELECT count(*)::int count FROM frontier_discovery_proposals WHERE dedup_key=$1',[staleWithoutRow.dedupKey])).rows[0].count, 0);
    const bootstrapAfterMissingRow = (await generateCountryNativeProposals(country, 30)).find(p => p.supportingEvidence.canonicalTermId === Number(governedTerm.rows[0].id));
    await persistFrontierProposals([bootstrapAfterMissingRow!]);
    reclassified!.quality_score = 55;
    await upsertChannel(reclassified!);
    const nativeAfterMissingRow = (await generateCountryNativeProposals(country, 30)).find(p => p.supportingEvidence.canonicalTermId === Number(governedTerm.rows[0].id));
    await persistFrontierProposals([nativeAfterMissingRow!]);

    await db.query(`UPDATE frontier_discovery_proposals SET trial_status='TRIED' WHERE dedup_key=$1`,[governedNative!.dedupKey]);
    reclassified!.quality_score = 50;
    await upsertChannel(reclassified!);
    const triedBootstrap = (await generateCountryNativeProposals(country, 30)).find(p => p.supportingEvidence.canonicalTermId === Number(governedTerm.rows[0].id));
    await persistFrontierProposals([triedBootstrap!]);
    assert.equal((await db.query('SELECT trial_status FROM frontier_discovery_proposals WHERE dedup_key=$1',[governedNative!.dedupKey])).rows[0].trial_status, 'TRIED');
    reclassified!.quality_score = 55;
    await upsertChannel(reclassified!);
    const triedNative = (await generateCountryNativeProposals(country, 30)).find(p => p.supportingEvidence.canonicalTermId === Number(governedTerm.rows[0].id));
    await persistFrontierProposals([triedNative!]);
    assert.equal((await db.query('SELECT trial_status FROM frontier_discovery_proposals WHERE dedup_key=$1',[governedNative!.dedupKey])).rows[0].trial_status, 'TRIED', 'native restoration cannot resurrect a consumed trial');

    await db.query(`UPDATE frontier_discovery_proposals SET trial_status='EXPIRED' WHERE dedup_key=$1`,[governedNative!.dedupKey]);
    reclassified!.quality_score = 50;
    await upsertChannel(reclassified!);
    await persistFrontierProposals([(await generateCountryNativeProposals(country, 30)).find(p => p.supportingEvidence.canonicalTermId === Number(governedTerm.rows[0].id))!]);
    reclassified!.quality_score = 55;
    await upsertChannel(reclassified!);
    await persistFrontierProposals([(await generateCountryNativeProposals(country, 30)).find(p => p.supportingEvidence.canonicalTermId === Number(governedTerm.rows[0].id))!]);
    assert.equal((await db.query('SELECT trial_status FROM frontier_discovery_proposals WHERE dedup_key=$1',[governedNative!.dedupKey])).rows[0].trial_status, 'EXPIRED', 'expired proposal cannot be resurrected by evidence refresh');

    const revisionTerm = await db.query(
      `INSERT INTO canonical_trading_terms(canonical_term,normalized_term,country,term_type,first_observed_at,last_observed_at)
       VALUES($1,$1,$2,'TERMINOLOGY',$3,$3) RETURNING id`,
      [`revision term ${suffix}`, country, '2026-08-20T10:00:00.000Z']
    );
    for (const channelId of channels) {
      await db.query(
        `INSERT INTO terminology_observations(
           canonical_term_id,source_channel_id,observation_type,observed_at,evidence,
           native_evidence_status,source_provenance_family,is_code_switched,code_switch_type
         ) VALUES($1,$2,'VIDEO_TITLE',$3,'{}'::jsonb,'NATIVE_OBSERVED','CREATOR_METADATA',false,'NONE')`,
        [revisionTerm.rows[0].id, channelId, '2026-08-20T10:00:00.000Z']
      );
    }
    await recomputeNativeEvidenceProjection(Number(revisionTerm.rows[0].id), db);
    const causalProposalA = (await generateCountryNativeProposals(country, 20)).find(p => p.supportingEvidence.canonicalTermId === Number(revisionTerm.rows[0].id));
    assert.ok(causalProposalA);
    await persistFrontierProposals([causalProposalA!]);
    await db.query(
      `INSERT INTO terminology_observations(
         canonical_term_id,observation_type,observed_at,evidence,native_evidence_status,
         source_provenance_family,is_code_switched,code_switch_type
       ) VALUES($1,'ENRICHMENT',$2,'{}'::jsonb,'NATIVE_OBSERVED','STRUCTURED_LOCAL_ENTITY',true,'NATIVE_DOMINANT_ENGLISH_FINANCE')`,
      [revisionTerm.rows[0].id, '2026-08-20T10:00:00.000Z']
    );
    await recomputeNativeEvidenceProjection(Number(revisionTerm.rows[0].id), db);
    const causalProposalB = (await generateCountryNativeProposals(country, 20)).find(p => p.supportingEvidence.canonicalTermId === Number(revisionTerm.rows[0].id));
    assert.ok(causalProposalB);
    assert.equal(causalProposalB!.supportingEvidence.lastObservedAt, causalProposalA!.supportingEvidence.lastObservedAt);
    assert.ok(BigInt(String(causalProposalB!.supportingEvidence.evidenceRevision)) > BigInt(String(causalProposalA!.supportingEvidence.evidenceRevision)));
    assert.equal(await persistFrontierProposals([causalProposalB!]), 1);
    assert.equal(await persistFrontierProposals([causalProposalA!]), 0, 'lower append-only observation revision cannot overwrite equal-time evidence');
    const causalWinner = await db.query(
      `SELECT supporting_evidence FROM frontier_discovery_proposals WHERE dedup_key=$1`,
      [causalProposalB!.dedupKey]
    );
    assert.equal(causalWinner.rows[0].supporting_evidence.evidenceRevision, causalProposalB!.supportingEvidence.evidenceRevision);
    assert.equal(causalWinner.rows[0].supporting_evidence.structuredEntityMatched, true);
    assert.equal(causalWinner.rows[0].supporting_evidence.isCodeSwitched, true);

    const bootstrap = buildFrontierProposal({
      proposalFamily: 'COUNTRY_NATIVE', country, concept: term,
      sourceProvenance: `bootstrap_vocabulary:static_seed:${term}`,
      supportingEvidence: {
        provenanceType: 'bootstrap_vocabulary', nativeEvidenceStatus: 'BOOTSTRAP_SEED',
        sourceProvenanceFamily: 'STATIC_BOOTSTRAP', nativeTerm: term, market: country
      },
      confidence: 0.4, noveltyRationale: 'bootstrap first'
    });
    const currentPersisted = (await generateCountryNativeProposals(country, 30)).find(
      proposal => proposal.supportingEvidence.canonicalTermId === firstId
    );
    assert.ok(currentPersisted);
    await persistFrontierProposals([bootstrap]);
    await persistFrontierProposals([currentPersisted!]);
    await persistFrontierProposals([bootstrap]);
    const upgraded = await db.query(
      `SELECT count(*)::int count, max(source_provenance) source_provenance,
              max(supporting_evidence->>'nativeEvidenceStatus') native_status,
              max(confidence)::float confidence
       FROM frontier_discovery_proposals WHERE dedup_key=$1`,
      [bootstrap.dedupKey]
    );
    assert.equal(upgraded.rows[0].count, 1);
    assert.equal(upgraded.rows[0].native_status, 'NATIVE_OBSERVED');
    assert.match(upgraded.rows[0].source_provenance, /^observed_native_evidence:/);
    assert.ok(Math.abs(upgraded.rows[0].confidence - currentPersisted!.confidence) < 1e-6);
    assert.equal(await persistFrontierProposals([currentPersisted!]), 0, 'exact authoritative proposal replay remains a no-op');

    const query = await db.query(
      `INSERT INTO query_library(query,normalized_query,country,collection,intent)
       VALUES($1,$1,$2,'EXPERIMENTAL','GENERAL') RETURNING id`,
      [`native production ${suffix}`, country]
    );
    const run = await db.query(
      `INSERT INTO query_runs(query_id,country,source,selection_strategy,selection_reason,status)
       VALUES($1,$2,'automated_query','UCB1_EXPLORATION','phase10 integration','RUNNING') RETURNING id`,
      [query.rows[0].id, country]
    );
    const proposal = await db.query(
      `INSERT INTO frontier_discovery_proposals(
         dedup_key,proposal_family,country,concept,target_dimensions,source_provenance,
         supporting_evidence,novelty_rationale
       ) VALUES($1,'COUNTRY_NATIVE',$2,$3,'{}'::jsonb,$4,$5,$6) RETURNING proposal_id`,
      [`phase10:${suffix}`, country, term, `native:${suffix}`, JSON.stringify({
        canonicalTermId: firstId, nativeEvidenceStatus: 'NATIVE_OBSERVED',
        sourceProvenanceFamily: 'CREATOR_METADATA', isCodeSwitched: true, structuredEntityMatched: true,
        nativeQualityCreatorCount: 1
      }), 'phase10 integration']
    );
    await db.query(
      `INSERT INTO frontier_allocation_decisions(
         decision_id,opportunity_key,allocation_origin,decision_status,selected_country,
         frontier_state,proposal_id,quota_day,policy_version,query_run_id,proposal_evidence_snapshot
       ) VALUES($1,$2,'FRONTIER_CANARY','COMMITTED',$3,'PRODUCTIVE',$4,'2026-08-20','phase10-test',$5,$6)`,
      [`decision:${suffix}`, `opportunity:${suffix}`, country, proposal.rows[0].proposal_id, run.rows[0].id,
        JSON.stringify({ proposalFamily: 'COUNTRY_NATIVE', supportingEvidence: {
          canonicalTermId: firstId, nativeEvidenceStatus: 'NATIVE_OBSERVED',
          sourceProvenanceFamily: 'CREATOR_METADATA', isCodeSwitched: true, structuredEntityMatched: true,
          nativeQualityCreatorCount: 1
        } })]
    );
    const immutableSnapshot = (await db.query(
      'SELECT proposal_evidence_snapshot FROM frontier_allocation_decisions WHERE decision_id=$1',
      [`decision:${suffix}`]
    )).rows[0].proposal_evidence_snapshot;
    reclassified!.quality_score = 50;
    await upsertChannel(reclassified!);
    assert.deepEqual((await db.query(
      'SELECT proposal_evidence_snapshot FROM frontier_allocation_decisions WHERE decision_id=$1',
      [`decision:${suffix}`]
    )).rows[0].proposal_evidence_snapshot, immutableSnapshot, 'committed allocation snapshot remains immutable after creator reclassification');
    assert.equal((await generateCountryNativeProposals(country, 20)).some(p => p.supportingEvidence.canonicalTermId === firstId), false,
      'subsequent proposal generation observes the refreshed underqualified projection');
    const downgradedStructuredProposal = (await generateCountryNativeProposals(country, 20)).find(
      p => p.supportingEvidence.canonicalTermId === Number(revisionTerm.rows[0].id)
    );
    assert.equal(downgradedStructuredProposal?.supportingEvidence.nativeQualityCreatorCount, 1);
    await persistFrontierProposals([downgradedStructuredProposal!]);
    assert.equal((await db.query(
      'SELECT supporting_evidence FROM frontier_discovery_proposals WHERE dedup_key=$1',
      [downgradedStructuredProposal!.dedupKey]
    )).rows[0].supporting_evidence.nativeQualityCreatorCount, 1);
    reclassified!.quality_score = 55;
    await upsertChannel(reclassified!);
    const subsequentProposal = (await generateCountryNativeProposals(country, 20)).find(
      p => p.supportingEvidence.canonicalTermId === Number(revisionTerm.rows[0].id)
    );
    assert.equal(subsequentProposal?.supportingEvidence.nativeQualityCreatorCount, 2,
      'subsequent proposal evidence uses the refreshed qualifying classification');
    await persistFrontierProposals([subsequentProposal!]);
    const refreshedPersistedProposal = await db.query(
      `SELECT trial_status,supporting_evidence FROM frontier_discovery_proposals WHERE dedup_key=$1`,
      [subsequentProposal!.dedupKey]
    );
    assert.equal(refreshedPersistedProposal.rows[0].trial_status, 'PENDING');
    assert.equal(refreshedPersistedProposal.rows[0].supporting_evidence.nativeQualityCreatorCount, 2,
      'future Phase 8 allocation reads refreshed persisted evidence');
    await db.query(`UPDATE frontier_discovery_proposals SET supporting_evidence=$2 WHERE proposal_id=$1`, [
      proposal.rows[0].proposal_id, JSON.stringify({ canonicalTermId: null, nativeEvidenceStatus: 'TRANSLATED_SEED', sourceProvenanceFamily: 'TRANSLATED_QUERY' })
    ]);
    await db.query(
      `INSERT INTO channel_sightings(
         query_run_id,query_id,channel_id,result_rank,search_lane,page_number,was_known,persisted,
         country_outcome,trading_outcome,funnel_outcome,metadata
       ) VALUES
         ($1,$2,$3,1,'VIDEO',1,false,true,'CONFIRMED','TRADING_CONFIRMED','TRADING_CONFIRMED','{}'::jsonb),
         ($1,$2,$4,2,'VIDEO',1,false,true,'CONFIRMED','NEEDS_REVIEW','NEEDS_REVIEW','{}'::jsonb)`,
      [run.rows[0].id, query.rows[0].id, channels[0], channels[1]]
    );
    const completedMetrics = {
      rawResults: 3, distinctResults: 2, duplicateResults: 1, knownChannels: 0,
      newChannels: 2, countryRejected: 0, nonTrading: 0, uncertain: 0, needsReview: 1,
      tradingConfirmed: 1, uniqueChannels: 2, qualityChannels: 1,
      communitiesDiscovered: 0, quotaUsed: 100
    };
    await completeQueryRun(run.rows[0].id, completedMetrics);
    const productionAttribution = await db.query(
      `SELECT count(*)::int count, max(query_id)::int query_id, max(query_run_id::text) query_run_id,
              max(proposal_id::text) proposal_id, max(relevant_new_creators)::int relevant,
              max(quality_creators)::int quality, max(quota_consumed)::int quota,
              max(native_evidence_status) native_status, max(source_provenance_family) provenance_family,
              max(canonical_term_id)::int canonical_term_id,
              bool_or(structured_entity_matched) structured_entity_matched
       FROM country_native_performance_attribution WHERE query_run_id=$1`,
      [run.rows[0].id]
    );
    assert.equal(productionAttribution.rows[0].count, 1);
    assert.equal(productionAttribution.rows[0].query_id, query.rows[0].id);
    assert.equal(productionAttribution.rows[0].query_run_id, run.rows[0].id);
    assert.equal(productionAttribution.rows[0].proposal_id, proposal.rows[0].proposal_id);
    assert.equal(productionAttribution.rows[0].relevant, 2);
    assert.equal(productionAttribution.rows[0].quality, 1);
    assert.equal(productionAttribution.rows[0].quota, 100);
    assert.equal(productionAttribution.rows[0].native_status, 'NATIVE_OBSERVED');
    assert.equal(productionAttribution.rows[0].provenance_family, 'CREATOR_METADATA');
    assert.equal(productionAttribution.rows[0].canonical_term_id, firstId);
    assert.equal(productionAttribution.rows[0].structured_entity_matched, true);
    await completeQueryRun(run.rows[0].id, { ...completedMetrics, rawResults: 999, quotaUsed: 1 });
    const completionReplayState = await db.query(
      `SELECT r.raw_results,r.quota_used,count(a.id)::int attribution_count,max(a.raw_results)::int attributed_raw
       FROM query_runs r LEFT JOIN country_native_performance_attribution a ON a.query_run_id=r.id
       WHERE r.id=$1 GROUP BY r.id`, [run.rows[0].id]
    );
    assert.equal(completionReplayState.rows[0].raw_results, completedMetrics.rawResults, 'completion is first-terminal-write wins');
    assert.equal(completionReplayState.rows[0].quota_used, completedMetrics.quotaUsed);
    assert.equal(completionReplayState.rows[0].attribution_count, 1, 'attribution uses the same first-write replay policy');
    assert.equal(completionReplayState.rows[0].attributed_raw, completedMetrics.rawResults);

    const invalidProposal = await db.query(
      `INSERT INTO frontier_discovery_proposals(dedup_key,proposal_family,country,concept,target_dimensions,source_provenance,supporting_evidence,novelty_rationale)
       VALUES($1,'COUNTRY_NATIVE',$2,$3,'{}'::jsonb,'phase10-invalid','{}'::jsonb,'invalid construction regression') RETURNING proposal_id`,
      [`invalid:${suffix}`, country, `too many tokens for native ${suffix}`]
    );
    await db.query(
      `INSERT INTO frontier_allocation_decisions(decision_id,opportunity_key,allocation_origin,decision_status,selected_country,frontier_state,proposal_id,quota_day,policy_version)
       VALUES($1,$2,'FRONTIER_CANARY','RESERVED',$3,'UNEXPLORED',$4,'2026-08-20','phase10-test')`,
      [`invalid-decision:${suffix}`, `invalid-opportunity:${suffix}`, country, invalidProposal.rows[0].proposal_id]
    );
    assert.equal(await quarantineUnexecutableAllocation(`invalid-decision:${suffix}`, 'unconstructable regression'), true);
    const quarantine = await db.query(
      `SELECT d.decision_status,d.quota_reserved,p.trial_status
       FROM frontier_allocation_decisions d JOIN frontier_discovery_proposals p ON p.proposal_id=d.proposal_id
       WHERE d.decision_id=$1`, [`invalid-decision:${suffix}`]
    );
    assert.deepEqual(quarantine.rows[0], { decision_status: 'DEFERRED', quota_reserved: 0, trial_status: 'EXPIRED' });
    assert.equal(await quarantineUnexecutableAllocation(`invalid-decision:${suffix}`, 'retry'), false,
      'terminal quarantine is exact-replay idempotent');

    await assert.rejects(
      db.query(`UPDATE frontier_allocation_decisions SET proposal_evidence_snapshot='{}'::jsonb WHERE decision_id=$1`, [`decision:${suffix}`]),
      /immutable after allocation/
    );
    const laterRun = await db.query(
      `INSERT INTO query_runs(query_id,country,source,selection_strategy,selection_reason,status)
       VALUES($1,$2,'automated_query','UCB1_EXPLORATION','phase10 later allocation','RUNNING') RETURNING id`,
      [query.rows[0].id, country]
    );
    await db.query(
      `INSERT INTO frontier_allocation_decisions(
         decision_id,opportunity_key,allocation_origin,decision_status,selected_country,
         frontier_state,proposal_id,quota_day,policy_version,query_run_id,proposal_evidence_snapshot
       ) VALUES($1,$2,'FRONTIER_CANARY','COMMITTED',$3,'PRODUCTIVE',$4,'2026-08-20','phase10-test',$5,$6)`,
      [`later-decision:${suffix}`, `later-opportunity:${suffix}`, country, proposal.rows[0].proposal_id, laterRun.rows[0].id,
        JSON.stringify({ proposalFamily: 'COUNTRY_NATIVE', supportingEvidence: {
          nativeEvidenceStatus: 'TRANSLATED_SEED', sourceProvenanceFamily: 'TRANSLATED_QUERY'
        } })]
    );
    await completeQueryRun(laterRun.rows[0].id, { ...completedMetrics, rawResults: 0, distinctResults: 0, newChannels: 0, tradingConfirmed: 0, qualityChannels: 0, quotaUsed: 100 });
    const laterAttribution = await db.query(
      `SELECT native_evidence_status, source_provenance_family FROM country_native_performance_attribution WHERE query_run_id=$1`,
      [laterRun.rows[0].id]
    );
    assert.equal(laterAttribution.rows[0].native_evidence_status, 'TRANSLATED_SEED');
    assert.equal(laterAttribution.rows[0].source_provenance_family, 'TRANSLATED_QUERY');
  } finally {
    await db.end();
  }
});
