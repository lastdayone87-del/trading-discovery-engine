/**
 * Evidence-first discovery Phase 2 — bounded probe executor.
 *
 * One approved probe = one InnerTube search page (~20 results, cursor null),
 * followed by the EXISTING ingestion/verification pipeline for each returned
 * channel (`processChannelThroughPipeline`, the same entry the autonomous
 * Innertube caller uses via processDiscoveredChannel). Probe retrieval itself
 * uses only the existing InnerTube executor and records zero official quota
 * units. The delegated ingestion pipeline may call official Data API or LLM
 * paths according to its own configuration and accounting; those downstream
 * units are outside this probe ledger and are not modeled here. No new HTTP
 * client and no eligibility/serving writes.
 *
 * Integration contract: `runApprovedProbe(candidate)` is the single entry.
 * It (a) re-reads `discovery_probe_enabled` (absent => OFF) and the probe kill
 * switch, (b) reserves through probeLedger, (c) executes one page, (d) records
 * the outcome, and (e) NEVER throws into callers. Nothing invokes it
 * automatically: the probe layer stays inert until an approved caller wires it
 * and the operator flag is exactly 'true'.
 *
 * Dependency injection: `retrievePage` and `ingestChannel` default to the real
 * InnerTube executor and ingestion pipeline but are injectable, so unit tests
 * touch no network and no database.
 */

import {
  DISCOVERY_PROBE_FLAG_KEY,
  DISCOVERY_PROBE_KILL_SWITCH_KEY,
  PROBE_POLICY_VERSION,
  markProbeRunning,
  recordProbeOutcome,
  reserveProbe,
  type ProbeLedgerDeps,
  type ProbeLedgerRow,
  type ProbeOutcome,
  type ProbeSettingReader,
  type ProbeRoute,
} from './probeLedger';

export const PROBE_PAGE_SIZE = 20;
export const MAX_CHANNELS_INGESTED_PER_PROBE = 20;

/**
 * Structural channel shape (the fields the probe uses). Declared locally so
 * this module never imports the official YouTube API module; the real
 * retrieval path returns structurally identical objects.
 */
export interface ProbeChannel {
  channelId: string;
  channelName: string;
  youtubeUrl: string;
  description: string;
  videoTitles: string[];
  handle?: string | null;
  channelHandle?: string | null;
}

export interface ApprovedProbeCandidate {
  /** Canonical staging key (discovery_candidate_staging.canonical_candidate_key). */
  candidateKey: string;
  term: string;
  country: string;
  route?: ProbeRoute;
  /** New evidence version required to retry an INCONCLUSIVE candidate. */
  evidenceVersion?: string | null;
}

export interface ProbeRetrievalRequest {
  term: string;
  country: string;
  probeKey: string;
  attemptNo: number;
}

export interface ProbeRetrievalResult {
  channels: ProbeChannel[];
  rawResultCount?: number;
}

export type ProbeRetrieval = (request: ProbeRetrievalRequest) => Promise<ProbeRetrievalResult>;

export interface ProbeIngestResult {
  wasKnown?: boolean;
  isNew?: boolean;
  persisted?: boolean;
}

export type ProbeIngest = (
  channel: ProbeChannel,
  country: string
) => Promise<ProbeIngestResult>;

export interface ProbeExecutorDeps extends ProbeLedgerDeps {
  retrievePage?: ProbeRetrieval;
  ingestChannel?: ProbeIngest;
}

export interface ProbeRunSummary {
  ran: boolean;
  skipped: boolean;
  reason: string;
  probeId?: string;
  attemptNo?: number;
  outcome?: ProbeOutcome;
  resultsCount: number;
  ingestedCount: number;
  newCreators: number;
  elapsedMs: number;
  units: 0;
  policyVersion: string;
}

function skippedSummary(reason: string, elapsedMs = 0): ProbeRunSummary {
  return {
    ran: false,
    skipped: true,
    reason,
    resultsCount: 0,
    ingestedCount: 0,
    newCreators: 0,
    elapsedMs,
    units: 0,
    policyVersion: PROBE_POLICY_VERSION,
  };
}

/** Lowest-level exported InnerTube executor; one page only (cursor null). */
async function defaultRetrievePage(request: ProbeRetrievalRequest): Promise<ProbeRetrievalResult> {
  const provider = await import('../youtubeInnertubeProvider');
  const page = await provider.executeInnertubeRetrievalPage({
    provider: provider.YOUTUBE_INNERTUBE_PROVIDER,
    query: request.term,
    country: request.country,
    lane: 'CHANNEL',
    cursor: null,
    ordering: 'RELEVANCE',
    queryRunId: request.probeKey,
    requestId: request.probeKey,
  });
  return { channels: page.channels, rawResultCount: page.rawResultCount };
}

/** Existing ingestion/verification entry point, same convention as queueManager. */
async function defaultIngestChannel(
  channel: ProbeChannel,
  country: string
): Promise<ProbeIngestResult> {
  const { processChannelThroughPipeline } = await import('../ingestionPipeline');
  const outcome = await processChannelThroughPipeline(
    channel,
    country,
    'automated_query',
    false,
    false
  );
  return { wasKnown: outcome.wasKnown, isNew: outcome.isNew, persisted: outcome.persisted };
}

function channelHandle(channel: ProbeChannel): string | null {
  const raw = channel.channelHandle ?? channel.handle;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

function channelSummary(channel: ProbeChannel): {
  channelId: string;
  title: string;
  handle: string | null;
} {
  return {
    channelId: channel.channelId,
    title: channel.channelName,
    handle: channelHandle(channel),
  };
}

function failureCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'string' && code.trim()) return code.trim().slice(0, 120);
  const message = error instanceof Error ? error.message : String(error ?? '');
  return message.trim() ? message.trim().slice(0, 120) : 'PROBE_EXECUTION_FAILED';
}

function isNewCreator(outcome: Pick<ProbeIngestResult, 'wasKnown' | 'isNew' | 'persisted'>): boolean {
  // A candidate that was not persisted (for example, routed to review before a
  // canonical channel row was written) is not a discovery. Count only
  // genuinely net-new, saved channels.
  if (outcome.persisted === false) return false;
  if (typeof outcome.wasKnown === 'boolean') return outcome.wasKnown === false;
  return outcome.isNew === true;
}

/**
 * Runs one approved probe. Never throws.
 *
 * Outcomes: SUCCESS = at least one new creator; EMPTY = zero returned channels;
 * INCONCLUSIVE = results returned but no new creator (the next attempt then
 * requires a different evidenceVersion); FAILED = retrieval/execution error.
 */
export async function runApprovedProbe(
  candidate: ApprovedProbeCandidate,
  deps: ProbeExecutorDeps = {}
): Promise<ProbeRunSummary> {
  const startedAt = Date.now();
  try {
    const readSetting: ProbeSettingReader =
      deps.readSetting ?? ((key, fallback) => import('../dbCore').then(db => db.getAppSetting(key, fallback)));

    let flagValue: string;
    try {
      flagValue = String(await readSetting(DISCOVERY_PROBE_FLAG_KEY, 'false')).trim().toLowerCase();
    } catch {
      return skippedSummary('FLAG_READ_FAILED', Date.now() - startedAt);
    }
    if (flagValue !== 'true') return skippedSummary('FLAG_OFF', Date.now() - startedAt);

    let killSwitch: string;
    try {
      killSwitch = String(await readSetting(DISCOVERY_PROBE_KILL_SWITCH_KEY, 'false')).trim().toLowerCase();
    } catch {
      return skippedSummary('KILL_SWITCH_READ_FAILED', Date.now() - startedAt);
    }
    if (killSwitch === 'true') return skippedSummary('KILL_SWITCH_ACTIVE', Date.now() - startedAt);

    // The bounded probe executor implements only the zero-unit InnerTube lane.
    // Do not let an allow-official setting silently turn a reservation into an
    // unaccounted official Data API call.
    if ((candidate.route ?? 'youtube-innertube') !== 'youtube-innertube') {
      return skippedSummary('OFFICIAL_ROUTE_NOT_IMPLEMENTED', Date.now() - startedAt);
    }

    const reservation = await reserveProbe(
      {
        candidateKey: candidate.candidateKey,
        term: candidate.term,
        country: candidate.country,
        route: candidate.route ?? 'youtube-innertube',
        evidenceVersion: candidate.evidenceVersion ?? null,
      },
      deps
    );
    if (!reservation.granted || !reservation.probe) {
      return { ...skippedSummary(reservation.reason, Date.now() - startedAt) };
    }

    const probe = reservation.probe;
    const running = await markProbeRunning(probe.id, deps);
    if (!running) {
      return {
        ...skippedSummary('RESERVATION_LOST', Date.now() - startedAt),
        probeId: probe.id,
        attemptNo: probe.attemptNo,
      };
    }

    const retrievePage = deps.retrievePage ?? defaultRetrievePage;
    const ingestChannel = deps.ingestChannel ?? defaultIngestChannel;
    const executeStartedAt = Date.now();

    // Kill-switch RE-READ at the outbound boundary: either setting can flip
    // between reservation and this point, so both are re-read immediately
    // before the request. A trip (or a settings read failure) suppresses the
    // request entirely and records the reserved attempt as FAILED.
    try {
      const [liveFlag, liveKillSwitch] = await Promise.all([
        readSetting(DISCOVERY_PROBE_FLAG_KEY, 'false'),
        readSetting(DISCOVERY_PROBE_KILL_SWITCH_KEY, 'false'),
      ]);
      const flagOn = String(liveFlag).trim().toLowerCase() === 'true';
      const killed = String(liveKillSwitch).trim().toLowerCase() === 'true';
      if (!flagOn || killed) {
        const blockReason = killed ? 'KILL_SWITCH_RECHECK' : 'FLAG_RECHECK';
        await recordProbeOutcome(
          {
            probeId: probe.id,
            outcome: 'FAILED',
            resultsCount: 0,
            newCreators: 0,
            reasons: [blockReason],
            details: {
              failureCode: blockReason,
              elapsedMs: Date.now() - startedAt,
              executionMs: Date.now() - executeStartedAt,
              units: 0,
              pageSize: PROBE_PAGE_SIZE,
              policyVersion: PROBE_POLICY_VERSION,
            },
          },
          deps
        );
        return {
          ran: true,
          skipped: false,
          reason: blockReason,
          probeId: probe.id,
          attemptNo: probe.attemptNo,
          outcome: 'FAILED',
          resultsCount: 0,
          ingestedCount: 0,
          newCreators: 0,
          elapsedMs: Date.now() - startedAt,
          units: 0,
          policyVersion: PROBE_POLICY_VERSION,
        };
      }
    } catch {
      await recordProbeOutcome(
        {
          probeId: probe.id,
          outcome: 'FAILED',
          resultsCount: 0,
          newCreators: 0,
          reasons: ['KILL_SWITCH_RECHECK_READ_FAILED'],
          details: {
            failureCode: 'KILL_SWITCH_RECHECK_READ_FAILED',
            elapsedMs: Date.now() - startedAt,
            executionMs: Date.now() - executeStartedAt,
            units: 0,
            pageSize: PROBE_PAGE_SIZE,
            policyVersion: PROBE_POLICY_VERSION,
          },
        },
        deps
      );
      return {
        ran: true,
        skipped: false,
        reason: 'KILL_SWITCH_RECHECK_READ_FAILED',
        probeId: probe.id,
        attemptNo: probe.attemptNo,
        outcome: 'FAILED',
        resultsCount: 0,
        ingestedCount: 0,
        newCreators: 0,
        elapsedMs: Date.now() - startedAt,
        units: 0,
        policyVersion: PROBE_POLICY_VERSION,
      };
    }

    let page: ProbeRetrievalResult;
    try {
      page = await retrievePage({
        term: probe.term,
        country: probe.country,
        probeKey: probe.probeKey,
        attemptNo: probe.attemptNo,
      });
    } catch (error) {
      const elapsedMs = Date.now() - startedAt;
      const code = failureCode(error);
      const recorded = await recordProbeOutcome(
        {
          probeId: probe.id,
          outcome: 'FAILED',
          resultsCount: 0,
          newCreators: 0,
          reasons: ['RETRIEVAL_FAILED', code],
          details: {
            failureCode: code,
            elapsedMs,
            executionMs: Date.now() - executeStartedAt,
            units: 0,
            pageSize: PROBE_PAGE_SIZE,
            policyVersion: PROBE_POLICY_VERSION,
          },
        },
        deps
      );
      return {
        ran: true,
        skipped: false,
        reason: recorded ? 'RETRIEVAL_FAILED' : 'OUTCOME_RECORD_FAILED',
        probeId: probe.id,
        attemptNo: probe.attemptNo,
        outcome: 'FAILED',
        resultsCount: 0,
        ingestedCount: 0,
        newCreators: 0,
        elapsedMs,
        units: 0,
        policyVersion: PROBE_POLICY_VERSION,
      };
    }

    const distinct = [
      ...new Map((page.channels || []).map(channel => [channel.channelId, channel])).values(),
    ].filter(channel => channel.channelId);
    const bounded = distinct.slice(0, MAX_CHANNELS_INGESTED_PER_PROBE);
    const recordedChannels = bounded.map(channelSummary);

    let ingestedCount = 0;
    let newCreators = 0;
    const ingestFailures: string[] = [];
    const gateStopReasons: string[] = [];
    for (const channel of bounded) {
      // Re-read both gates before every delegated ingestion. A trip after the
      // reservation must stop the remaining outbound work, not just the
      // initial InnerTube page fetch.
      let gateFlag = '';
      let gateKill = '';
      try {
        gateFlag = String(await readSetting(DISCOVERY_PROBE_FLAG_KEY, 'false')).trim().toLowerCase();
        gateKill = String(await readSetting(DISCOVERY_PROBE_KILL_SWITCH_KEY, 'false')).trim().toLowerCase();
      } catch {
        gateStopReasons.push('GATE_RECHECK_READ_FAILED');
        break;
      }
      if (gateFlag !== 'true') {
        gateStopReasons.push('FLAG_OFF_RECHECK');
        break;
      }
      if (gateKill === 'true') {
        gateStopReasons.push('KILL_SWITCH_RECHECK');
        break;
      }
      try {
        const outcome = await ingestChannel(channel, probe.country);
        if (outcome.persisted !== false) ingestedCount += 1;
        if (isNewCreator(outcome)) newCreators += 1;
      } catch (error) {
        ingestFailures.push(`${channel.channelId}:${failureCode(error)}`);
      }
    }

    const resultsCount = distinct.length;
    const allIngestFailed = bounded.length > 0 && ingestFailures.length === bounded.length;
    const outcome: ProbeOutcome =
      resultsCount === 0
        ? 'EMPTY'
        : allIngestFailed
          ? 'FAILED'
          : newCreators > 0
            ? 'SUCCESS'
            : 'INCONCLUSIVE';
    const elapsedMs = Date.now() - startedAt;
    const reasons: string[] = [outcome === 'SUCCESS' ? 'NEW_CREATORS_FOUND' : outcome];
    if (ingestFailures.length > 0) reasons.push('INGEST_FAILURES');
    reasons.push(...gateStopReasons);
    if (distinct.length > bounded.length) reasons.push('INGEST_CAP_APPLIED');

    const recorded = await recordProbeOutcome(
      {
        probeId: probe.id,
        outcome,
        resultsCount,
        newCreators,
        reasons,
        details: {
          elapsedMs,
          executionMs: Date.now() - executeStartedAt,
          units: 0,
          pageSize: PROBE_PAGE_SIZE,
          ingestCap: MAX_CHANNELS_INGESTED_PER_PROBE,
          ingestedCount,
          ingestFailureCount: ingestFailures.length,
          ingestFailures: ingestFailures.slice(0, MAX_CHANNELS_INGESTED_PER_PROBE),
          rawResultCount: Number(page.rawResultCount ?? resultsCount),
          channels: recordedChannels,
          policyVersion: PROBE_POLICY_VERSION,
        },
      },
      deps
    );

    return {
      ran: true,
      skipped: false,
      reason: recorded ? outcome : 'OUTCOME_RECORD_FAILED',
      probeId: probe.id,
      attemptNo: probe.attemptNo,
      outcome,
      resultsCount,
      ingestedCount,
      newCreators,
      elapsedMs,
      units: 0,
      policyVersion: PROBE_POLICY_VERSION,
    };
  } catch (error) {
    // Absolute no-throw boundary: a probe can never break its caller.
    console.warn(
      `[ProbeExecutor] probe failed closed: ${
        error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160)
      }`
    );
    return skippedSummary('PROBE_EXECUTION_ERROR', Date.now() - startedAt);
  }
}

export type { ProbeLedgerRow };
