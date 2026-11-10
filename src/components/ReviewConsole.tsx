import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronRight, ExternalLink, Loader2, RefreshCw, ShieldAlert, XCircle } from 'lucide-react';
import { apiFetch } from '../apiClient';
import { submitReviewDecision } from '../reviewDecision';
import { newRequestId } from '../apiClient';

interface ReviewQueueItem {
  channelId: string;
  channelName: string;
  youtubeUrl?: string;
  country?: string;
  state: string;
  reviewVersion: number;
  pendingSince?: string;
  tradingStatus?: string;
  scanStatus?: string;
  discordStatus?: string;
  evidenceSnapshot?: any;
}

interface ReviewEvidenceBundle {
  version: string;
  review: ReviewQueueItem & { history?: any[] };
  eligibility: any | null;
  diagnostic: any | null;
  evidenceDocuments: any[];
  evidenceAssertions: any[];
  evidenceCoverage: any[];
  creatorFocusSnapshot: any | null;
  warnings: string[];
}

const reasonCatalog = async (): Promise<{ version: string; actions: Record<string, Array<{ code: string; label: string }>> }> => {
  const response = await apiFetch('/api/review-reasons');
  if (!response.ok) throw new Error('Could not load review reasons.');
  return response.json();
};

const date = (value?: string) => (value ? new Date(value).toLocaleString() : '—');
const text = (value: unknown) => (typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value));

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

export const ReviewConsole: React.FC<{ onReviewCompleted?: () => void }> = ({ onReviewCompleted }) => {
  const [queue, setQueue] = useState<ReviewQueueItem[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [bundle, setBundle] = useState<ReviewEvidenceBundle | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingBundle, setLoadingBundle] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [country, setCountry] = useState('');
  const [catalog, setCatalog] = useState<Record<string, Array<{ code: string; label: string }>>>({});
  const [catalogVersion, setCatalogVersion] = useState('');
  const [action, setAction] = useState<'APPROVE' | 'REJECT'>('APPROVE');
  const [reasonCode, setReasonCode] = useState('');
  const [notes, setNotes] = useState('');
  const [reasonOther, setReasonOther] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const queueRequest = useRef(0);
  const bundleRequest = useRef(0);

  const loadQueue = useCallback(async () => {
    const requestId = ++queueRequest.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: '50' });
      if (search.trim()) params.set('search', search.trim());
      if (country.trim()) params.set('country', country.trim());
      const response = await apiFetch(`/api/reviews?${params.toString()}`);
      if (!response.ok) throw new Error(await response.text() || 'Could not load the review queue.');
      const items = await response.json() as ReviewQueueItem[];
      if (requestId !== queueRequest.current) return;
      setQueue(items);
      if (items.length && !selected) setSelected(items[0].channelId);
      if (selected && !items.some(item => item.channelId === selected)) {
        setSelected(items[0]?.channelId || null);
        setBundle(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the review queue.');
    } finally {
      setLoading(false);
    }
  }, [search, country, selected]);

  const loadCatalog = useCallback(async () => {
    try {
      const data = await reasonCatalog();
      setCatalog(data.actions || {});
      setCatalogVersion(data.version || '');
    } catch {
      // The queue still works; the decision form reports the missing catalog.
    }
  }, []);

  const loadBundle = useCallback(async (channelId: string) => {
    const requestId = ++bundleRequest.current;
    setLoadingBundle(true);
    setError(null);
    try {
      const response = await apiFetch(`/api/reviews/${encodeURIComponent(channelId)}/evidence`);
      if (!response.ok) throw new Error(await response.text() || 'Could not load review evidence.');
      const data = await response.json() as ReviewEvidenceBundle;
      if (requestId !== bundleRequest.current) return;
      setBundle(data);
      setAction('APPROVE');
      setReasonCode('');
      setReasonOther('');
      setNotes('');
    } catch (err) {
      if (requestId !== bundleRequest.current) return;
      setError(err instanceof Error ? err.message : 'Could not load review evidence.');
      setBundle(null);
    } finally {
      setLoadingBundle(false);
    }
  }, []);

  useEffect(() => { void loadCatalog(); }, [loadCatalog]);
  useEffect(() => { void loadQueue(); }, [loadQueue]);
  useEffect(() => {
    if (!selected) return;
    setBundle(null);
    void loadBundle(selected);
  }, [selected, loadBundle]);

  const current = useMemo(() => queue.find(item => item.channelId === selected) || bundle?.review || null, [queue, selected, bundle]);
  const reasons = catalog[action] || [];

  const submit = async () => {
    if (!current || !bundle) return;
    if (bundle.review.channelId !== current.channelId || bundle.review.state !== 'PENDING') {
      setError('The selected channel changed while its evidence was loading. Reload the selection before deciding.');
      return;
    }
    if (!reasonCode) { setError('Select a review reason before submitting.'); return; }
    if (reasonCode === 'OTHER' && !reasonOther.trim()) { setError('Describe the other reason before submitting.'); return; }
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      await submitReviewDecision({
        channelId: current.channelId,
        action: action === 'APPROVE' ? 'approve' : 'reject',
        reviewVersion: Number(bundle.review.reviewVersion || current.reviewVersion),
        reviewReasonCode: reasonCode,
        reviewReasonVersion: catalogVersion,
        reviewReasonOther: reasonCode === 'OTHER' ? reasonOther.trim() : undefined,
        notes,
      }, apiFetch, {}, newRequestId());
      setNotice(`${action === 'APPROVE' ? 'Approved' : 'Rejected'} ${current.channelName}.`);
      setBundle(null);
      setSelected(null);
      await loadQueue();
      onReviewCompleted?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Review decision failed.');
    } finally {
      setSubmitting(false);
    }
  };

  const decision = bundle?.diagnostic?.decision || {};
  const collection = decision.evidenceCollection || {};
  const routing = decision.deterministicRouting || {};
  const storedEvidenceItems = Array.isArray(bundle?.diagnostic?.evidenceItems) ? bundle!.diagnostic!.evidenceItems : [];
  const positive = Array.isArray(decision.positiveEvidence) && decision.positiveEvidence.length
    ? decision.positiveEvidence
    : storedEvidenceItems.filter((item: any) => item.polarity === 'POSITIVE');
  const negative = Array.isArray(decision.negativeEvidence) && decision.negativeEvidence.length
    ? decision.negativeEvidence
    : storedEvidenceItems.filter((item: any) => item.polarity === 'NEGATIVE');

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(280px,380px)_1fr]">
      <div className="space-y-3">
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <div className="flex items-center gap-2 mb-3">
            <ShieldAlert className="w-5 h-5 text-indigo-600" />
            <h2 className="text-sm font-bold text-slate-900 dark:text-white">Review console</h2>
            <button onClick={() => void loadQueue()} className="ml-auto p-1.5 rounded border border-slate-200 dark:border-slate-700" aria-label="Refresh queue" title="Refresh queue">
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search channel" className="rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent px-2.5 py-2 text-xs" />
            <input value={country} onChange={e => setCountry(e.target.value)} placeholder="Country" className="rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent px-2.5 py-2 text-xs" />
          </div>
          <div className="mt-2 text-[11px] text-slate-500">{queue.length} pending in this page</div>
        </div>
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
          {queue.length === 0 && !loading && <div className="p-4 text-xs text-slate-500">No pending reviews.</div>}
          <div className="max-h-[65vh] overflow-auto divide-y divide-slate-100 dark:divide-slate-800">
            {queue.map(item => (
              <button key={item.channelId} onClick={() => setSelected(item.channelId)} className={`w-full text-left p-3 hover:bg-slate-50 dark:hover:bg-slate-800/60 ${selected === item.channelId ? 'bg-indigo-50 dark:bg-indigo-950/30' : ''}`}>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-slate-900 dark:text-white truncate">{item.channelName}</span>
                  <ChevronRight className="w-3.5 h-3.5 ml-auto text-slate-400" />
                </div>
                <div className="mt-1 flex flex-wrap gap-1.5 text-[10px] text-slate-500">
                  <span>{item.country || 'Unknown country'}</span>
                  <span>· {item.tradingStatus || 'UNCERTAIN'}</span>
                  <span>· {date(item.pendingSince)}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="space-y-3 min-w-0">
        {error && <div className="rounded-xl border border-rose-200 bg-rose-50 text-rose-700 p-3 text-xs flex items-start gap-2"><AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />{error}</div>}
        {notice && <div className="rounded-xl border border-emerald-200 bg-emerald-50 text-emerald-700 p-3 text-xs flex items-center gap-2"><CheckCircle2 className="w-4 h-4" />{notice}</div>}
        {loadingBundle && <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-8 flex items-center justify-center"><Loader2 className="w-5 h-5 animate-spin" /></div>}
        {!loadingBundle && !bundle && <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-8 text-xs text-slate-500">Select a pending channel to inspect its evidence.</div>}
        {bundle && current && (
          <>
            <Section title="Channel and decision">
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-bold text-slate-900 dark:text-white">{current.channelName}</div>
                  <div className="text-xs text-slate-500 mt-1">{current.country || 'Unknown country'} · {current.tradingStatus || 'UNCERTAIN'} · review v{bundle.review.reviewVersion}</div>
                  {current.youtubeUrl && <a href={current.youtubeUrl} target="_blank" rel="noreferrer" className="text-xs text-indigo-600 inline-flex items-center gap-1 mt-1">Open channel <ExternalLink className="w-3 h-3" /></a>}
                </div>
                <div className="ml-auto grid grid-cols-2 gap-2 text-[11px]">
                  <div><div className="text-slate-400">Route</div><div className="font-semibold">{routing.route || '—'}</div></div>
                  <div><div className="text-slate-400">Confidence</div><div className="font-semibold">{decision.confidenceScore ?? '—'}</div></div>
                  <div><div className="text-slate-400">Evidence</div><div className="font-semibold">{collection.sufficiency || '—'}</div></div>
                  <div><div className="text-slate-400">Semantic used</div><div className="font-semibold">{routing.semanticUsed ? 'yes' : 'no'}</div></div>
                </div>
              </div>
              {bundle.warnings.length > 0 && <div className="mt-3 text-[11px] text-amber-600">{bundle.warnings.join(' · ')}</div>}
            </Section>

            <Section title="Why this reached review">
              <div className="grid gap-3 md:grid-cols-2">
                <div className="text-xs space-y-1">
                  <div><span className="text-slate-400">Eligibility:</span> {bundle.eligibility?.status || 'not recorded'}</div>
                  <div><span className="text-slate-400">Reason family:</span> {bundle.eligibility?.reasonFamily || '—'}</div>
                  <div><span className="text-slate-400">Reason codes:</span> {text(bundle.eligibility?.reasonCodes)}</div>
                  <div><span className="text-slate-400">Fallback:</span> {routing.fallbackReason || '—'}</div>
                  <div><span className="text-slate-400">Recognition:</span> {decision.recognitionState || decision.recognition?.state || '—'}</div>
                  <div><span className="text-slate-400">Semantic policy:</span> {decision.semanticPolicy || decision.recognition?.semanticPolicy || '—'}</div>
                </div>
                <div className="text-xs space-y-1">
                  <div><span className="text-slate-400">Provider outcomes:</span></div>
                  <JsonBlock value={collection.providers} />
                </div>
              </div>
            </Section>

            <Section title="Evidence items">
              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <div className="text-[11px] font-semibold text-emerald-600 mb-2">Positive ({positive.length})</div>
                  <div className="space-y-2 max-h-64 overflow-auto">
                    {positive.map((item: any, index: number) => (
                      <div key={item.id || index} className="rounded-lg border border-emerald-100 dark:border-emerald-900/50 p-2">
                        <div className="text-[11px] font-semibold text-slate-800 dark:text-slate-100">{item.category || item.source}</div>
                        <div className="text-[11px] text-slate-600 dark:text-slate-300 mt-1">{item.fact}</div>
                        <div className="text-[10px] text-slate-400 mt-1">weight {Math.round(Number(item.finalWeight || 0) * 10) / 10} · {item.reliability || ''} · {text(item.provenance?.fields)}</div>
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="text-[11px] font-semibold text-rose-600 mb-2">Negative ({negative.length})</div>
                  <div className="space-y-2 max-h-64 overflow-auto">
                    {negative.map((item: any, index: number) => (
                      <div key={item.id || index} className="rounded-lg border border-rose-100 dark:border-rose-900/50 p-2">
                        <div className="text-[11px] font-semibold text-slate-800 dark:text-slate-100">{item.category || item.source}</div>
                        <div className="text-[11px] text-slate-600 dark:text-slate-300 mt-1">{item.fact}</div>
                        <div className="text-[10px] text-slate-400 mt-1">role {item.negativeRole || '—'} · {text(item.claimPolarity)} · {text(item.provenance?.fields)}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </Section>

            <Section title="Input evidence">
              <JsonBlock value={bundle.diagnostic?.normalizedInput} />
            </Section>

            <Section title="Evidence plane">
              <div className="grid gap-3 md:grid-cols-3">
                <div><div className="text-[11px] text-slate-400 mb-1">Documents ({bundle.evidenceDocuments.length})</div><JsonBlock value={bundle.evidenceDocuments} /></div>
                <div><div className="text-[11px] text-slate-400 mb-1">Assertions ({bundle.evidenceAssertions.length})</div><JsonBlock value={bundle.evidenceAssertions} /></div>
                <div><div className="text-[11px] text-slate-400 mb-1">Coverage ({bundle.evidenceCoverage.length})</div><JsonBlock value={bundle.evidenceCoverage} /></div>
              </div>
            </Section>

            <Section title="Decision history">
              <div className="space-y-2">
                {(bundle.review.history || []).map((entry: any) => (
                  <div key={entry.id} className="rounded-lg border border-slate-100 dark:border-slate-800 p-2 text-[11px]">
                    <div className="font-semibold">{entry.decision} · v{entry.review_version} · {entry.reviewer}</div>
                    <div className="text-slate-500 mt-1">{entry.reason_code || entry.reason} · {date(entry.decided_at)}</div>
                    {entry.notes && <div className="text-slate-500 mt-1">{entry.notes}</div>}
                  </div>
                ))}
                {(!bundle.review.history || bundle.review.history.length === 0) && <div className="text-xs text-slate-400">No prior decisions.</div>}
              </div>
            </Section>

            <Section title="Decision">
              <div className="grid gap-3 md:grid-cols-[auto_1fr]">
                <div className="flex gap-2">
                  <button onClick={() => { setAction('APPROVE'); setReasonCode(''); setReasonOther(''); }} className={`rounded-lg px-3 py-2 text-xs font-semibold ${action === 'APPROVE' ? 'bg-emerald-600 text-white' : 'border border-slate-200 dark:border-slate-700'}`}>Approve</button>
                  <button onClick={() => { setAction('REJECT'); setReasonCode(''); setReasonOther(''); }} className={`rounded-lg px-3 py-2 text-xs font-semibold ${action === 'REJECT' ? 'bg-rose-600 text-white' : 'border border-slate-200 dark:border-slate-700'}`}>Reject</button>
                </div>
                <div className="grid gap-2 md:grid-cols-[1fr_1.5fr_auto]">
                  <select value={reasonCode} onChange={e => setReasonCode(e.target.value)} className="rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent px-2.5 py-2 text-xs">
                    <option value="">Select reason…</option>
                    {reasons.map(reason => <option key={reason.code} value={reason.code}>{reason.label}</option>)}
                  </select>
                  {reasonCode === 'OTHER' && <input aria-label="Other reason" value={reasonOther} onChange={e => setReasonOther(e.target.value)} placeholder="Other reason" className="rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent px-2.5 py-2 text-xs" />}
                  <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional notes" className="rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent px-2.5 py-2 text-xs" />
                  <button disabled={submitting || loadingBundle || !reasonCode || !bundle || bundle.review.channelId !== current.channelId} onClick={() => void submit()} className="rounded-lg bg-indigo-600 text-white px-4 py-2 text-xs font-semibold disabled:opacity-40 inline-flex items-center justify-center gap-2">
                    {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : action === 'APPROVE' ? <CheckCircle2 className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
                    Submit
                  </button>
                </div>
              </div>
              <div className="text-[10px] text-slate-400 mt-2">Reviewer identity and authorization come from the existing operator session. Decisions are immutable and version-checked.</div>
            </Section>
          </>
        )}
      </div>
    </div>
  );
};
