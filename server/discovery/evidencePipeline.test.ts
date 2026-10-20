import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DISCOVERY_EXTRACTION_FLAG_KEY,
  maybeRunDiscoveryEvidenceExtraction,
  type DiscoveryExtractionInput,
} from './evidencePipeline';
import type { EvidenceStagingQueryable } from './evidenceStaging';

interface FakeOptions {
  vocabRows?: Array<Record<string, unknown>>;
  catalogRows?: Array<Record<string, unknown>>;
  stagedRows?: Array<Record<string, unknown>>;
  failVocab?: boolean;
  failCatalog?: boolean;
  failStaged?: boolean;
}

class FakePipelineDb implements EvidenceStagingQueryable {
  staging = new Map<string, { id: string }>();
  observations = new Set<string>();
  queries: string[] = [];
  stagingInserts: Array<Record<string, unknown>> = [];

  constructor(private options: FakeOptions = {}) {}

  async query(sql: string, params: unknown[] = []) {
    this.queries.push(sql);
    if (sql.includes('INSERT INTO discovery_candidate_staging')) {
      const key = String(params[0]);
      this.stagingInserts.push(Object.fromEntries(params.map((value, index) => [String(index), value])));
      if (this.staging.has(key)) return { rows: [{ id: this.staging.get(key)!.id, inserted: false }] };
      const id = `staging-${this.staging.size + 1}`;
      this.staging.set(key, { id });
      return { rows: [{ id, inserted: true }] };
    }
    if (sql.includes('INSERT INTO discovery_candidate_observations')) {
      const key = String(params[0]);
      if (this.observations.has(key)) return { rows: [] };
      this.observations.add(key);
      return { rows: [{ observation_key: key }] };
    }
    if (sql.includes('SELECT canonical_candidate_key FROM discovery_candidate_staging')) {
      if (this.options.failStaged) throw new Error('STAGED_LOOKUP_FAILED');
      return { rows: this.options.stagedRows || [] };
    }
    if (sql.includes('country_vocabularies')) {
      if (this.options.failVocab) throw new Error('VOCAB_LOOKUP_FAILED');
      return { rows: this.options.vocabRows || [] };
    }
    if (sql.includes('canonical_trading_terms')) {
      if (this.options.failCatalog) throw new Error('CATALOG_LOOKUP_FAILED');
      return { rows: this.options.catalogRows || [] };
    }
    throw new Error(`unexpected query: ${sql}`);
  }
}

const germanVocab = {
  languages: ['de'],
  native_trading_terminology: ['Börsenanalyse'],
  popular_instruments: ['DAX'],
  local_market_phrases: [],
  common_content_format_names: [],
};

function baseInput(overrides: Partial<DiscoveryExtractionInput> = {}): DiscoveryExtractionInput {
  return {
    channelId: 'UCrun0000000000000000000',
    channelName: 'Börsenanalyse LuxX',
    // Includes a deliberate spam phrase so the screen/reject branch is exercised.
    description: 'DAX Live #Börsenanalyse Flux Orderflow Strategie guaranteed 100x gains',
    detectedLanguages: [{ language: 'de', confidence: 0.9 }],
    creatorCountry: 'Germany',
    fallbackCountry: 'Germany',
    ...overrides,
  };
}

function settingsReader(values: Record<string, string>) {
  return async (key: string) => values[key] ?? '';
}

test('flag absent or OFF suppresses the run with zero client queries', async () => {
  for (const values of [{}, { [DISCOVERY_EXTRACTION_FLAG_KEY]: 'false' }]) {
    const db = new FakePipelineDb();
    const result = await maybeRunDiscoveryEvidenceExtraction(baseInput(), {
      readSetting: settingsReader(values),
      client: db,
    });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'FLAG_OFF');
    assert.equal(db.queries.length, 0);
    assert.equal(db.staging.size, 0);
  }
});

test('flag read failure degrades to OFF without touching the database', async () => {
  const db = new FakePipelineDb();
  const result = await maybeRunDiscoveryEvidenceExtraction(baseInput(), {
    readSetting: async key => {
      if (key === DISCOVERY_EXTRACTION_FLAG_KEY) throw new Error('SETTINGS_DOWN');
      return '';
    },
    client: db,
  });
  assert.equal(result.reason, 'FLAG_READ_FAILED');
  assert.equal(db.queries.length, 0);
});

test('terminology kill switch suppresses staging writes when the flag is ON', async () => {
  const db = new FakePipelineDb({ vocabRows: [germanVocab] });
  const result = await maybeRunDiscoveryEvidenceExtraction(baseInput(), {
    readSetting: settingsReader({
      [DISCOVERY_EXTRACTION_FLAG_KEY]: 'true',
      terminology_kill_switch: 'true',
    }),
    client: db,
  });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'KILL_SWITCH_ACTIVE');
  assert.equal(db.queries.length, 0);
  assert.equal(db.staging.size, 0);
});

test('flag ON stages only PROBE_ELIGIBLE candidates with evidence-only rows', async () => {
  const db = new FakePipelineDb({ vocabRows: [germanVocab] });
  const result = await maybeRunDiscoveryEvidenceExtraction(baseInput(), {
    readSetting: settingsReader({ [DISCOVERY_EXTRACTION_FLAG_KEY]: 'true' }),
    client: db,
  });
  assert.equal(result.skipped, false);
  assert.ok(result.extracted > 0);
  assert.ok(result.probeEligible > 0);
  assert.ok(result.reasonCounts.DETERMINISTIC_CHECKS_PASSED >= 1);
  // 'DAX' (known instrument) is extracted but must never be staged.
  assert.ok(result.rejected >= 1);
  assert.equal(db.stagingInserts.length, result.probeEligible);
  for (const insert of db.stagingInserts) {
    assert.equal(insert['15'], 'EVIDENCE_ONLY');
    assert.equal(insert['13'], 'EVIDENCE_EXTRACTION');
    assert.equal(insert['2'], 'evidence_extraction');
  }
});

test('APPROVED D4 at the runner level: no vocabulary row still stages PROBE_ELIGIBLE candidates', async () => {
  const db = new FakePipelineDb({ vocabRows: [] });
  const result = await maybeRunDiscoveryEvidenceExtraction(baseInput(), {
    readSetting: settingsReader({ [DISCOVERY_EXTRACTION_FLAG_KEY]: 'true' }),
    client: db,
  });
  assert.ok(result.probeEligible > 0);
  assert.ok(result.stagedCount > 0);
  assert.ok(result.reasonCounts.COUNTRY_WITHOUT_CURATED_VOCABULARY >= 1);
});

test('baseline lookup failure fails closed: nothing is staged', async () => {
  const db = new FakePipelineDb({ vocabRows: [germanVocab], failCatalog: true });
  const result = await maybeRunDiscoveryEvidenceExtraction(baseInput(), {
    readSetting: settingsReader({ [DISCOVERY_EXTRACTION_FLAG_KEY]: 'true' }),
    client: db,
  });
  assert.equal(result.probeEligible, 0);
  assert.equal(result.stagedCount, 0);
  assert.ok(result.reasonCounts.BASELINE_LOOKUP_FAILED >= 1);
  assert.equal(db.staging.size, 0);
});

test('curated language mismatch rejects without staging (country fit enforced)', async () => {
  const db = new FakePipelineDb({ vocabRows: [germanVocab] });
  const result = await maybeRunDiscoveryEvidenceExtraction(
    baseInput({ detectedLanguages: [{ language: 'fr', confidence: 0.9 }] }),
    { readSetting: settingsReader({ [DISCOVERY_EXTRACTION_FLAG_KEY]: 'true' }), client: db }
  );
  assert.equal(result.probeEligible, 0);
  assert.equal(result.stagedCount, 0);
  assert.ok(result.reasonCounts.LANGUAGE_MISMATCH >= 1);
  assert.equal(db.staging.size, 0);
});

test('re-running the same channel pass is idempotent end to end', async () => {
  const db = new FakePipelineDb({ vocabRows: [germanVocab] });
  const deps = {
    readSetting: settingsReader({ [DISCOVERY_EXTRACTION_FLAG_KEY]: 'true' }),
    client: db,
  };
  const first = await maybeRunDiscoveryEvidenceExtraction(baseInput(), deps);
  const second = await maybeRunDiscoveryEvidenceExtraction(baseInput(), deps);
  assert.ok(first.stagedCount > 0);
  assert.ok(first.observationCount > 0, 'first run must persist observations, not only staging rows');
  assert.equal(second.stagedCount, 0);
  assert.equal(second.duplicateCount, first.stagedCount);
  assert.equal(second.observationCount, 0);
});
