import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROBE_DEFAULTS,
  PROBE_REASONS,
  inspectProbeLedger,
  mapProbeLedgerRow,
  reserveProbe,
  resolveProbeCapsFromValues,
  sweepExpiredProbes,
  type NewProbeAttempt,
  type ProbeLedgerRow,
  type ProbeLedgerStore,
  type ProbeLedgerTransaction,
} from './probeLedger';

/**
 * Deterministic ledger tests. The in-memory store mirrors the SQL store's
 * decision surface; SQL uniqueness/idempotency is additionally asserted in
 * probeGateSafety.test.ts (migration 146) and probeLedgerSql.test.ts.
 */
class MemoryProbeStore implements ProbeLedgerStore {
  rows: ProbeLedgerRow[] = [];
  private seq = 0;

  private tx(): ProbeLedgerTransaction {
    return {
      lockCandidate: async () => undefined,
      getCandidateStats: async candidateKey => {
        const rows = this.rows.filter(row => row.candidateKey === candidateKey);
        return {
          attempts: rows.length,
          firstReservedAt: rows.length ? rows.map(row => row.reservedAt).sort()[0] : null,
        };
      },
      getLastAttempt: async candidateKey => {
        const rows = this.rows
          .filter(row => row.candidateKey === candidateKey)
          .sort((a, b) => b.attemptNo - a.attemptNo);
        return rows[0] ?? null;
      },
      getInflight: async (candidateKey, nowIso) => {
        const rows = this.rows
          .filter(
            row =>
              row.candidateKey === candidateKey &&
              (row.status === 'RESERVED' || row.status === 'RUNNING') &&
              new Date(row.expiresAt).getTime() > new Date(nowIso).getTime()
          )
          .sort((a, b) => b.attemptNo - a.attemptNo);
        return rows[0] ?? null;
      },
      countProbesSince: async (sinceIso, country) =>
        this.rows.filter(
          row =>
            new Date(row.reservedAt).getTime() >= new Date(sinceIso).getTime() &&
            (country === undefined || row.country === country)
        ).length,
      findAttempt: async (candidateKey, attemptNo) =>
        this.rows.find(row => row.candidateKey === candidateKey && row.attemptNo === attemptNo) ?? null,
      insertAttempt: async (attempt: NewProbeAttempt) => {
        const duplicate = this.rows.some(
          row =>
            (row.candidateKey === attempt.candidateKey && row.attemptNo === attempt.attemptNo) ||
            row.probeKey === attempt.probeKey ||
            row.idempotencyKey === attempt.idempotencyKey
        );
        if (duplicate) return null;
        this.seq += 1;
        const row: ProbeLedgerRow = {
          id: `probe-${this.seq}`,
          candidateKey: attempt.candidateKey,
          probeKey: attempt.probeKey,
          idempotencyKey: attempt.idempotencyKey,
          term: attempt.term,
          country: attempt.country,
          route: attempt.route,
          providerKey: attempt.providerKey,
          units: attempt.units,
          attemptNo: attempt.attemptNo,
          status: 'RESERVED',
          outcome: null,
          resultsCount: 0,
          newCreators: 0,
          reasons: [],
          details: {},
          evidenceVersion: attempt.evidenceVersion,
          reservedAt: attempt.reservedAt,
          expiresAt: attempt.expiresAt,
          startedAt: null,
          completedAt: null,
          updatedAt: attempt.reservedAt,
        };
        this.rows.push(row);
        return row;
      },
    };
  }

  async transaction<T>(fn: (tx: ProbeLedgerTransaction) => Promise<T>): Promise<T> {
    return fn(this.tx());
  }

  async markRunning(probeId: string, startedAtIso: string): Promise<ProbeLedgerRow | null> {
    const row = this.rows.find(entry => entry.id === probeId);
    if (!row || row.status !== 'RESERVED') return null;
    if (new Date(row.expiresAt).getTime() <= new Date(startedAtIso).getTime()) return null;
    row.status = 'RUNNING';
    row.startedAt = startedAtIso;
    row.updatedAt = startedAtIso;
    return row;
  }

  async recordOutcome(update: {
    probeId: string;
    outcome: 'SUCCESS' | 'EMPTY' | 'FAILED' | 'INCONCLUSIVE';
    resultsCount: number;
    newCreators: number;
    reasons: string[];
    details: Record<string, unknown>;
    completedAt: string;
  }): Promise<ProbeLedgerRow | null> {
    const row = this.rows.find(entry => entry.id === update.probeId);
    if (!row || (row.status !== 'RESERVED' && row.status !== 'RUNNING')) return null;
    row.status = update.outcome === 'FAILED' ? 'FAILED' : 'COMPLETED';
    row.outcome = update.outcome;
    row.resultsCount = update.resultsCount;
    row.newCreators = update.newCreators;
    row.reasons = update.reasons;
    row.details = update.details;
    row.completedAt = update.completedAt;
    row.updatedAt = update.completedAt;
    return row;
  }

  async expireStale(nowIso: string): Promise<ProbeLedgerRow[]> {
    const expired = this.rows.filter(
      row =>
        (row.status === 'RESERVED' || row.status === 'RUNNING') &&
        new Date(row.expiresAt).getTime() <= new Date(nowIso).getTime()
    );
    for (const row of expired) {
      row.status = 'EXPIRED';
      row.outcome = 'EXPIRED';
      row.reasons = [...row.reasons, 'RESERVATION_EXPIRED'];
      row.completedAt = nowIso;
      row.updatedAt = nowIso;
    }
    return expired;
  }

  async list(limit: number): Promise<ProbeLedgerRow[]> {
    return [...this.rows]
      .sort((a, b) => new Date(b.reservedAt).getTime() - new Date(a.reservedAt).getTime())
      .slice(0, limit);
  }
}

function clock(startIso = '2026-01-01T00:00:00.000Z') {
  let current = new Date(startIso);
  return {
    now: () => new Date(current.getTime()),
    advanceMs(ms: number) {
      current = new Date(current.getTime() + ms);
    },
    advanceHours(hours: number) {
      current = new Date(current.getTime() + hours * 60 * 60 * 1000);
    },
  };
}

function settings(values: Record<string, string> = {}) {
  // The fixture allowlist is intentionally wide so scenario tests exercise the
  // original denial paths; default-US fail-closed behavior is covered by the
  // dedicated run-boundary tests below.
  const fixtureDefaults: Record<string, string> = {
    discovery_probe_allowed_countries:
      'US,Germany,Italy,Brazil,Japan,Spain,France,Canada,India',
  };
  return async (key: string, fallback: string) => values[key] ?? fixtureDefaults[key] ?? fallback;
}

test('total run cap denies reservations beyond discovery_probe_max_total', async () => {
  const store = new MemoryProbeStore();
  const time = clock();
  const deps = { store, now: time.now, readSetting: settings({ discovery_probe_max_total: '3' }) };
  for (let index = 1; index <= 3; index += 1) {
    const granted = await reserveProbe(
      { candidateKey: `cap-${index}`, term: 'orderflow', country: 'Germany' },
      deps
    );
    assert.equal(granted.granted, true, `reservation ${index} should be granted`);
  }
  const denied = await reserveProbe(
    { candidateKey: 'cap-4', term: 'orderflow', country: 'Germany' },
    deps
  );
  assert.equal(denied.granted, false);
  assert.equal(denied.reason, PROBE_REASONS.totalBudget);
});

test('total cap clamps to [1, 30] and defaults to 30', () => {
  const base = {
    maxPerCandidate: '3',
    minIntervalHours: '24',
    maxPerDay: '20',
    maxPerCountryPerDay: '10',
    allowOfficial: 'false',
    inFlightTtlMinutes: '15',
    maxAgeDays: '14',
  };
  assert.equal(resolveProbeCapsFromValues({ ...base, maxTotal: '9999' }).maxTotal, 30);
  assert.equal(resolveProbeCapsFromValues({ ...base, maxTotal: '0' }).maxTotal, 1);
  assert.equal(resolveProbeCapsFromValues({ ...base }).maxTotal, 30);
});

test('deadline denies after expiry and fails closed on malformed values', async () => {
  const store = new MemoryProbeStore();
  const now = () => new Date('2026-01-01T00:00:00.000Z');
  const expired = await reserveProbe(
    { candidateKey: 'deadline-1', term: 'orderflow', country: 'Germany' },
    {
      store,
      now,
      readSetting: settings({ discovery_probe_deadline: '2020-01-01T00:00:00.000Z' }),
    }
  );
  assert.equal(expired.granted, false);
  assert.equal(expired.reason, PROBE_REASONS.deadlinePassed);

  const malformed = await reserveProbe(
    { candidateKey: 'deadline-2', term: 'orderflow', country: 'Germany' },
    { store, now, readSetting: settings({ discovery_probe_deadline: 'soon-ish' }) }
  );
  assert.equal(malformed.granted, false);
  assert.equal(malformed.reason, PROBE_REASONS.deadlineInvalid);

  const open = await reserveProbe(
    { candidateKey: 'deadline-3', term: 'orderflow', country: 'Germany' },
    { store, now, readSetting: settings() }
  );
  assert.equal(open.granted, true);
});

test('country allowlist denies non-listed countries and fails closed on empty values', async () => {
  const store = new MemoryProbeStore();
  const now = () => new Date('2026-01-01T00:00:00.000Z');
  const franceDefaultUs = await reserveProbe(
    { candidateKey: 'allow-1', term: 'orderflow', country: 'France' },
    { store, now, readSetting: settings({ discovery_probe_allowed_countries: 'US' }) }
  );
  assert.equal(franceDefaultUs.granted, false);
  assert.equal(franceDefaultUs.reason, PROBE_REASONS.countryNotAllowed);

  const franceExplicit = await reserveProbe(
    { candidateKey: 'allow-2', term: 'orderflow', country: 'France' },
    { store, now, readSetting: settings({ discovery_probe_allowed_countries: ' US , France ' }) }
  );
  assert.equal(franceExplicit.granted, true);

  const emptyList = await reserveProbe(
    { candidateKey: 'allow-3', term: 'orderflow', country: 'US' },
    { store, now, readSetting: settings({ discovery_probe_allowed_countries: ' ' }) }
  );
  assert.equal(emptyList.granted, false);
  assert.equal(emptyList.reason, PROBE_REASONS.countryNotAllowed);
});

const HOUR_MS = 60 * 60 * 1000;

test('three-attempt lifetime cap, 24h interval, and duplicate in-flight reservation', async () => {
  const store = new MemoryProbeStore();
  const time = clock();
  const deps = { store, now: time.now, readSetting: settings() };
  const candidate = { candidateKey: 'cand-1', term: 'orderflow', country: 'Germany' };

  const first = await reserveProbe(candidate, deps);
  assert.equal(first.granted, true);
  assert.equal(first.probe?.attemptNo, 1);
  assert.equal(first.probe?.route, 'youtube-innertube');
  assert.equal(first.probe?.units, 0);

  const duplicate = await reserveProbe(candidate, deps);
  assert.equal(duplicate.granted, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.reason, PROBE_REASONS.duplicateInflight);
  assert.equal(duplicate.probe?.id, first.probe?.id);

  await store.markRunning(first.probe!.id, time.now().toISOString());
  await store.recordOutcome({
    probeId: first.probe!.id,
    outcome: 'SUCCESS',
    resultsCount: 20,
    newCreators: 4,
    reasons: ['NEW_CREATORS_FOUND'],
    details: {},
    completedAt: time.now().toISOString(),
  });

  const tooSoon = await reserveProbe(candidate, deps);
  assert.equal(tooSoon.granted, false);
  assert.equal(tooSoon.reason, PROBE_REASONS.minInterval);

  time.advanceHours(25);
  const second = await reserveProbe(candidate, deps);
  assert.equal(second.granted, true);
  assert.equal(second.probe?.attemptNo, 2);
  await store.recordOutcome({
    probeId: second.probe!.id,
    outcome: 'EMPTY',
    resultsCount: 0,
    newCreators: 0,
    reasons: ['EMPTY'],
    details: {},
    completedAt: time.now().toISOString(),
  });

  time.advanceHours(25);
  const third = await reserveProbe(candidate, deps);
  assert.equal(third.granted, true);
  assert.equal(third.probe?.attemptNo, 3);
  await store.recordOutcome({
    probeId: third.probe!.id,
    outcome: 'SUCCESS',
    resultsCount: 20,
    newCreators: 1,
    reasons: ['NEW_CREATORS_FOUND'],
    details: {},
    completedAt: time.now().toISOString(),
  });

  time.advanceHours(25);
  const concluded = await reserveProbe(candidate, deps);
  assert.equal(concluded.granted, false);
  assert.equal(concluded.reason, PROBE_REASONS.candidateConcluded);
  assert.equal(store.rows.length, 3);
});

test('candidate is concluded after 14 days even with attempts remaining', async () => {
  const store = new MemoryProbeStore();
  const time = clock();
  const deps = { store, now: time.now, readSetting: settings() };
  const candidate = { candidateKey: 'cand-old', term: 'borsa', country: 'Italy' };

  const first = await reserveProbe(candidate, deps);
  assert.equal(first.granted, true);
  await store.recordOutcome({
    probeId: first.probe!.id,
    outcome: 'SUCCESS',
    resultsCount: 5,
    newCreators: 2,
    reasons: [],
    details: {},
    completedAt: time.now().toISOString(),
  });

  time.advanceHours(14 * 24 + 1);
  const concluded = await reserveProbe(candidate, deps);
  assert.equal(concluded.granted, false);
  assert.equal(concluded.reason, PROBE_REASONS.candidateConcluded);
  assert.equal(store.rows.length, 1);
});

test('INCONCLUSIVE retry requires a different evidence version', async () => {
  const store = new MemoryProbeStore();
  const time = clock();
  const deps = { store, now: time.now, readSetting: settings() };
  const candidate = { candidateKey: 'cand-inc', term: 'scalping', country: 'Brazil', evidenceVersion: 'ev-1' };

  const first = await reserveProbe(candidate, deps);
  assert.equal(first.granted, true);
  assert.equal(first.probe?.evidenceVersion, 'ev-1');
  await store.recordOutcome({
    probeId: first.probe!.id,
    outcome: 'INCONCLUSIVE',
    resultsCount: 20,
    newCreators: 0,
    reasons: ['INCONCLUSIVE'],
    details: {},
    completedAt: time.now().toISOString(),
  });

  time.advanceHours(25);
  const sameEvidence = await reserveProbe(candidate, deps);
  assert.equal(sameEvidence.granted, false);
  assert.equal(sameEvidence.reason, PROBE_REASONS.inconclusiveNeedsEvidence);

  const newEvidence = await reserveProbe({ ...candidate, evidenceVersion: 'ev-2' }, deps);
  assert.equal(newEvidence.granted, true);
  assert.equal(newEvidence.probe?.attemptNo, 2);
});

test('duplicate explicit attempt returns the existing row (idempotent replay)', async () => {
  const store = new MemoryProbeStore();
  const time = clock();
  const deps = { store, now: time.now, readSetting: settings() };
  const candidate = { candidateKey: 'cand-replay', term: 'forex', country: 'Japan' };

  const first = await reserveProbe({ ...candidate, attemptNo: 1 }, deps);
  assert.equal(first.granted, true);
  await store.recordOutcome({
    probeId: first.probe!.id,
    outcome: 'SUCCESS',
    resultsCount: 20,
    newCreators: 3,
    reasons: [],
    details: {},
    completedAt: time.now().toISOString(),
  });

  const replay = await reserveProbe({ ...candidate, attemptNo: 1 }, deps);
  assert.equal(replay.granted, false);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.reason, PROBE_REASONS.duplicateAttempt);
  assert.equal(replay.probe?.id, first.probe?.id);
  assert.equal(store.rows.length, 1);
});

test('global daily cap (20) and per-country daily cap (10) are enforced', async () => {
  const globalStore = new MemoryProbeStore();
  const globalTime = clock();
  const globalDeps = { store: globalStore, now: globalTime.now, readSetting: settings() };
  for (let index = 0; index < 20; index += 1) {
    const country = index % 2 === 0 ? 'Germany' : 'France';
    const result = await reserveProbe(
      { candidateKey: `cand-g-${index}`, term: `term-${index}`, country },
      globalDeps
    );
    assert.equal(result.granted, true, `probe ${index} should be granted`);
  }
  const overGlobal = await reserveProbe(
    { candidateKey: 'cand-g-over', term: 'term-over', country: 'Spain' },
    globalDeps
  );
  assert.equal(overGlobal.granted, false);
  assert.equal(overGlobal.reason, PROBE_REASONS.globalDailyCap);

  const countryStore = new MemoryProbeStore();
  const countryTime = clock();
  const countryDeps = { store: countryStore, now: countryTime.now, readSetting: settings() };
  for (let index = 0; index < 10; index += 1) {
    const result = await reserveProbe(
      { candidateKey: `cand-c-${index}`, term: `term-${index}`, country: 'Germany' },
      countryDeps
    );
    assert.equal(result.granted, true);
  }
  const overCountry = await reserveProbe(
    { candidateKey: 'cand-c-over', term: 'term-over', country: 'Germany' },
    countryDeps
  );
  assert.equal(overCountry.granted, false);
  assert.equal(overCountry.reason, PROBE_REASONS.countryDailyCap);

  const otherCountry = await reserveProbe(
    { candidateKey: 'cand-c-other', term: 'term-other', country: 'France' },
    countryDeps
  );
  assert.equal(otherCountry.granted, true);
});

test('expiry sweep reclaims a crashed reservation without blocking the candidate', async () => {
  const store = new MemoryProbeStore();
  const time = clock();
  const deps = { store, now: time.now, readSetting: settings() };
  const candidate = { candidateKey: 'cand-crash', term: 'daytrading', country: 'Canada' };

  const first = await reserveProbe(candidate, deps);
  assert.equal(first.granted, true);
  assert.equal(first.probe?.status, 'RESERVED');

  time.advanceMs(16 * 60 * 1000);
  const swept = await sweepExpiredProbes(deps);
  assert.equal(swept.expiredCount, 1);
  assert.deepEqual(swept.probeIds, [first.probe!.id]);
  assert.equal(store.rows[0].status, 'EXPIRED');
  assert.equal(store.rows[0].outcome, 'EXPIRED');
  assert.ok(store.rows[0].reasons.includes('RESERVATION_EXPIRED'));

  const retry = await reserveProbe(candidate, deps);
  assert.equal(retry.granted, true);
  assert.equal(retry.probe?.attemptNo, 2);
});

test('official route is rejected unless discovery_probe_allow_official is exactly true', async () => {
  const store = new MemoryProbeStore();
  const time = clock();
  const candidate = { candidateKey: 'cand-official', term: 'trading', country: 'India', route: 'youtube-data-api' };

  const denied = await reserveProbe(candidate, { store, now: time.now, readSetting: settings() });
  assert.equal(denied.granted, false);
  assert.equal(denied.reason, PROBE_REASONS.officialRouteDisabled);
  assert.equal(store.rows.length, 0);

  const notExact = await reserveProbe(candidate, {
    store,
    now: time.now,
    readSetting: settings({ discovery_probe_allow_official: 'yes' }),
  });
  assert.equal(notExact.granted, false);

  const allowed = await reserveProbe(candidate, {
    store,
    now: time.now,
    readSetting: settings({ discovery_probe_allow_official: ' TRUE ' }),
  });
  assert.equal(allowed.granted, true);
  assert.equal(allowed.probe?.route, 'youtube-data-api');
  assert.equal(allowed.probe?.providerKey, 'youtube-search');
});

test('unknown route is rejected', async () => {
  const store = new MemoryProbeStore();
  const result = await reserveProbe(
    { candidateKey: 'cand-route', term: 'trading', country: 'Germany', route: 'official-api' },
    { store, now: clock().now, readSetting: settings() }
  );
  assert.equal(result.granted, false);
  assert.equal(result.reason, PROBE_REASONS.routeNotAllowed);
  assert.equal(store.rows.length, 0);
});

test('settings read failure fails closed', async () => {
  const store = new MemoryProbeStore();
  const result = await reserveProbe(
    { candidateKey: 'cand-settings', term: 'trading', country: 'Germany' },
    {
      store,
      now: clock().now,
      readSetting: async () => {
        throw new Error('app_settings unavailable');
      },
    }
  );
  assert.equal(result.granted, false);
  assert.equal(result.reason, PROBE_REASONS.settingsUnavailable);
  assert.equal(store.rows.length, 0);
});

test('store failure fails closed', async () => {
  const failingStore: ProbeLedgerStore = {
    transaction: async () => {
      throw new Error('connection reset');
    },
    markRunning: async () => null,
    recordOutcome: async () => null,
    expireStale: async () => [],
    list: async () => [],
  };
  const result = await reserveProbe(
    { candidateKey: 'cand-db', term: 'trading', country: 'Germany' },
    { store: failingStore, now: clock().now, readSetting: settings() }
  );
  assert.equal(result.granted, false);
  assert.equal(result.reason, PROBE_REASONS.dbError);
});

test('caps default conservatively and settings can only tighten', () => {
  const defaults = resolveProbeCapsFromValues({
    maxPerCandidate: '',
    minIntervalHours: '',
    maxPerDay: '',
    maxPerCountryPerDay: '',
    allowOfficial: '',
    inFlightTtlMinutes: '',
    maxAgeDays: '',
  });
  assert.deepEqual(defaults, {
    maxPerCandidate: PROBE_DEFAULTS.maxPerCandidate,
    minIntervalHours: PROBE_DEFAULTS.minIntervalHours,
    maxPerDay: PROBE_DEFAULTS.maxPerDay,
    maxPerCountryPerDay: PROBE_DEFAULTS.maxPerCountryPerDay,
    allowOfficial: false,
    inFlightTtlMinutes: PROBE_DEFAULTS.inFlightTtlMinutes,
    maxAgeDays: PROBE_DEFAULTS.maxAgeDays,
    maxTotal: PROBE_DEFAULTS.maxTotal,
    deadlineIso: null,
    deadlineMalformed: false,
    allowedCountries: ['United States'],
  });

  const loosened = resolveProbeCapsFromValues({
    maxPerCandidate: '99',
    minIntervalHours: '1',
    maxPerDay: '999',
    maxPerCountryPerDay: '999',
    allowOfficial: 'false',
    inFlightTtlMinutes: '999',
    maxAgeDays: '999',
  });
  assert.equal(loosened.maxPerCandidate, 3);
  assert.equal(loosened.minIntervalHours, 24);
  assert.equal(loosened.maxPerDay, 20);
  assert.equal(loosened.maxPerCountryPerDay, 10);
  assert.equal(loosened.inFlightTtlMinutes, 60);
  assert.equal(loosened.maxAgeDays, 14);
});

test('inspectProbeLedger is read-only and bounded', async () => {
  const store = new MemoryProbeStore();
  const time = clock();
  const deps = { store, now: time.now, readSetting: settings() };
  await reserveProbe({ candidateKey: 'cand-a', term: 'a', country: 'Germany' }, deps);
  await reserveProbe({ candidateKey: 'cand-b', term: 'b', country: 'France' }, deps);
  const before = store.rows.length;
  const inspected = await inspectProbeLedger(1, deps);
  assert.equal(inspected.rows.length, 1);
  assert.equal(store.rows.length, before);
});

test('row mapping normalizes snake_case payloads', () => {
  const row = mapProbeLedgerRow({
    id: 'id-1',
    candidate_key: 'cand',
    probe_key: 'probe',
    idempotency_key: 'idem',
    term: 'term',
    country: 'Germany',
    route: 'youtube-innertube',
    provider_key: 'youtube-innertube',
    units: 0,
    attempt_no: 2,
    status: 'COMPLETED',
    outcome: 'SUCCESS',
    results_count: 20,
    new_creators: 3,
    reasons: '["NEW_CREATORS_FOUND"]',
    details: '{"elapsedMs":10}',
    evidence_version: null,
    reserved_at: '2026-01-01T00:00:00.000Z',
    expires_at: '2026-01-01T00:15:00.000Z',
    started_at: null,
    completed_at: '2026-01-01T00:00:05.000Z',
    updated_at: '2026-01-01T00:00:05.000Z',
  });
  assert.equal(row.attemptNo, 2);
  assert.deepEqual(row.reasons, ['NEW_CREATORS_FOUND']);
  assert.deepEqual(row.details, { elapsedMs: 10 });
  assert.equal(row.newCreators, 3);
});
