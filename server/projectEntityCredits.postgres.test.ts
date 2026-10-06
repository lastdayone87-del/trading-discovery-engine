import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Regression coverage for the min(uuid) defect in projectEntityCredits:
 * PostgreSQL provides no min() aggregate over uuid, so the per-entity
 * aggregation crashed every research cycle. The fix selects
 * min(canonical_entity_id::text)::uuid (deterministic; the grouped value is
 * constant per entity, NULL-preserving).
 *
 * Run ONLY against the dedicated isolated test database (shared with the
 * bootstrap pg suite):
 *
 *   RESEARCH_BOOTSTRAP_TEST_DATABASE_URL=postgresql://... npx tsx --test server/projectEntityCredits.postgres.test.ts
 *
 * Fixtures use unique keys; nothing is deleted (append-only tables).
 */
const dedicated = process.env.RESEARCH_BOOTSTRAP_TEST_DATABASE_URL;

test('entity credit regression requires a dedicated database (skipped otherwise)', () => {
  if (!dedicated) {
    console.log(
      'SKIP: set RESEARCH_BOOTSTRAP_TEST_DATABASE_URL to a dedicated test database to run the entity-credit regression.'
    );
  }
  assert.ok(true);
});

if (dedicated) process.env.DATABASE_URL = dedicated;
const maybe = dedicated ? test : test.skip;

type Db = { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> };

maybe('projectEntityCredits aggregates uuid canonical ids without min(uuid)', async () => {
  const database: Db = await import('./dbCore').then(m => m.getDb());
  const { projectEntityCredits } = await import('./persistentResearchController');
  const tag = `credit:${Date.now()}:${process.pid}`;
  const programId = String(
    (
      await database.query(
        `INSERT INTO research_programs(program_key,name,root_concept,mode,lifecycle,policy_version,scope,owner,objective,coverage_definition)
         VALUES($1,$2,$3,'SHADOW','PAUSED','persistent-research-controller-v1',$4,$5,$6,$7)
         ON CONFLICT(program_key) DO NOTHING RETURNING id`,
        [
          `test-credit-program:${tag}`,
          `Credit test program ${tag}`,
          'trading strategies',
          JSON.stringify({}),
          'test:entity-credits',
          JSON.stringify({}),
          JSON.stringify({}),
        ]
      )
    ).rows[0]?.id ||
      (
        await database.query(`SELECT id FROM research_programs WHERE program_key=$1`, [
          `test-credit-program:${tag}`,
        ])
      ).rows[0].id
  );
  await database.query(
    `INSERT INTO discovery_provider_registry(provider_key,provider_family,provider_kind,capabilities,quota_domain,mode,daily_cost_cap,updated_by)
     VALUES('youtube-search','youtube','RETRIEVAL','["SEARCH_YOUTUBE"]','youtube','ACTIVE',0,'test:entity-credits')
     ON CONFLICT(provider_key) DO UPDATE SET mode='ACTIVE', daily_cost_cap=0, capabilities='["SEARCH_YOUTUBE"]', updated_by='test:entity-credits'`
  );
  const actionId = String(
    (
      await database.query(
        `INSERT INTO discovery_actions(action_key,program_id,action_type,provider_key,normalized_target,context,provenance,source_family_ids,depth,cluster_key,expected_incremental_creators,expected_information_gain,expected_coverage_gain,uncertainty,provider_cost,review_cost,overlap_penalty,policy_version,expires_at)
         VALUES($1,$2,'SEARCH_YOUTUBE','youtube-search',$3,$4,$5,$6,0,$7,1,1,1,0.5,10,0,0,'persistent-research-controller-v1',now()+interval '14 days') RETURNING id`,
        [
          `test-credit-action:${tag}`,
          programId,
          `credit probe ${tag}`,
          JSON.stringify({ country: 'US', intent: 'strategy' }),
          JSON.stringify({}),
          JSON.stringify(['test']),
          `credit-cluster:${tag}`,
        ]
      )
    ).rows[0].id
  );
  const entityId = String(
    (
      await database.query(
        `INSERT INTO canonical_entities(id,entity_type,display_name) VALUES(gen_random_uuid(),'CHANNEL',$1) RETURNING id`,
        [`credit entity ${tag}`]
      )
    ).rows[0].id
  );
  // One canonical-uuid capture group + one channel-only (NULL) group.
  await database.query(
    `INSERT INTO discovery_entity_captures(capture_key,action_id,channel_id,canonical_entity_id,capture_type,first_ecosystem_capture,coordinates,source_family_id,observed_at,policy_version)
     VALUES($1,$2,'UCcredit1',$3,'NEW',true,$4,'test',now(),$5)`,
    [
      `test-credit-capture:${tag}:1`,
      actionId,
      entityId,
      JSON.stringify({}),
      'persistent-research-controller-v1',
    ]
  );
  await database.query(
    `INSERT INTO discovery_entity_captures(capture_key,action_id,channel_id,canonical_entity_id,capture_type,first_ecosystem_capture,coordinates,source_family_id,observed_at,policy_version)
     VALUES($1,$2,'UCcredit2',NULL,'CONFIRMED',true,$3,'test',now(),$4)`,
    [`test-credit-capture:${tag}:2`, actionId, JSON.stringify({}), 'persistent-research-controller-v1']
  );
  // Future cutoff: observed_at uses microsecond timestamps while the cutoff
  // bound is millisecond ISO; a same-millisecond capture could otherwise fall
  // outside its own window. A future bound is legitimate for a cutoff.
  const written = await projectEntityCredits(new Date(Date.now() + 2000).toISOString());
  // The projector scans every qualifying group in the (shared, append-only)
  // database, so only a lower bound is asserted globally; exactness is
  // asserted on this fixture's own action below.
  assert.ok(written >= 2, 'at least the two fixture groups are snapshotted');
  // Credit keys hash entity/action/cutoff (not the tag); scope by the fixture action.
  const scoped = (
    await database.query(
      `SELECT s.canonical_entity_id, s.channel_id FROM discovery_entity_credit_snapshots s
       JOIN discovery_actions a ON a.id=s.action_id WHERE a.action_key=$1 ORDER BY s.channel_id`,
      [`test-credit-action:${tag}`]
    )
  ).rows as Array<{ canonical_entity_id: string | null; channel_id: string }>;
  assert.equal(scoped.length, 2, 'exactly two snapshots for the fixture action');
  const byChannel = new Map(scoped.map(row => [row.channel_id, row.canonical_entity_id]));
  assert.equal(byChannel.get('UCcredit1'), entityId, 'uuid canonical id preserved exactly');
  assert.equal(byChannel.get('UCcredit2'), null, 'channel-only group stays NULL');
});

maybe('equivalent capture sets distribute remainder credits identically', async () => {
  const database: Db = await import('./dbCore').then(m => m.getDb());
  const { projectEntityCredits } = await import('./persistentResearchController');
  const tag = `credit-det:${Date.now()}:${process.pid}`;
  const programId = String(
    (
      await database.query(
        `INSERT INTO research_programs(program_key,name,root_concept,mode,lifecycle,policy_version,scope,owner,objective,coverage_definition)
         VALUES($1,$2,$3,'SHADOW','PAUSED','persistent-research-controller-v1',$4,$5,$6,$7)
         ON CONFLICT(program_key) DO NOTHING RETURNING id`,
        [
          `test-credit-det-program:${tag}`,
          `Credit determinism program ${tag}`,
          'trading strategies',
          JSON.stringify({}),
          'test:entity-credits',
          JSON.stringify({}),
          JSON.stringify({}),
        ]
      )
    ).rows[0]?.id ||
      (
        await database.query(`SELECT id FROM research_programs WHERE program_key=$1`, [
          `test-credit-det-program:${tag}`,
        ])
      ).rows[0].id
  );
  const entityId = String(
    (
      await database.query(
        `INSERT INTO canonical_entities(id,entity_type,display_name) VALUES(gen_random_uuid(),'CHANNEL',$1) RETURNING id`,
        [`credit determinism entity ${tag}`]
      )
    ).rows[0].id
  );
  // Three actions on one entity: 10000 split 3 ways leaves remainder 1, so
  // ordering decides who gets 3334 vs 3333. The aggregation orders by
  // action_id explicitly; insertion order must not matter.
  const actionIds: string[] = [];
  for (let index = 0; index < 3; index++) {
    const actionId = String(
      (
        await database.query(
          `INSERT INTO discovery_actions(action_key,program_id,action_type,provider_key,normalized_target,context,provenance,source_family_ids,depth,cluster_key,expected_incremental_creators,expected_information_gain,expected_coverage_gain,uncertainty,provider_cost,review_cost,overlap_penalty,policy_version,expires_at)
           VALUES($1,$2,'SEARCH_YOUTUBE','youtube-search',$3,$4,$5,$6,0,$7,1,1,1,0.5,10,0,0,'persistent-research-controller-v1',now()+interval '14 days') RETURNING id`,
          [
            `test-credit-det-action:${tag}:${index}`,
            programId,
            `credit determinism probe ${tag} ${index}`,
            JSON.stringify({ country: 'US', intent: 'strategy' }),
            JSON.stringify({}),
            JSON.stringify(['test']),
            `credit-det-cluster:${tag}:${index}`,
          ]
        )
      ).rows[0].id
    );
    actionIds.push(actionId);
    await database.query(
      `INSERT INTO discovery_entity_captures(capture_key,action_id,channel_id,canonical_entity_id,capture_type,first_ecosystem_capture,coordinates,source_family_id,observed_at,policy_version)
       VALUES($1,$2,'UCcreditdet',$3,'NEW',true,$4,'test',now(),$5)`,
      [
        `test-credit-det-capture:${tag}:${index}`,
        actionId,
        entityId,
        JSON.stringify({}),
        'persistent-research-controller-v1',
      ]
    );
  }
  async function creditsFor(cutoff: string, marker: string): Promise<Array<[string, number]>> {
    await projectEntityCredits(cutoff);
    // Scope to this fixture's actions AND this run's cutoff: credit keys are
    // unique per cutoff, so evidence_cutoff disambiguates runs.
    const rows = (
      await database.query(
        `SELECT s.action_id, s.credit_basis_points FROM discovery_entity_credit_snapshots s
         JOIN discovery_actions a ON a.id=s.action_id
         WHERE a.action_key LIKE $1 AND s.evidence_cutoff=$2 ORDER BY s.action_id`,
        [`test-credit-det-action:${tag}:%`, marker]
      )
    ).rows as Array<{ action_id: string; credit_basis_points: number }>;
    return rows.map(row => [String(row.action_id), Number(row.credit_basis_points)] as [string, number]);
  }
  // Deterministic expectation: shares of 3333 with remainder 1 to the lowest
  // action_id (explicit ORDER BY action_id in the aggregation).
  const ordered = [...actionIds].sort();
  const firstCutoff = new Date(Date.now() + 2000).toISOString();
  const first = await creditsFor(firstCutoff, firstCutoff);
  assert.equal(first.length, 3);
  for (const [position, actionId] of ordered.entries()) {
    assert.equal(
      first.find(([id]) => id === actionId)?.[1],
      position === 0 ? 3334 : 3333,
      'remainder goes to the lowest action_id deterministically'
    );
  }
  // Equivalent input, second run: identical per-action distribution.
  const secondCutoff = new Date(Date.now() + 4000).toISOString();
  const second = await creditsFor(secondCutoff, secondCutoff);
  assert.deepEqual(second, first);
});
