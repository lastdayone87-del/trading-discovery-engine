import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_CHANNELS_INGESTED_PER_PROBE,
  runApprovedProbe,
  type ApprovedProbeCandidate,
  type ProbeExecutorDeps,
  type ProbeIngest,
  type ProbeRetrieval,
} from './probeExecutor';
import type {
  NewProbeAttempt,
  ProbeLedgerRow,
  ProbeLedgerStore,
  ProbeLedgerTransaction,
} from './probeLedger';
import type { DiscoveredChannelRaw } from '../youtube';

/** Compact in-memory store: same contract as SqlProbeLedgerStore, no DB. */
class MemoryStore implements ProbeLedgerStore {
  rows: ProbeLedgerRow[] = [];
  private seq = 0;

  async transaction<T>(fn: (tx: ProbeLedgerTransaction) => Promise<T>): Promise<T> {
    return fn({
      lockCandidate: async () => undefined,
      getCandidateStats: async key => {
        const rows = this.rows.filter(row => row.candidateKey === key);
        return {
          attempts: rows.length,
          firstReservedAt: rows.length ? rows.map(row => row.reservedAt).sort()[0] : null,
        };
      },
      getLastAttempt: async key =>
        this.rows.filter(row => row.candidateKey === key).sort((a, b) => b.attemptNo - a.attemptNo)[0] ?? null,
      getInflight: async (key, nowIso) =>
        this.rows
          .filter(
            row =>
              row.candidateKey === key &&
              (row.status === 'RESERVED' || row.status === 'RUNNING') &&
              new Date(row.expiresAt).getTime() > new Date(nowIso).getTime()
          )
          .sort((a, b) => b.attemptNo - a.attemptNo)[0] ?? null,
      countProbesSince: async (sinceIso, country) =>
        this.rows.filter(
          row =>
            new Date(row.reservedAt).getTime() >= new Date(sinceIso).getTime() &&
            (country === undefined || row.country === country)
        ).length,
      findAttempt: async (key, attemptNo) =>
        this.rows.find(row => row.candidateKey === key && row.attemptNo === attemptNo) ?? null,
      insertAttempt: async (attempt: NewProbeAttempt) => {
        if (this.rows.some(row => row.candidateKey === attempt.candidateKey && row.attemptNo === attempt.attemptNo)) {
          return null;
        }
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
    });
  }

  async markRunning(probeId: string, startedAtIso: string): Promise<ProbeLedgerRow | null> {
    const row = this.rows.find(entry => entry.id === probeId);
    if (!row || row.status !== 'RESERVED') return null;
    if (new Date(row.expiresAt).getTime() <= new Date(startedAtIso).getTime()) return null;
    row.status = 'RUNNING';
    row.startedAt = startedAtIso;
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
    return row;
  }

  async expireStale(): Promise<ProbeLedgerRow[]> {
    return [];
  }

  async list(limit: number): Promise<ProbeLedgerRow[]> {
    return this.rows.slice(0, limit);
  }
}

function channel(index: number): DiscoveredChannelRaw {
  return {
    channelId: `UC${String(index).padStart(22, '0')}`,
    channelName: `Creator ${index}`,
    youtubeUrl: `https://www.youtube.com/channel/UC${String(index).padStart(22, '0')}`,
    description: 'trading',
    videoTitles: [],
  };
}

const candidate: ApprovedProbeCandidate = {
  candidateKey: 'cand-exec',
  term: 'orderflow',
  country: 'Germany',
  evidenceVersion: 'ev-1',
};

function deps(overrides: Partial<ProbeExecutorDeps> = {}): ProbeExecutorDeps {
  return {
    store: new MemoryStore(),
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    readSetting: async (key, fallback) =>
      key === 'discovery_probe_enabled'
        ? 'true'
        : key === 'discovery_probe_allowed_countries'
          ? 'US,Germany'
          : fallback,
    ...overrides,
  };
}

test('flag absent/off is a no-op: no reservation, no retrieval', async () => {
  const store = new MemoryStore();
  let retrieved = 0;
  const summary = await runApprovedProbe(candidate, {
    store,
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    readSetting: async (_key, fallback) => fallback,
    retrievePage: async () => {
      retrieved += 1;
      return { channels: [channel(1)] };
    },
  });
  assert.equal(summary.skipped, true);
  assert.equal(summary.reason, 'FLAG_OFF');
  assert.equal(store.rows.length, 0);
  assert.equal(retrieved, 0);
});

test('flag read failure fails closed with no reservation', async () => {
  const store = new MemoryStore();
  const summary = await runApprovedProbe(candidate, {
    store,
    readSetting: async () => {
      throw new Error('settings unavailable');
    },
  });
  assert.equal(summary.skipped, true);
  assert.equal(summary.reason, 'FLAG_READ_FAILED');
  assert.equal(store.rows.length, 0);
});

test('kill switch active stops before reservation', async () => {
  const store = new MemoryStore();
  const summary = await runApprovedProbe(candidate, {
    store,
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    readSetting: async (key, fallback) =>
      key === 'discovery_probe_enabled'
        ? 'true'
        : key === 'discovery_probe_kill_switch'
          ? 'true'
          : fallback,
  });
  assert.equal(summary.skipped, true);
  assert.equal(summary.reason, 'KILL_SWITCH_ACTIVE');
  assert.equal(store.rows.length, 0);
});

test('kill switch flipped after reservation suppresses retrieval at the outbound boundary', async () => {
  const store = new MemoryStore();
  let retrieved = 0;
  let killReads = 0;
  const summary = await runApprovedProbe(candidate, {
    store,
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    readSetting: async (key, fallback) => {
      if (key === 'discovery_probe_enabled') return 'true';
      if (key === 'discovery_probe_kill_switch') {
        killReads += 1;
        // First read is the entry check (clear); the re-read immediately
        // before the outbound call trips the kill switch.
        return killReads === 1 ? 'false' : 'true';
      }
      if (key === 'discovery_probe_allowed_countries') return 'US,Germany';
      return fallback;
    },
    retrievePage: async () => {
      retrieved += 1;
      return { channels: [channel(1)] };
    },
  });
  assert.equal(retrieved, 0, 'no retrieval call may happen after the recheck trips');
  assert.equal(summary.ran, true);
  assert.equal(summary.reason, 'KILL_SWITCH_RECHECK');
  assert.equal(summary.outcome, 'FAILED');
});

test('one page is retrieved, each channel is ingested, counts and units are recorded', async () => {
  const store = new MemoryStore();
  const retrievalRequests: Array<{ term: string; country: string }> = [];
  const ingested: string[] = [];
  const retrievePage: ProbeRetrieval = async request => {
    retrievalRequests.push({ term: request.term, country: request.country });
    return { channels: [channel(1), channel(2), channel(3)], rawResultCount: 3 };
  };
  const ingestChannel: ProbeIngest = async raw => {
    ingested.push(raw.channelId);
    return raw.channelId === channel(2).channelId
      ? { wasKnown: true, isNew: false, persisted: true }
      : { wasKnown: false, isNew: true, persisted: true };
  };

  const summary = await runApprovedProbe(candidate, deps({ store, retrievePage, ingestChannel }));

  assert.equal(summary.ran, true);
  assert.equal(summary.skipped, false);
  assert.equal(summary.outcome, 'SUCCESS');
  assert.equal(summary.resultsCount, 3);
  assert.equal(summary.ingestedCount, 3);
  assert.equal(summary.newCreators, 2);
  assert.equal(summary.units, 0);
  assert.deepEqual(retrievalRequests, [{ term: 'orderflow', country: 'Germany' }]);
  assert.deepEqual(ingested, [channel(1).channelId, channel(2).channelId, channel(3).channelId]);

  const row = store.rows[0];
  assert.equal(row.status, 'COMPLETED');
  assert.equal(row.outcome, 'SUCCESS');
  assert.equal(row.resultsCount, 3);
  assert.equal(row.newCreators, 2);
  assert.equal(row.units, 0);
  assert.equal(row.route, 'youtube-innertube');
  assert.equal(row.evidenceVersion, 'ev-1');
  assert.equal(row.details.ingestCap, MAX_CHANNELS_INGESTED_PER_PROBE);
  assert.equal((row.details.channels as Array<Record<string, unknown>>).length, 3);
  assert.equal((row.details.channels as Array<Record<string, unknown>>)[0].channelId, channel(1).channelId);
});

test('results with no new creator are INCONCLUSIVE', async () => {
  const store = new MemoryStore();
  const summary = await runApprovedProbe(candidate, deps({
    store,
    retrievePage: async () => ({ channels: [channel(1), channel(2)] }),
    ingestChannel: async () => ({ wasKnown: true, isNew: false, persisted: true }),
  }));
  assert.equal(summary.outcome, 'INCONCLUSIVE');
  assert.equal(summary.newCreators, 0);
  assert.equal(store.rows[0].outcome, 'INCONCLUSIVE');
});

test('zero returned channels are EMPTY', async () => {
  const store = new MemoryStore();
  const summary = await runApprovedProbe(candidate, deps({
    store,
    retrievePage: async () => ({ channels: [] }),
    ingestChannel: async () => {
      throw new Error('must not ingest');
    },
  }));
  assert.equal(summary.outcome, 'EMPTY');
  assert.equal(summary.resultsCount, 0);
  assert.equal(store.rows[0].outcome, 'EMPTY');
});

test('ingestion is capped at 20 channels and the cap is recorded', async () => {
  const store = new MemoryStore();
  const channels = Array.from({ length: 30 }, (_, index) => channel(index + 1));
  const ingested: string[] = [];
  const summary = await runApprovedProbe(candidate, deps({
    store,
    retrievePage: async () => ({ channels, rawResultCount: 30 }),
    ingestChannel: async raw => {
      ingested.push(raw.channelId);
      return { wasKnown: false, isNew: true, persisted: true };
    },
  }));
  assert.equal(summary.resultsCount, 30);
  assert.equal(summary.ingestedCount, MAX_CHANNELS_INGESTED_PER_PROBE);
  assert.equal(ingested.length, MAX_CHANNELS_INGESTED_PER_PROBE);
  assert.equal(store.rows[0].details.ingestCap, MAX_CHANNELS_INGESTED_PER_PROBE);
  assert.ok(store.rows[0].reasons.includes('INGEST_CAP_APPLIED'));
});

test('retrieval failure records FAILED with a failure code and never throws', async () => {
  const store = new MemoryStore();
  const summary = await runApprovedProbe(candidate, deps({
    store,
    retrievePage: async () => {
      throw Object.assign(new Error('rate limited'), { code: 'INNERTUBE_API_RATE_LIMIT_429' });
    },
  }));
  assert.equal(summary.ran, true);
  assert.equal(summary.outcome, 'FAILED');
  assert.equal(summary.reason, 'RETRIEVAL_FAILED');
  assert.equal(store.rows[0].status, 'FAILED');
  assert.equal(store.rows[0].outcome, 'FAILED');
  assert.ok(store.rows[0].reasons.includes('INNERTUBE_API_RATE_LIMIT_429'));
  assert.equal(store.rows[0].details.failureCode, 'INNERTUBE_API_RATE_LIMIT_429');
});

test('all ingestion failures record FAILED, not INCONCLUSIVE', async () => {
  const store = new MemoryStore();
  const summary = await runApprovedProbe(candidate, deps({
    store,
    retrievePage: async () => ({ channels: [channel(1), channel(2)] }),
    ingestChannel: async () => {
      throw new Error('pipeline unavailable');
    },
  }));
  assert.equal(summary.outcome, 'FAILED');
  assert.equal(summary.ingestedCount, 0);
  assert.equal(summary.newCreators, 0);
  assert.equal(store.rows[0].status, 'FAILED');
  assert.equal(store.rows[0].outcome, 'FAILED');
  assert.ok(store.rows[0].reasons.includes('INGEST_FAILURES'));
  assert.equal(store.rows[0].details.ingestFailureCount, 2);
});

test('kill switch tripped during ingestion stops the remaining channels', async () => {
  const store = new MemoryStore();
  const ingested: string[] = [];
  let kill = false;
  const summary = await runApprovedProbe(candidate, deps({
    store,
    readSetting: async (key, fallback) => {
      if (key === 'discovery_probe_enabled') return 'true';
      if (key === 'discovery_probe_kill_switch') return kill ? 'true' : 'false';
      if (key === 'discovery_probe_allowed_countries') return 'US,Germany';
      return fallback;
    },
    retrievePage: async () => ({ channels: [channel(1), channel(2), channel(3)] }),
    ingestChannel: async raw => {
      ingested.push(raw.channelId);
      kill = true;
      return { wasKnown: false, isNew: true, persisted: true };
    },
  }));
  assert.deepEqual(ingested, [channel(1).channelId]);
  assert.equal(summary.outcome, 'SUCCESS');
  assert.ok(store.rows[0].reasons.includes('KILL_SWITCH_RECHECK'));
});

test('kill switch tripped before the first ingestion records FAILED, not INCONCLUSIVE', async () => {
  const store = new MemoryStore();
  let kill = false;
  const summary = await runApprovedProbe(candidate, deps({
    store,
    readSetting: async (key, fallback) => {
      if (key === 'discovery_probe_enabled') return 'true';
      if (key === 'discovery_probe_kill_switch') return kill ? 'true' : 'false';
      if (key === 'discovery_probe_allowed_countries') return 'US,Germany';
      return fallback;
    },
    retrievePage: async () => {
      kill = true;
      return { channels: [channel(1), channel(2)] };
    },
    ingestChannel: async () => {
      throw new Error('ingestion must not start after the kill switch trips');
    },
  }));
  assert.equal(summary.outcome, 'FAILED');
  assert.equal(summary.ingestedCount, 0);
  assert.equal(summary.newCreators, 0);
  assert.equal(store.rows[0].status, 'FAILED');
  assert.equal(store.rows[0].outcome, 'FAILED');
  assert.ok(store.rows[0].reasons.includes('KILL_SWITCH_RECHECK'));
});

test('individual ingestion failures do not abort the probe', async () => {
  const store = new MemoryStore();
  const summary = await runApprovedProbe(candidate, deps({
    store,
    retrievePage: async () => ({ channels: [channel(1), channel(2)] }),
    ingestChannel: async raw => {
      if (raw.channelId === channel(1).channelId) throw new Error('pipeline exploded');
      return { wasKnown: false, isNew: true, persisted: true };
    },
  }));
  assert.equal(summary.outcome, 'SUCCESS');
  assert.equal(summary.ingestedCount, 1);
  assert.equal(summary.newCreators, 1);
  assert.ok(store.rows[0].reasons.includes('INGEST_FAILURES'));
  assert.equal(store.rows[0].details.ingestFailureCount, 1);
});

test('a denied reservation is reported and never executes', async () => {
  const store = new MemoryStore();
  let retrieved = 0;
  const first = await runApprovedProbe(candidate, deps({
    store,
    retrievePage: async () => {
      retrieved += 1;
      return { channels: [channel(1)] };
    },
    ingestChannel: async () => ({ wasKnown: true, isNew: false, persisted: true }),
  }));
  assert.equal(first.ran, true);

  const second = await runApprovedProbe(candidate, deps({
    store,
    retrievePage: async () => {
      retrieved += 1;
      return { channels: [channel(2)] };
    },
    ingestChannel: async () => ({ wasKnown: true, isNew: false, persisted: true }),
  }));
  assert.equal(second.ran, false);
  assert.equal(second.skipped, true);
  // The first probe returned results but no new creator => INCONCLUSIVE, so a
  // replay at the same evidence version is denied before any retrieval.
  assert.equal(second.reason, 'INCONCLUSIVE_REQUIRES_NEW_EVIDENCE_VERSION');
  assert.equal(retrieved, 1);
  assert.equal(store.rows.length, 1);
});

test('official route stays rejected through the executor', async () => {
  const store = new MemoryStore();
  let retrieved = 0;
  const summary = await runApprovedProbe(
    { ...candidate, route: 'youtube-data-api' },
    deps({
      store,
      retrievePage: async () => {
        retrieved += 1;
        return { channels: [] };
      },
    })
  );
  assert.equal(summary.skipped, true);
  assert.equal(summary.reason, 'OFFICIAL_ROUTE_NOT_IMPLEMENTED');
  assert.equal(retrieved, 0);
  assert.equal(store.rows.length, 0);
});
