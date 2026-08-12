import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { QueueStatus, QuotaInfo } from '../types';
import { Play, Pause, RefreshCw, Cpu, Activity, Clock3, Gauge, TrendingDown, TrendingUp, Minus, ShieldCheck } from 'lucide-react';
import { apiFetch } from '../apiClient';

interface Props {
  queueStatus: QueueStatus | null;
  quotaInfo: QuotaInfo | null;
  onTogglePause: (queueName: string, isPaused: boolean) => Promise<void>;
  onRefresh: () => void;
}

interface ProviderMetricRow {
  provider: string;
  operation: string;
  calls: number;
  successes: number;
  timeouts: number;
  errors: number;
  average_latency_ms: number;
  reserved_cost: number;
  actual_cost: number;
}

interface QueueLatencyRow {
  type: string;
  depth: number;
  runnable_depth?: number;
  deferred_depth?: number;
  next_run_at?: string | null;
  average_age_ms: number;
  oldest_age_ms: number;
}

interface ProviderMetricsResponse {
  windowHours: number;
  providers: ProviderMetricRow[];
  queueLatency: QueueLatencyRow[];
}

interface DepthSnapshot {
  depth: number;
  observedAt: number;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0m';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return remaining ? `${hours}h ${remaining}m` : `${hours}h`;
}

function isOfficialEnrichmentOperation(operation: string): boolean {
  return operation === 'hybrid-enrichment-channel-details'
    || operation === 'channel-details'
    || operation === 'channel-uploads'
    || operation === 'enrichment-video-details'
    || operation === 'enrichment-playlists';
}

export const QueueMonitor: React.FC<Props> = ({ queueStatus, quotaInfo, onTogglePause, onRefresh }) => {
  const [providerMetrics, setProviderMetrics] = useState<ProviderMetricsResponse | null>(null);
  const [metricsError, setMetricsError] = useState<string | null>(null);
  const [metricsUpdatedAt, setMetricsUpdatedAt] = useState<number | null>(null);
  const depthHistory = useRef<DepthSnapshot[]>([]);
  const metricsRequestSequence = useRef(0);

  const fetchProviderMetrics = useCallback(async () => {
    const requestSequence = ++metricsRequestSequence.current;
    try {
      const response = await apiFetch('/api/provider-metrics?hours=1');
      if (!response.ok) throw new Error(`Provider metrics returned HTTP ${response.status}`);
      const data = await response.json() as ProviderMetricsResponse;
      if (requestSequence !== metricsRequestSequence.current) return;

      setProviderMetrics(data);
      setMetricsError(null);
      setMetricsUpdatedAt(Date.now());

      const enrichment = data.queueLatency.find(row => row.type === 'ENRICH_CHANNEL');
      const now = Date.now();
      const recent = depthHistory.current.filter(snapshot => now - snapshot.observedAt <= 15 * 60_000);
      recent.push({ depth: Number(enrichment?.depth || 0), observedAt: now });
      depthHistory.current = recent.slice(-60);
    } catch (error: any) {
      if (requestSequence !== metricsRequestSequence.current) return;
      setMetricsError(error?.message || 'Unable to load provider metrics.');
    }
  }, []);

  useEffect(() => {
    void fetchProviderMetrics();
    const interval = window.setInterval(() => {
      if (!document.hidden) void fetchProviderMetrics();
    }, 15_000);
    return () => window.clearInterval(interval);
  }, [fetchProviderMetrics]);

  const queues = queueStatus ? [
    {
      key: 'search_jobs',
      name: 'Search Jobs Queue',
      desc: 'Holds pending YouTube trading search queries',
      data: queueStatus.searchJobs
    },
    {
      key: 'channel_processing',
      name: 'Channel Processing Queue',
      desc: 'Holds discovered channels awaiting 4-step inspection',
      data: queueStatus.channelProcessing
    },
    {
      key: 'discord_validation',
      name: 'Discord Validation Queue',
      desc: 'Holds detected invites awaiting public API quality check',
      data: queueStatus.discordValidation
    }
  ] : [];

  const enrichmentHealth = useMemo(() => {
    const queue = providerMetrics?.queueLatency.find(row => row.type === 'ENRICH_CHANNEL');
    const providerRows = providerMetrics?.providers || [];
    const youtubeJsRows = providerRows.filter(row => row.provider.toLowerCase() === 'youtube_js' && row.operation.includes('channel-enrichment'));
    const officialRows = providerRows.filter(row => row.provider.toLowerCase() === 'youtube' && isOfficialEnrichmentOperation(row.operation));
    const hybridOfficialRows = officialRows.filter(row => row.operation === 'hybrid-enrichment-channel-details');
    const displayedRows = [...youtubeJsRows, ...officialRows];

    const sum = (rows: ProviderMetricRow[], key: keyof ProviderMetricRow) => rows.reduce((total, row) => total + Number(row[key] || 0), 0);
    const youtubeJsCalls = sum(youtubeJsRows, 'calls');
    const youtubeJsSuccesses = sum(youtubeJsRows, 'successes');
    const youtubeJsErrors = sum(youtubeJsRows, 'errors') + sum(youtubeJsRows, 'timeouts');
    const officialActualCost = sum(officialRows, 'actual_cost');
    const officialReservedCost = sum(officialRows, 'reserved_cost');
    const hybridOfficialActualCost = sum(hybridOfficialRows, 'actual_cost');
    const baseAcquisitions = youtubeJsRows.filter(row => row.operation === 'channel-enrichment');
    const baseSuccesses = sum(baseAcquisitions, 'successes');
    const averageOfficialUnits = baseSuccesses > 0 ? hybridOfficialActualCost / baseSuccesses : null;
    const weightedLatency = youtubeJsCalls > 0
      ? youtubeJsRows.reduce((total, row) => total + Number(row.average_latency_ms || 0) * Number(row.calls || 0), 0) / youtubeJsCalls
      : 0;

    const history = depthHistory.current;
    const first = history[0];
    const last = history[history.length - 1];
    const delta = first && last ? last.depth - first.depth : 0;
    const elapsedMs = first && last ? last.observedAt - first.observedAt : 0;
    const enoughObservation = elapsedMs >= 60_000;
    const trend = !enoughObservation ? 'OBSERVING' : delta < 0 ? 'DRAINING' : delta > 0 ? 'GROWING' : 'STABLE';

    return {
      pending: Number(queue?.depth || 0),
      runnablePending: Number(queue?.runnable_depth || 0),
      deferredPending: Number(queue?.deferred_depth || 0),
      nextRunAt: queue?.next_run_at || null,
      oldestAgeMs: Number(queue?.oldest_age_ms || 0),
      averageAgeMs: Number(queue?.average_age_ms || 0),
      youtubeJsCalls,
      youtubeJsSuccesses,
      youtubeJsErrors,
      youtubeJsLatencyMs: Math.round(weightedLatency),
      officialActualCost,
      officialReservedCost,
      averageOfficialUnits,
      trend,
      delta,
      displayedRows
    };
  }, [providerMetrics, metricsUpdatedAt]);

  if (!queueStatus) return null;

  const quotaPercent = quotaInfo ? Math.min(100, Math.round((quotaInfo.unitsUsed / quotaInfo.dailyLimit) * 100)) : 0;
  const providerStatusStyle = (status: string) => {
    if (status === 'Active') return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300';
    if (status === 'Daily Quota Exhausted') return 'bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300';
    if (status === 'Cooling Down') return 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300';
    return 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300';
  };
  const trendStyle = enrichmentHealth.trend === 'DRAINING'
    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
    : enrichmentHealth.trend === 'GROWING'
      ? 'bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300'
      : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300';
  const TrendIcon = enrichmentHealth.trend === 'DRAINING' ? TrendingDown : enrichmentHealth.trend === 'GROWING' ? TrendingUp : Minus;

  const refreshAll = () => {
    onRefresh();
    void fetchProviderMetrics();
  };

  return (
    <div className="space-y-6">
      <div className="p-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Cpu className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
            <h3 className="text-base font-bold text-slate-900 dark:text-white">Crawl Job Queue Engine</h3>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Processing queues, enrichment throughput diagnostics, and live quota management.
          </p>
        </div>

        {quotaInfo && (
          <div className="bg-slate-50 dark:bg-slate-800/60 p-3.5 rounded-lg border border-slate-200 dark:border-slate-700 min-w-[280px]">
            <div className="flex items-center justify-between text-xs mb-1.5">
              <span className="font-semibold text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
                <span>YouTube API Quota</span>
                <span className="px-1.5 py-0.2 bg-indigo-100 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300 rounded text-[10px] font-mono">
                  {quotaInfo.totalKeys || 1} {quotaInfo.totalKeys === 1 ? 'Key' : 'Keys'}
                </span>
              </span>
              <span className="font-mono text-slate-600 dark:text-slate-400">{quotaInfo.unitsUsed} / {quotaInfo.dailyLimit} units</span>
            </div>
            <div className="w-full h-2 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-500 ${quotaPercent > 85 ? 'bg-rose-500' : quotaPercent > 60 ? 'bg-amber-500' : 'bg-indigo-600'}`}
                style={{ width: `${quotaPercent}%` }}
              />
            </div>

            {quotaInfo.keyUsage && quotaInfo.keyUsage.length > 0 && (
              <div className="mt-2.5 pt-2 border-t border-slate-200/60 dark:border-slate-700/60 space-y-1.5">
                <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Per-Key Rotation Breakdown:</div>
                <div className="max-h-52 overflow-y-auto space-y-1 pr-1">
                  {quotaInfo.keyUsage.map((ku) => (
                    <div key={ku.keyIndex} className="flex items-center justify-between text-[11px] bg-white dark:bg-slate-900 px-2 py-1 rounded border border-slate-200/80 dark:border-slate-800">
                      <div className="flex items-center gap-1.5">
                        <span className={`w-1.5 h-1.5 rounded-full ${ku.isActive ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400'}`} />
                        <span className="font-mono font-medium text-slate-700 dark:text-slate-300">Key #{ku.keyIndex} ({ku.maskedKey})</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold ${providerStatusStyle(ku.status)}`} title={ku.retryAt ? `Recovery scheduled for ${ku.retryAt}` : undefined}>
                          {ku.status}
                        </span>
                        <span className="font-mono text-slate-500 dark:text-slate-400">{ku.unitsUsed} / {ku.limit}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex items-center justify-between text-[10px] text-slate-500 dark:text-slate-400 mt-2 pt-1 border-t border-slate-200/40 dark:border-slate-700/40">
              <span>Pool Capacity: {quotaInfo.dailyLimit.toLocaleString()} units ({quotaInfo.totalKeys || 0} × 10k)</span>
              <span>Reset: {quotaInfo.lastReset}</span>
            </div>
          </div>
        )}
      </div>

      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
              <h3 className="text-sm font-bold">Enrichment Health — last 1 hour</h3>
            </div>
            <p className="text-[11px] text-slate-500 mt-1">Read-only production diagnostics. Backlog trend is measured from live samples while this tab is open.</p>
          </div>
          <button onClick={refreshAll} className="self-start sm:self-auto inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1.5 text-[11px] font-semibold hover:bg-slate-50 dark:hover:bg-slate-800">
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
        </div>

        {metricsError ? (
          <div className="p-4 text-xs text-rose-600 dark:text-rose-400">{metricsError}</div>
        ) : (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-slate-200 dark:bg-slate-800">
              <div className="bg-white dark:bg-slate-900 p-4">
                <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-bold text-slate-500"><Gauge className="w-3.5 h-3.5" /> Pending</div>
                <div className="mt-1 text-2xl font-extrabold font-mono">{enrichmentHealth.pending}</div>
                <div className="text-[10px] text-slate-500">{enrichmentHealth.runnablePending} runnable · {enrichmentHealth.deferredPending} deferred</div>
              </div>
              <div className="bg-white dark:bg-slate-900 p-4">
                <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-bold text-slate-500"><Clock3 className="w-3.5 h-3.5" /> Oldest pending</div>
                <div className="mt-1 text-2xl font-extrabold font-mono">{formatDuration(enrichmentHealth.oldestAgeMs)}</div>
                <div className="text-[10px] text-slate-500">Average {formatDuration(enrichmentHealth.averageAgeMs)}</div>
              </div>
              <div className="bg-white dark:bg-slate-900 p-4">
                <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-bold text-slate-500"><ShieldCheck className="w-3.5 h-3.5" /> YouTube.js</div>
                <div className="mt-1 text-2xl font-extrabold font-mono">{enrichmentHealth.youtubeJsSuccesses}/{enrichmentHealth.youtubeJsCalls}</div>
                <div className="text-[10px] text-slate-500">{enrichmentHealth.youtubeJsErrors} errors/timeouts · {enrichmentHealth.youtubeJsLatencyMs}ms avg</div>
              </div>
              <div className="bg-white dark:bg-slate-900 p-4">
                <div className="text-[10px] uppercase tracking-wider font-bold text-slate-500">Official API cost</div>
                <div className="mt-1 text-2xl font-extrabold font-mono">{enrichmentHealth.officialActualCost}</div>
                <div className="text-[10px] text-slate-500">actual units in matching enrichment calls</div>
              </div>
            </div>

            <div className="p-4 grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="rounded-lg bg-slate-50 dark:bg-slate-800/60 p-3 border border-slate-200 dark:border-slate-700">
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Backlog direction</div>
                <div className="mt-2 flex items-center gap-2">
                  <span className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-bold ${trendStyle}`}><TrendIcon className="w-3.5 h-3.5" /> {enrichmentHealth.trend}</span>
                  {enrichmentHealth.trend !== 'OBSERVING' && <span className="text-xs font-mono text-slate-500">Δ {enrichmentHealth.delta > 0 ? '+' : ''}{enrichmentHealth.delta}</span>}
                </div>
              </div>
              <div className="rounded-lg bg-slate-50 dark:bg-slate-800/60 p-3 border border-slate-200 dark:border-slate-700">
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Approx. official units / enrichment</div>
                <div className="mt-2 text-lg font-extrabold font-mono">{enrichmentHealth.averageOfficialUnits === null ? '—' : enrichmentHealth.averageOfficialUnits.toFixed(2)}</div>
                <div className="text-[10px] text-slate-500">Expected near 1 with hybrid enrichment; telemetry-window estimate.</div>
              </div>
              <div className="rounded-lg bg-slate-50 dark:bg-slate-800/60 p-3 border border-slate-200 dark:border-slate-700">
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Official reserved / actual</div>
                <div className="mt-2 text-lg font-extrabold font-mono">{enrichmentHealth.officialReservedCost} / {enrichmentHealth.officialActualCost}</div>
                <div className="text-[10px] text-slate-500">Provider-call telemetry only; zero-cost YouTube.js calls excluded.</div>
              </div>
            </div>

            {enrichmentHealth.displayedRows.length > 0 && (
              <div className="border-t border-slate-200 dark:border-slate-800 overflow-x-auto">
                <table className="w-full text-[11px] min-w-[680px]">
                  <thead className="bg-slate-50 dark:bg-slate-800/50 text-slate-500 uppercase tracking-wider">
                    <tr><th className="text-left px-3 py-2">Provider</th><th className="text-left px-3 py-2">Operation</th><th className="text-right px-3 py-2">Calls</th><th className="text-right px-3 py-2">Success</th><th className="text-right px-3 py-2">Errors</th><th className="text-right px-3 py-2">Avg ms</th><th className="text-right px-3 py-2">Actual cost</th></tr>
                  </thead>
                  <tbody>
                    {enrichmentHealth.displayedRows.map(row => (
                      <tr key={`${row.provider}:${row.operation}`} className="border-t border-slate-100 dark:border-slate-800">
                        <td className="px-3 py-2 font-mono">{row.provider}</td><td className="px-3 py-2 font-mono">{row.operation}</td><td className="px-3 py-2 text-right font-mono">{row.calls}</td><td className="px-3 py-2 text-right font-mono">{row.successes}</td><td className="px-3 py-2 text-right font-mono">{Number(row.errors || 0) + Number(row.timeouts || 0)}</td><td className="px-3 py-2 text-right font-mono">{row.average_latency_ms}</td><td className="px-3 py-2 text-right font-mono">{row.actual_cost}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="px-4 pb-3 text-[10px] text-slate-400">Last refreshed: {metricsUpdatedAt ? new Date(metricsUpdatedAt).toLocaleTimeString() : 'loading…'}</div>
          </>
        )}
      </section>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {queues.map(q => (
          <div key={q.key} className={`p-4 rounded-xl border transition-all ${q.data.isPaused ? 'border-amber-200 bg-amber-50/30 dark:border-amber-900/40 dark:bg-amber-950/10' : 'border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 shadow-xs'}`}>
            <div className="flex items-center justify-between mb-2">
              <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${q.data.isPaused ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-300' : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-300'}`}>
                {q.data.isPaused ? 'PAUSED' : 'ACTIVE WORKER'}
              </span>
              <button onClick={() => onTogglePause(q.key, !q.data.isPaused)} className={`p-1.5 rounded-lg text-xs font-semibold flex items-center gap-1 transition-colors ${q.data.isPaused ? 'bg-emerald-600 hover:bg-emerald-700 text-white' : 'bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300'}`}>
                {q.data.isPaused ? <Play className="w-3.5 h-3.5 fill-current" /> : <Pause className="w-3.5 h-3.5 fill-current" />}
                <span>{q.data.isPaused ? 'Resume' : 'Pause'}</span>
              </button>
            </div>
            <h4 className="font-bold text-xs text-slate-900 dark:text-white mt-1">{q.name}</h4>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 min-h-[32px]">{q.desc}</p>
            <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800/80 flex items-baseline justify-between">
              <span className="text-xs text-slate-500">Queue Depth</span>
              <span className="text-xl font-extrabold text-slate-900 dark:text-white font-mono">{q.data.depth}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};