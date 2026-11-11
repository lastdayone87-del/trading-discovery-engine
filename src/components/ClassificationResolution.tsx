import React, { useCallback, useEffect, useState } from 'react';
import { Activity, AlertTriangle, CheckCircle2, Loader2, RefreshCw, ShieldAlert } from 'lucide-react';
import { apiFetch } from '../apiClient';

interface ResolutionAlert {
  code: string;
  severity: 'INFO' | 'WARN' | 'CRITICAL';
  message: string;
  value: number | string;
}

interface ResolutionOverview {
  version: string;
  generatedAt: string;
  channels: { total: number; trading: Record<string, number>; scan: Record<string, number>; uncertain: number; needsReview: number };
  enrichment: {
    pending: number; due: number; processing: number; oldestDueHours: number;
    completed24h: number; failed24h: number; orphanPending: number; genericFailures: number;
    recoveryCycles24h: number; exhaustionReviewsPending: number;
  };
  reviews: { pending: number; oldestPendingDays: number; eligible: number; deferred: number; notEligible: number; eligibleWithoutPendingReview: number };
  routes: { byRoute: Record<string, number>; byRecognition: Record<string, number>; semanticUsed: number; semanticAttempted: number; unclassified: number };
  quota: {
    dailyLimit: number; used: number; remaining: number; dueStage1: number; dueStage2: number;
    reserveUnits: number; protectedShare: number; discoveryAvailable: number;
    recentAutonomousUnits: number; recentEnrichmentUnits: number;
  };
  alerts: ResolutionAlert[];
}

const n = (value: number | undefined | null) => (value == null ? '—' : value.toLocaleString());
const pct = (value: number) => `${Math.round(value * 1000) / 10}%`;

function Card({ label, value, detail, tone = 'slate' }: { label: string; value: string; detail?: string; tone?: string }) {
  const tones: Record<string, string> = {
    slate: 'border-slate-200 dark:border-slate-800',
    amber: 'border-amber-200 dark:border-amber-900/60',
    rose: 'border-rose-200 dark:border-rose-900/60',
    emerald: 'border-emerald-200 dark:border-emerald-900/60',
    indigo: 'border-indigo-200 dark:border-indigo-900/60',
  };
  return (
    <div className={`rounded-xl border ${tones[tone] || tones.slate} bg-white dark:bg-slate-900 p-3`}>
      <div className="text-[10px] uppercase tracking-wider font-bold text-slate-500">{label}</div>
      <div className="text-xl font-bold text-slate-900 dark:text-white mt-1">{value}</div>
      {detail && <div className="text-[10px] text-slate-500 mt-1">{detail}</div>}
    </div>
  );
}

function SeverityIcon({ severity }: { severity: ResolutionAlert['severity'] }) {
  if (severity === 'CRITICAL') return <ShieldAlert className="w-4 h-4 text-rose-600" />;
  if (severity === 'WARN') return <AlertTriangle className="w-4 h-4 text-amber-600" />;
  return <CheckCircle2 className="w-4 h-4 text-emerald-600" />;
}

export const ClassificationResolution: React.FC = () => {
  const [data, setData] = useState<ResolutionOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiFetch('/api/classification/resolution');
      if (!response.ok) throw new Error(await response.text() || 'Could not load classification resolution metrics.');
      setData(await response.json() as ResolutionOverview);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load classification resolution metrics.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Activity className="w-5 h-5 text-indigo-600" />
        <div>
          <h2 className="text-sm font-bold text-slate-900 dark:text-white">Classification resolution</h2>
          <div className="text-[11px] text-slate-500">Deterministic routing → enrichment → recovery → review → outcome</div>
        </div>
        <button onClick={() => void load()} aria-label="Refresh classification resolution" className="ml-auto p-1.5 rounded border border-slate-200 dark:border-slate-700">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {error && <div className="rounded-xl border border-rose-200 bg-rose-50 text-rose-700 p-3 text-xs flex items-start gap-2"><AlertTriangle className="w-4 h-4 mt-0.5" />{error}</div>}
      {loading && !data && <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-8 flex justify-center"><Loader2 className="w-5 h-5 animate-spin" /></div>}
      {data && (
        <>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Card label="Stored channels" value={n(data.channels.total)} detail={`${n(data.channels.needsReview)} in review`} />
            <Card label="Uncertain" value={n(data.channels.uncertain)} detail={`${n(data.enrichment.orphanPending)} orphan pending`} tone={data.enrichment.orphanPending > 0 ? 'amber' : 'slate'} />
            <Card label="Due enrichment" value={n(data.enrichment.due)} detail={`${n(data.enrichment.processing)} processing · ${data.enrichment.oldestDueHours}h oldest`} tone={data.enrichment.due > 100 ? 'amber' : 'slate'} />
            <Card label="Pending reviews" value={n(data.reviews.pending)} detail={`${data.reviews.oldestPendingDays}d oldest · ${n(data.enrichment.exhaustionReviewsPending)} exhausted`} tone={data.reviews.oldestPendingDays >= 7 ? 'amber' : 'slate'} />
            <Card label="Enrichment 24h" value={`${n(data.enrichment.completed24h)} completed`} detail={`${n(data.enrichment.failed24h)} failed · ${n(data.enrichment.recoveryCycles24h)} recovery cycles`} />
            <Card label="Generic failures" value={n(data.enrichment.genericFailures)} detail="eligible for bounded recovery" tone={data.enrichment.genericFailures > 0 ? 'amber' : 'emerald'} />
            <Card label="Eligible without review" value={n(data.reviews.eligibleWithoutPendingReview)} detail={`${n(data.reviews.eligible)} eligible projections`} tone={data.reviews.eligibleWithoutPendingReview > 0 ? 'rose' : 'emerald'} />
            <Card label="Quota protected" value={pct(data.quota.protectedShare)} detail={`${n(data.quota.reserveUnits)} units · ${n(data.quota.discoveryAvailable)} available to discovery`} tone="indigo" />
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-3">Alerts</h3>
              {data.alerts.length === 0 && <div className="text-xs text-emerald-600">No resolution alerts.</div>}
              <div className="space-y-2">
                {data.alerts.map(alert => (
                  <div key={alert.code} className="flex items-start gap-2 rounded-lg border border-slate-100 dark:border-slate-800 p-2 text-[11px]">
                    <SeverityIcon severity={alert.severity} />
                    <div>
                      <div className="font-semibold text-slate-800 dark:text-slate-100">{alert.code}</div>
                      <div className="text-slate-500">{alert.message}</div>
                      <div className="text-slate-400 mt-0.5">{String(alert.value)}</div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
            <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-3">Quota protection</h3>
              <div className="text-[11px] space-y-1 text-slate-600 dark:text-slate-300">
                <div>Daily limit: <b>{n(data.quota.dailyLimit)}</b></div>
                <div>Used: <b>{n(data.quota.used)}</b> · Remaining: <b>{n(data.quota.remaining)}</b></div>
                <div>Due stage 1/2: <b>{n(data.quota.dueStage1)}</b> / <b>{n(data.quota.dueStage2)}</b></div>
                <div>Reserved for enrichment: <b>{n(data.quota.reserveUnits)}</b> ({pct(data.quota.protectedShare)})</div>
                <div>Recent 7-day consumption: autonomous <b>{n(data.quota.recentAutonomousUnits)}</b> · enrichment <b>{n(data.quota.recentEnrichmentUnits)}</b></div>
                <div className="text-[10px] text-slate-400 pt-1">Reserve is demand-driven and released as the due backlog clears.</div>
              </div>
            </section>
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-3">Routes</h3>
              <div className="space-y-1 text-[11px]">
                {Object.entries(data.routes.byRoute).sort((a, b) => b[1] - a[1]).map(([route, count]) => (
                  <div key={route} className="flex justify-between"><span>{route}</span><b>{n(count)}</b></div>
                ))}
                {Object.keys(data.routes.byRoute).length === 0 && <div className="text-slate-400">No routing diagnostics yet.</div>}
                <div className="border-t border-slate-100 dark:border-slate-800 mt-2 pt-2 flex justify-between"><span>Semantic used / attempted</span><b>{n(data.routes.semanticUsed)} / {n(data.routes.semanticAttempted)}</b></div>
              </div>
            </section>
            <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-3">Review eligibility</h3>
              <div className="space-y-1 text-[11px]">
                <div className="flex justify-between"><span>Eligible</span><b>{n(data.reviews.eligible)}</b></div>
                <div className="flex justify-between"><span>Deferred</span><b>{n(data.reviews.deferred)}</b></div>
                <div className="flex justify-between"><span>Not eligible</span><b>{n(data.reviews.notEligible)}</b></div>
                <div className="flex justify-between"><span>Eligible without pending review</span><b className={data.reviews.eligibleWithoutPendingReview > 0 ? 'text-rose-600' : ''}>{n(data.reviews.eligibleWithoutPendingReview)}</b></div>
                <div className="border-t border-slate-100 dark:border-slate-800 mt-2 pt-2 text-[10px] text-slate-400">Generated {new Date(data.generatedAt).toLocaleString()} · {data.version}</div>
              </div>
            </section>
          </div>
        </>
      )}
    </div>
  );
};
