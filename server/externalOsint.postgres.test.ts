import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './db';
import {
  aggregateOsintEvidence,
  attributeExternalOsintOutcome,
  buildExternalOsintProposal,
  insertExternalObservation,
  normalizeExternalObservation,
  persistExternalOsintProposal,
  type ExternalOsintObservationInput
} from './externalOsint';

const databaseUrl = process.env.PHASE11_POSTGRES_URL;

function observation(sourceId: string, correlationKey: string, suffix: string, observedAt = new Date().toISOString()): ExternalOsintObservationInput {
  return { sourceId, sourceFamily: sourceId.startsWith('publication') ? 'PUBLICATION' : 'PUBLIC_COMMUNITY',
    sourceUrl: `https://example.test/${sourceId}/${suffix}`, externalId: suffix, fetchedAt: observedAt,
    observedAt, country: 'BR', locale: 'pt-BR', language: 'pt', surface: `rompimento osint ${suffix}`,
    extractionMethod: 'fixture', extractionVersion: 'v1', confidence: .9, reliability: .9, relevance: .9,
    supportingEvidence: { fixture: suffix }, correlationKey };
}

test('Phase 11 PostgreSQL: observation replay, concurrent materialization, terminal lifecycle, immutable snapshot and attribution replay', {
  skip: databaseUrl ? false : 'PHASE11_POSTGRES_URL is required'
}, async () => {
  process.env.DATABASE_URL = databaseUrl!;
  process.env.PGSSL = 'disable';
  const db = await getDb();
  const suffix = `${Date.now()}-${process.pid}`;
  const a = observation(`forum-${suffix}`, `independent-a-${suffix}`, suffix);
  const b = observation(`publication-${suffix}`, `independent-b-${suffix}`, suffix);
  let proposalId: string | undefined; let queryId: number | undefined; let runId: string | undefined;
  let canonicalTermId: number | undefined;
  const decisionId = `osint-decision-${suffix}`;
  try {
    const replay = await Promise.all(Array.from({ length: 8 }, () => insertExternalObservation(a, db)));
    assert.equal(replay.filter(x => x.inserted).length, 1, 'concurrent exact replay inserts one append-only observation');
    assert.equal((await insertExternalObservation(b, db)).inserted, true);
    const stored = await db.query('SELECT count(*)::int count FROM external_osint_observations WHERE external_id=$1', [suffix]);
    assert.equal(stored.rows[0].count, 2);

    const aggregate = aggregateOsintEvidence([normalizeExternalObservation(a), normalizeExternalObservation(b)])[0];
    assert.equal(aggregate.eligible, true);
    assert.equal(aggregate.independentSourceCount, 2);
    const proposal = buildExternalOsintProposal(aggregate, Date.now());
    const canonical = await db.query(`INSERT INTO canonical_trading_terms(canonical_term,normalized_term,country,language,script,term_type) VALUES($1,$1,$2,'pt','Latn','TERMINOLOGY') ON CONFLICT(country,normalized_term) DO UPDATE SET canonical_term=excluded.canonical_term RETURNING id`, [aggregate.canonicalConcept, proposal.country]);
    canonicalTermId = Number(canonical.rows[0].id);
    const writes = await Promise.all(Array.from({ length: 6 }, () => persistExternalOsintProposal(proposal, db)));
    assert.equal(writes.filter(Boolean).length, 1, 'concurrent exact materialization changes one proposal row');
    const persisted = await db.query('SELECT proposal_id,trial_status,supporting_evidence FROM frontier_discovery_proposals WHERE dedup_key=$1', [proposal.dedupKey]);
    proposalId = persisted.rows[0].proposal_id;
    assert.equal(persisted.rows[0].trial_status, 'PENDING');
    assert.equal(Number(persisted.rows[0].supporting_evidence.canonicalTermId), canonicalTermId,
      'OSINT resolves to the existing Country-Native terminology identity without mutating its authority');

    await db.query("UPDATE frontier_discovery_proposals SET trial_status='TRIED' WHERE proposal_id=$1", [proposalId]);
    const newer = buildExternalOsintProposal({ ...aggregate, newestObservedAt: new Date(Date.now() + 1000).toISOString() }, Date.now() + 1000);
    assert.equal(await persistExternalOsintProposal(newer, db), false, 'new evidence cannot resurrect a terminal proposal');
    assert.equal((await db.query('SELECT trial_status FROM frontier_discovery_proposals WHERE proposal_id=$1', [proposalId])).rows[0].trial_status, 'TRIED');

    const query = await db.query(`INSERT INTO query_library(query,country,collection,intent,normalized_query) VALUES($1,'BR','EXPERIMENTAL','GENERAL',$2) RETURNING id`, [`rompimento ${suffix}`, `rompimento ${suffix}`]);
    queryId = query.rows[0].id;
    const run = await db.query(`INSERT INTO query_runs(query_id,country,source,selection_strategy,selection_reason,retrieval_lane,search_ordering) VALUES($1,'BR','automated_query','NEIGHBORHOOD_TARGETED','phase11-test','VIDEO','RELEVANCE') RETURNING id`, [queryId]);
    runId = run.rows[0].id;
    const snapshot = { proposalFamily: 'EXTERNAL_OSINT', sourceProvenance: proposal.sourceProvenance,
      supportingEvidence: proposal.supportingEvidence, targetNeighborhoodKey: proposal.targetNeighborhoodKey,
      targetDimensions: proposal.targetDimensions, confidence: proposal.confidence };
    await db.query(`INSERT INTO frontier_allocation_decisions(decision_id,opportunity_key,allocation_origin,decision_status,selected_neighborhood_key,selected_country,frontier_state,proposal_id,query_run_id,quota_day,policy_version,proposal_evidence_snapshot,proposal_evidence_checksum) VALUES($1,$2,'FRONTIER_CANARY','COMMITTED',$3,'BR','PROBING',$4,$5,'2026-08-20','phase11-test',$6,'frozen')`, [decisionId, `opp-${suffix}`, proposal.targetNeighborhoodKey, proposalId, runId, snapshot]);
    await assert.rejects(db.query(`UPDATE frontier_allocation_decisions SET proposal_evidence_snapshot='{}' WHERE decision_id=$1`, [decisionId]), /immutable/);
    const outcome = { decisionId, queryRunId: runId!, quotaConsumed: 100, rawResults: 10, distinctCreators: 5,
      newCreators: 3, relevantNewCreators: 2, qualityNewCreators: 1, confirmedCreators: 2 };
    assert.equal(await attributeExternalOsintOutcome(outcome, db), true);
    assert.equal(await attributeExternalOsintOutcome(outcome, db), false);
    assert.equal((await db.query('SELECT count(*)::int count FROM external_osint_performance_attribution WHERE allocation_decision_id=$1', [decisionId])).rows[0].count, 1);
  } finally {
    await db.query('DELETE FROM external_osint_performance_attribution WHERE allocation_decision_id=$1', [decisionId]).catch(() => undefined);
    await db.query('DELETE FROM frontier_allocation_decisions WHERE decision_id=$1', [decisionId]).catch(() => undefined);
    if (runId) await db.query('DELETE FROM query_runs WHERE id=$1', [runId]).catch(() => undefined);
    if (queryId) await db.query('DELETE FROM query_library WHERE id=$1', [queryId]).catch(() => undefined);
    if (proposalId) await db.query('DELETE FROM frontier_discovery_proposals WHERE proposal_id=$1', [proposalId]).catch(() => undefined);
    await db.query('DELETE FROM external_osint_observations WHERE external_id=$1', [suffix]).catch(() => undefined);
    if (canonicalTermId) await db.query('DELETE FROM canonical_trading_terms WHERE id=$1', [canonicalTermId]).catch(() => undefined);
  }
});
