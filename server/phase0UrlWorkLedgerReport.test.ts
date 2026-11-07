import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPhase0UrlWorkLedgerReport,
  parsePhase0UrlWorkLedgerReportArgs,
} from './phase0UrlWorkLedgerReport';

test('report arguments default to the documented window and tolerance', () => {
  assert.deepEqual(parsePhase0UrlWorkLedgerReportArgs([]), {
    windowDays: 14,
    maxDeltaPct: 5,
    check: false,
    includeRows: false,
    out: null,
    help: false,
  });
});

test('an explicit zero tolerance is preserved', () => {
  const args = parsePhase0UrlWorkLedgerReportArgs(['--max-delta-pct=0', '--check']);
  assert.equal(args.maxDeltaPct, 0);
  assert.equal(args.check, true);
  assert.equal(parsePhase0UrlWorkLedgerReportArgs(['--max-delta-pct=2.5']).maxDeltaPct, 2.5);
});

test('unknown or malformed report arguments fail instead of falling back', () => {
  for (const argv of [
    ['--window-days'],
    ['--window-days=0'],
    ['--window-days=91'],
    ['--window-days=abc'],
    ['--max-delta-pct'],
    ['--max-delta-pct=-1'],
    ['--max-delta-pct=101'],
    ['--max-delta-pct=nan'],
    ['--check=true'],
    ['--out='],
    ['--unknown'],
    ['positional'],
  ]) {
    assert.throws(
      () => parsePhase0UrlWorkLedgerReportArgs(argv),
      /unknown argument|must be an integer|must be a number|--out/,
      `expected rejection for ${argv.join(' ')}`,
    );
  }
  const args = parsePhase0UrlWorkLedgerReportArgs([
    '--window-days=7',
    '--out=/tmp/report.json',
    '--include-rows',
  ]);
  assert.equal(args.windowDays, 7);
  assert.equal(args.out, '/tmp/report.json');
  assert.equal(args.includeRows, true);
});

test('the SQL bound keeps path-only URL normalization and all-observation browser evidence', async () => {
  const queries: string[] = [];
  const db = {
    async query(sql: string) {
      queries.push(sql);
      if (sql.includes('ORDER BY o.channel_id, o.observed_at')) return { rows: [] };
      if (sql.includes('FROM ranked e')) return { rows: [] };
      return { rows: [{}] };
    },
  };

  const report = await buildPhase0UrlWorkLedgerReport(db, {
    windowDays: 7,
    maxDeltaPct: 0,
  });
  assert.equal(report.windowDays, 7);
  assert.equal(report.maxDeltaPct, 0);
  assert.ok(report.warnings.some(warning => warning.startsWith('no_retryable_work_measured')));

  const telemetrySql = queries.find(sql => sql.includes('FROM ranked e'));
  assert.ok(telemetrySql, 'the telemetry bound query must run');
  assert.match(telemetrySql, /bool_or\(browser_executed\)/);
  assert.match(telemetrySql, /PARTITION BY channel_id, surface, normalized_url/);
  assert.doesNotMatch(
    telemetrySql,
    /WHERE\s+o\.retryable\b/i,
    'retryability must be aggregated after browser execution, not used to filter observations',
  );
  assert.match(telemetrySql, /COALESCE\(o\.provenance->>'required','false'\) = 'true'/);
  assert.match(telemetrySql, /sharedEvidenceFrom/);
  assert.match(telemetrySql, /e\.requested_url/);
  assert.match(telemetrySql, /g\.browser_executed/);
  assert.match(telemetrySql, /lower\(substring\(/, 'only scheme + authority are lowercased');
  assert.match(telemetrySql, /CASE WHEN strpos\(.*\?.*\) > 0/);
  assert.match(telemetrySql, /regexp_replace\(.*':80\$'/);
  assert.match(telemetrySql, /regexp_replace\(.*':443\$'/);
  assert.match(telemetrySql, /jsonb_typeof\(.*\) = 'number'/);
  assert.match(telemetrySql, /floor\(.*::numeric\) > 0/);
  assert.doesNotMatch(telemetrySql, /::int ELSE 0 END/);
  assert.match(telemetrySql, /raw_all AS/);
  assert.match(telemetrySql, /admitted AS/);
  assert.match(telemetrySql, /JOIN admitted/);
  assert.match(telemetrySql, /latest_inspection_at/);
  assert.match(telemetrySql, /interval '5 minutes'/);
  assert.match(telemetrySql, /id DESC/);
  assert.match(telemetrySql, /STATIC_BUDGET_GAP/);
  assert.match(telemetrySql, /AS processed_evidence/);
  assert.match(telemetrySql, /AS has_found/);
  assert.match(telemetrySql, /AS has_required/);
  assert.match(telemetrySql, /WHEN has_found > 0 THEN outcome = 'FOUND'/);
  assert.match(telemetrySql, /WHEN has_required > 0 THEN required/);
  assert.match(telemetrySql, /outcome <> 'INSPECTED_NO_MATCH' OR processed_evidence/);

  const rawSql = queries.find(sql => sql.includes('o.requested_url,') && sql.includes('o.provenance'));
  assert.ok(rawSql);
  assert.match(rawSql, /COALESCE\(o\.provenance->>'surface',''\) = ANY/);
  assert.match(rawSql, /\^https\?:\/\//);
  assert.doesNotMatch(
    rawSql,
    /COALESCE\(o\.provenance->>'required','false'\) = 'true'/,
    'admission is decided per work key, not per observation',
  );

  const discoveredSql = queries.find(sql => sql.includes('creator_site_links') && sql.includes('count(DISTINCT'));
  assert.ok(discoveredSql);
  assert.match(discoveredSql, /l\.source_url/);
  assert.match(discoveredSql, /o\.final_url/);
  assert.doesNotMatch(discoveredSql, /site_inspections|canonical_url/);
});

test('the telemetry bound applies shared URL admission and auxiliary ownership', async () => {
  const observedAt = new Date().toISOString();
  const effectiveRow = (overrides: Record<string, unknown>) => ({
    channel_id: 'UCphase0-classify',
    surface: 'CREATOR_WEBSITES',
    outcome: 'ACQUISITION_FAILED',
    retryable: true,
    failure_class: 'NETWORK_FAILURE',
    observed_at: observedAt,
    required: true,
    relevance_tier: '',
    shared_evidence_from: '',
    browser_executed: false,
    ...overrides,
  });
  const effectiveRows = [
    effectiveRow({
      id: '11111111-1111-4111-8111-111111111111',
      normalized_url: 'https://creator.example/links',
      requested_url: 'https://creator.example/links',
    }),
    effectiveRow({
      id: '22222222-2222-4222-8222-222222222222',
      normalized_url: 'https://calendly.com/phase0-fixture/30min',
      requested_url: 'https://calendly.com/phase0-fixture/30min',
    }),
    effectiveRow({
      id: '33333333-3333-4333-8333-333333333333',
      normalized_url: 'https://fixture.example/assets/logo.png',
      requested_url: 'https://fixture.example/assets/logo.png',
    }),
    // Normalization strips the trailing slash, which would make the shared
    // admission gate reject `.js`; ownership must use the observed URL.
    effectiveRow({
      id: '44444444-4444-4444-8444-444444444444',
      normalized_url: 'https://creator.example/topics/vue.js',
      requested_url: 'https://creator.example/topics/vue.js/',
    }),
  ];
  const db = {
    async query(sql: string) {
      if (sql.includes('ORDER BY o.channel_id, o.observed_at')) return { rows: [] };
      if (sql.includes('FROM ranked e')) return { rows: effectiveRows };
      return { rows: [{}] };
    },
  };

  const report = await buildPhase0UrlWorkLedgerReport(db, { windowDays: 7 });
  assert.equal(report.telemetry.retryableRows, 2);
  assert.equal(report.telemetry.neverBrowserExecutedRows, 2);
});
