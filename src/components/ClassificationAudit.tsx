import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronRight, ExternalLink, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { apiFetch, newRequestId } from '../apiClient';

interface AuditItem {
  id: string;
  cohortKey: string;
  channelId: string;
  status: string;
  channelName?: string;
  youtubeUrl?: string | null;
  country?: string | null;
  evidence: {
    channel?: { channelId?: string; channelName?: string; youtubeUrl?: string; country?: string | null; sourceCohort?: string };
    input?: Record<string, any>;
    classifier?: Record<string, any>;
    diagnosticId?: string | null;
  };
  proposedLabel?: string | null;
  proposedConfidence?: number | null;
  proposedReasonCodes?: string[];
  latestLabel?: string | null;
  latestProvenance?: string | null;
  latestLabeledAt?: string | null;
}

const date = (value?: string | null) => (value ? new Date(value).toLocaleString() : '—');

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
      <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-3">{title}</h3>
      {children}
    </section>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  if (value == null) return <div className="text-xs text-slate-400">Not available.</div>;
  return (
    <pre className="max-h-64 overflow-auto rounded-lg bg-slate-950 text-slate-100 p-3 text-[11px] leading-relaxed whitespace-pre-wrap">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

const LABELS = [
  { value: 'TRADING_CONFIRMED', label: 'Trading', className: 'bg-emerald-600 text-white' },
  { value: 'NON_TRADING', label: 'Non-trading', className: 'bg-rose-600 text-white' },
  { value: 'UNCERTAIN', label: 'Unresolved', className: 'bg-amber-600 text-white' },
] as const;

export const ClassificationAudit: React.FC = () => {
  const [items, setItems] = useState<AuditItem[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [item, setItem] = useState<AuditItem | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingItem, setLoadingItem] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [label, setLabel] = useState<'TRADING_CONFIRMED' | 'NON_TRADING' | 'UNCERTAIN'>('TRADING_CONFIRMED');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [showSuggestion, setShowSuggestion] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiFetch('/api/classification-audit?status=PENDING&limit=50');
      if (!response.ok) throw new Error(await response.text() || 'Could not load the audit queue.');
      const data = await response.json() as { items: AuditItem[]; total: number };
      setItems(data.items || []);
      setTotal(Number(data.total || 0));
      if (!selected && data.items?.length) setSelected(data.items[0].id);
      if (selected && !data.items?.some(row => row.id === selected)) {
        setSelected(data.items?.[0]?.id || null);
        setItem(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the audit queue.');
    } finally {
      setLoading(false);
    }
  }, [selected]);

  const loadItem = useCallback(async (id: string) => {
    setLoadingItem(true);
    setError(null);
    try {
      const response = await apiFetch(`/api/classification-audit/${encodeURIComponent(id)}`);
      if (!response.ok) throw new Error(await response.text() || 'Could not load the audit item.');
      setItem(await response.json() as AuditItem);
      setLabel('TRADING_CONFIRMED');
      setNotes('');
      setShowSuggestion(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the audit item.');
      setItem(null);
    } finally {
      setLoadingItem(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (selected) void loadItem(selected); }, [selected, loadItem]);

  const submit = async () => {
    if (!item) return;
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const response = await apiFetch(`/api/classification-audit/${encodeURIComponent(item.id)}/label`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': newRequestId() },
        body: JSON.stringify({ label, notes, reasonCodes: [] }),
      });
      if (!response.ok) throw new Error(await response.text() || 'Could not record the audit label.');
      setNotice(`Recorded ${label} for ${item.channelName || item.channelId}.`);
      setItem(null);
      setSelected(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record the audit label.');
    } finally {
      setSubmitting(false);
    }
  };

  const input = item?.evidence?.input || {};
  const videos = Array.isArray(input.videos) ? input.videos : Array.isArray(input.video_titles) ? input.video_titles.map((title: string) => ({ title })) : [];
  const classifier = item?.evidence?.classifier;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(280px,380px)_1fr]">
      <div className="space-y-3">
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-indigo-600" />
            <h2 className="text-sm font-bold">Independent audit</h2>
            <button onClick={() => void load()} className="ml-auto p-1.5 rounded border border-slate-200 dark:border-slate-700" title="Refresh queue">
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
          <div className="mt-2 text-[11px] text-slate-500">{total} pending audit items · labels are independent of production status.</div>
        </div>
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
          <div className="max-h-[68vh] overflow-auto divide-y divide-slate-100 dark:divide-slate-800">
            {items.length === 0 && !loading && <div className="p-4 text-xs text-slate-500">No pending audit items.</div>}
            {items.map(row => (
              <button key={row.id} onClick={() => setSelected(row.id)} className={`w-full text-left p-3 hover:bg-slate-50 dark:hover:bg-slate-800/60 ${selected === row.id ? 'bg-indigo-50 dark:bg-indigo-950/30' : ''}`}>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold truncate">{row.channelName || row.channelId}</span>
                  <ChevronRight className="w-3.5 h-3.5 ml-auto text-slate-400" />
                </div>
                <div className="mt-1 text-[10px] text-slate-500">{row.country || 'Unknown country'} · {row.evidence?.channel?.sourceCohort || row.cohortKey}</div>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="space-y-3 min-w-0">
        {error && <div className="rounded-xl border border-rose-200 bg-rose-50 text-rose-700 p-3 text-xs flex items-start gap-2"><AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />{error}</div>}
        {notice && <div className="rounded-xl border border-emerald-200 bg-emerald-50 text-emerald-700 p-3 text-xs flex items-center gap-2"><CheckCircle2 className="w-4 h-4" />{notice}</div>}
        {loadingItem && <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-8 flex justify-center"><Loader2 className="w-5 h-5 animate-spin" /></div>}
        {!loadingItem && !item && <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-8 text-xs text-slate-500">Select an audit item to inspect the raw evidence.</div>}
        {item && (
          <>
            <Section title="Channel">
              <div className="flex flex-wrap items-start gap-3">
                <div>
                  <div className="text-sm font-bold">{item.channelName || item.channelId}</div>
                  <div className="text-xs text-slate-500 mt-1">{item.country || 'Unknown country'} · {item.evidence?.channel?.sourceCohort || item.cohortKey}</div>
                  {item.youtubeUrl && <a href={item.youtubeUrl} target="_blank" rel="noreferrer" className="text-xs text-indigo-600 inline-flex items-center gap-1 mt-1">Open channel <ExternalLink className="w-3 h-3" /></a>}
                </div>
                <div className="ml-auto text-[11px] text-slate-400">Audit {item.id.slice(0, 8)} · {date(item.latestLabeledAt)}</div>
              </div>
            </Section>

            <Section title="Raw evidence">
              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <div className="text-[11px] text-slate-400 mb-1">Channel bio</div>
                  <div className="text-xs whitespace-pre-wrap text-slate-700 dark:text-slate-200">{String(input.description || '—')}</div>
                  <div className="text-[11px] text-slate-400 mt-3 mb-1">Links</div>
                  <JsonBlock value={input.external_links || input.external_link_details} />
                </div>
                <div>
                  <div className="text-[11px] text-slate-400 mb-1">Recent videos ({videos.length})</div>
                  <div className="max-h-64 overflow-auto space-y-1">
                    {videos.slice(0, 12).map((video: any, index: number) => (
                      <div key={`${video.id || index}`} className="rounded border border-slate-100 dark:border-slate-800 p-2 text-[11px]">
                        <div className="font-medium text-slate-700 dark:text-slate-200">{video.title || video}</div>
                        {video.description && <div className="text-slate-500 mt-1 line-clamp-2">{video.description}</div>}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </Section>

            <Section title="Classifier suggestion (not ground truth)">
              <button onClick={() => setShowSuggestion(value => !value)} className="text-xs text-indigo-600">{showSuggestion ? 'Hide' : 'Show'} suggestion</button>
              {showSuggestion && <div className="mt-2"><JsonBlock value={{ proposedLabel: item.proposedLabel, proposedConfidence: item.proposedConfidence, proposedReasonCodes: item.proposedReasonCodes, classifier }} /></div>}
              <div className="text-[10px] text-slate-400 mt-2">This is a suggestion only. Do not treat it as the label; decide from the evidence above.</div>
            </Section>

            <Section title="Your independent label">
              <div className="flex flex-wrap gap-2">
                {LABELS.map(option => (
                  <button key={option.value} onClick={() => setLabel(option.value)} className={`rounded-lg px-3 py-2 text-xs font-semibold ${label === option.value ? option.className : 'border border-slate-200 dark:border-slate-700'}`}>{option.label}</button>
                ))}
              </div>
              <div className="mt-3 grid gap-2 md:grid-cols-[1fr_auto]">
                <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Evidence note (what in the bio/videos supports this label?)" className="rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent px-2.5 py-2 text-xs" />
                <button disabled={submitting} onClick={() => void submit()} className="rounded-lg bg-indigo-600 text-white px-4 py-2 text-xs font-semibold disabled:opacity-40 inline-flex items-center justify-center gap-2">
                  {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                  Record label
                </button>
              </div>
            </Section>
          </>
        )}
      </div>
    </div>
  );
};
