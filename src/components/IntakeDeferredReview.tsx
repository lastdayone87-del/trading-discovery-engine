import React, { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, newRequestId } from '../apiClient';
import { responseError } from '../reviewDecision';

type Decision = 'TRADING' | 'NON_TRADING' | 'AMBIGUOUS';

interface DeferredItem {
  channelId: string;
  channelName: string;
  youtubeUrl: string;
  country: string | null;
  countryStatus: string | null;
  confidenceScore: number;
  tradingStatus: string | null;
  scanStatus: string | null;
  language: string | null;
  metadataQuality: string | null;
  reviewVersion: number;
  state: 'PENDING' | 'DECIDED' | 'SUPERSEDED';
  decision: Decision | null;
  reviewer: string | null;
  reason: string | null;
  notes: string | null;
  corrections: Record<string, unknown>;
  systemSnapshot: Record<string, unknown>;
  evidenceSnapshot: Record<string, unknown>;
  recheckAttempts: number;
  lastCheckedAt: string | null;
  nextRecheckAt: string | null;
  decidedAt: string | null;
  createdAt: string;
}

interface DeferredDetails extends DeferredItem {
  history: Array<Record<string, any>>;
  inspectionTrail: Array<Record<string, any>>;
  latestJob: { id: string; status: string; payload: Record<string, any>; created_at: string } | null;
}

function reviewerHeaders(): Record<string, string> {
  // apiFetch already adds the operator token (with the legacy review-token
  // fallback). Only the individual reviewer identity is added here so a stale
  // review-token cannot override a valid operator session.
  const reviewer = localStorage.getItem('reviewer-id') || '';
  return reviewer ? { 'X-Reviewer-Id': reviewer } : {};
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

const IntakeDeferredReview: React.FC = () => {
  const selectionRequest = useRef(0);
  const [items, setItems] = useState<DeferredItem[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [selected, setSelected] = useState<DeferredDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [search, setSearch] = useState('');
  const [country, setCountry] = useState('');
  const [language, setLanguage] = useState('');
  const [stateFilter, setStateFilter] = useState<'PENDING' | 'DECIDED' | 'SUPERSEDED' | 'ALL'>('PENDING');
  const [decision, setDecision] = useState<Decision>('TRADING');
  const [reason, setReason] = useState('Human verification after bounded evidence recheck.');
  const [notes, setNotes] = useState('');
  const [correctedCountry, setCorrectedCountry] = useState('');
  const [correctedLanguage, setCorrectedLanguage] = useState('');
  const [busy, setBusy] = useState(false);

  const loadList = useCallback(async (nextOffset = 0) => {
    setLoading(true); setError('');
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set('search', search.trim());
      if (country.trim()) params.set('country', country.trim());
      if (language.trim()) params.set('language', language.trim());
      if (stateFilter !== 'ALL') params.set('state', stateFilter);
      params.set('limit', '100');
      params.set('offset', String(nextOffset));
      const response = await apiFetch(`/api/intake-deferred?${params}`, { headers: reviewerHeaders() });
      if (!response.ok) throw new Error(await responseError(response));
      const page = await response.json() as DeferredItem[];
      setItems(page);
      setOffset(nextOffset);
      setHasMore(page.length === 100);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to load deferred intake channels.');
    } finally { setLoading(false); }
  }, [search, country, language, stateFilter]);

  const loadDetails = async (channelId: string) => {
    const requestId = selectionRequest.current + 1;
    selectionRequest.current = requestId;
    setLoading(true); setError(''); setSuccess('');
    try {
      const response = await apiFetch(`/api/intake-deferred/${encodeURIComponent(channelId)}`, { headers: reviewerHeaders() });
      if (!response.ok) throw new Error(await responseError(response));
      const details = await response.json() as DeferredDetails;
      if (selectionRequest.current !== requestId) return;
      setSelected(details);
      setCorrectedCountry('');
      setCorrectedLanguage('');
      setReason(details.reason || 'Human verification after bounded evidence recheck.');
      setNotes(details.notes || '');
      setDecision(details.decision === 'NON_TRADING' ? 'NON_TRADING' : details.decision === 'AMBIGUOUS' ? 'AMBIGUOUS' : 'TRADING');
    } catch (e) {
      if (selectionRequest.current === requestId) {
        setError(e instanceof Error ? e.message : 'Unable to load deferred channel details.');
      }
    } finally {
      if (selectionRequest.current === requestId) setLoading(false);
    }
  };

  useEffect(() => { void loadList(0); }, []);

  const submitDecision = async () => {
    if (!selected || selected.state !== 'PENDING') return;
    const submittedChannelId = selected.channelId;
    const submittedToken = selectionRequest.current;
    setBusy(true); setError(''); setSuccess('');
    try {
      const corrections: Record<string, unknown> = {};
      const countryValue = correctedCountry.trim();
      const languageValue = correctedLanguage.trim();
      if (countryValue && countryValue !== (selected.country || '')) corrections.country = countryValue;
      if (languageValue && languageValue !== (selected.language || '')) corrections.language = languageValue;
      const response = await apiFetch(`/api/intake-deferred/${encodeURIComponent(selected.channelId)}/decision`, {
        method: 'POST',
        headers: {
          ...reviewerHeaders(),
          'Content-Type': 'application/json',
          'Idempotency-Key': newRequestId(),
        },
        body: JSON.stringify({
          reviewVersion: selected.reviewVersion,
          decision,
          reason: reason.trim(),
          notes: notes.trim(),
          corrections,
        }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      const result = await response.json();
      setSuccess(`Decision saved at version ${result.reviewVersion || selected.reviewVersion + 1}.`);
      if (selectionRequest.current === submittedToken) {
        await loadDetails(submittedChannelId);
      }
      await loadList(offset);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to save the intake decision.');
    } finally { setBusy(false); }
  };

  const evidence = selected ? asRecord(selected.evidenceSnapshot) : {};
  const candidate = asRecord(evidence.candidate);
  const focus = asRecord(evidence.focus);
  const system = selected ? asRecord(selected.systemSnapshot) : {};
  const videoTitles = Array.isArray(candidate.videoTitles) ? candidate.videoTitles as string[] : [];
  const videoDescriptions = Array.isArray(candidate.videoDescriptions) ? candidate.videoDescriptions as string[] : [];

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold text-slate-900 dark:text-white">Deferred intake review</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Machine-deferred channels. Decisions are stored as human-verified labels; system predictions are shown separately and are not ground truth.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search channel" className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs dark:border-slate-700 dark:bg-slate-950" />
            <input value={country} onChange={e => setCountry(e.target.value)} placeholder="Country" className="w-28 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs dark:border-slate-700 dark:bg-slate-950" />
            <input value={language} onChange={e => setLanguage(e.target.value)} placeholder="Language" className="w-28 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs dark:border-slate-700 dark:bg-slate-950" />
            <select value={stateFilter} onChange={e => setStateFilter(e.target.value as typeof stateFilter)} aria-label="Review state" className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs dark:border-slate-700 dark:bg-slate-950">
              <option value="PENDING">Pending</option>
              <option value="DECIDED">Decided</option>
              <option value="SUPERSEDED">Superseded</option>
              <option value="ALL">All states</option>
            </select>
            <button onClick={() => void loadList(0)} className="rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white">Refresh</button>
          </div>
        </div>
        {error && <div className="mt-3 rounded-lg bg-rose-50 p-2 text-xs text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">{error}</div>}
        {success && <div className="mt-3 rounded-lg bg-emerald-50 p-2 text-xs text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">{success}</div>}
        <div className="mt-3 overflow-x-auto">
          <table className="min-w-full text-left text-xs">
            <thead className="text-slate-500 dark:text-slate-400">
              <tr>
                <th className="px-2 py-2">Channel</th>
                <th className="px-2 py-2">Country</th>
                <th className="px-2 py-2">Language</th>
                <th className="px-2 py-2">Metadata</th>
                <th className="px-2 py-2">Rechecks</th>
                <th className="px-2 py-2">Next recheck</th>
                <th className="px-2 py-2">Decision</th>
              </tr>
            </thead>
            <tbody>
              {items.map(item => (
                <tr key={item.channelId} className="border-t border-slate-100 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/50">
                  <td className="px-2 py-2 font-semibold text-slate-900 dark:text-white">
                    <button type="button" onClick={() => void loadDetails(item.channelId)} className="text-left hover:underline focus:underline focus:outline-none">
                      {item.channelName}
                    </button>
                  </td>
                  <td className="px-2 py-2">{item.country || 'UNKNOWN'} <span className="text-slate-400">({item.countryStatus || 'UNCERTAIN'})</span></td>
                  <td className="px-2 py-2">{item.language || 'und'}</td>
                  <td className="px-2 py-2">{item.metadataQuality || 'UNKNOWN'}</td>
                  <td className="px-2 py-2">{item.recheckAttempts}</td>
                  <td className="px-2 py-2">{item.nextRecheckAt ? new Date(item.nextRecheckAt).toLocaleString() : '—'}</td>
                  <td className="px-2 py-2">{item.decision || item.state}</td>
                </tr>
              ))}
              {!items.length && !loading && <tr><td colSpan={7} className="px-2 py-6 text-center text-slate-500">No deferred channels.</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="mt-3 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
          <span>{items.length ? `Showing ${offset + 1}–${offset + items.length}` : 'No rows'}</span>
          <span className="flex gap-2">
            <button disabled={offset === 0 || loading} onClick={() => void loadList(Math.max(0, offset - 100))} className="rounded-lg border border-slate-300 px-3 py-1.5 font-semibold disabled:opacity-40 dark:border-slate-700">Previous</button>
            <button disabled={!hasMore || loading} onClick={() => void loadList(offset + 100)} className="rounded-lg border border-slate-300 px-3 py-1.5 font-semibold disabled:opacity-40 dark:border-slate-700">Next</button>
          </span>
        </div>
        {loading && <div className="mt-2 text-xs text-slate-500">Loading…</div>}
      </div>

      {selected && (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-slate-200 bg-white p-4 text-xs dark:border-slate-800 dark:bg-slate-900">
            <h3 className="text-sm font-bold text-slate-900 dark:text-white">{selected.channelName}</h3>
            <a href={selected.youtubeUrl} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline dark:text-indigo-400">{selected.youtubeUrl}</a>
            <div className="mt-2 grid grid-cols-2 gap-2 text-slate-600 dark:text-slate-300">
              <div>Country: <b>{selected.country || 'UNKNOWN'}</b> ({selected.countryStatus || 'UNCERTAIN'})</div>
              <div>Confidence: <b>{selected.confidenceScore}</b></div>
              <div>Language: <b>{selected.language || 'und'}</b></div>
              <div>Metadata: <b>{selected.metadataQuality || 'UNKNOWN'}</b></div>
              <div>Trading: <b>{selected.tradingStatus || 'UNCERTAIN'}</b></div>
              <div>Scan: <b>{selected.scanStatus || 'UNKNOWN'}</b></div>
              <div>Review state: <b>{selected.state}</b></div>
            </div>
            <div className="mt-3">
              <div className="font-semibold text-slate-800 dark:text-slate-200">System reason</div>
              <pre className="mt-1 max-h-40 overflow-auto rounded-lg bg-slate-50 p-2 text-[11px] dark:bg-slate-950">{JSON.stringify({ reasonCodes: system.reasonCodes, positiveFamilies: system.positiveFamilies, negativeFamilies: system.negativeFamilies, country: system.country, countryStatus: system.countryStatus }, null, 2)}</pre>
            </div>
            <div className="mt-3">
              <div className="font-semibold text-slate-800 dark:text-slate-200">Bio</div>
              <p className="mt-1 whitespace-pre-wrap text-slate-600 dark:text-slate-300">{String(candidate.description || 'No bio stored.')}</p>
            </div>
            <div className="mt-3">
              <div className="font-semibold text-slate-800 dark:text-slate-200">Video evidence</div>
              <ul className="mt-1 list-disc space-y-1 pl-4 text-slate-600 dark:text-slate-300">
                {videoTitles.slice(0, 10).map((title, index) => <li key={`${title}-${index}`}>{title}{videoDescriptions[index] ? ` — ${String(videoDescriptions[index]).slice(0, 160)}` : ''}</li>)}
                {!videoTitles.length && <li>No video sample stored.</li>}
              </ul>
            </div>
            <div className="mt-3">
              <div className="font-semibold text-slate-800 dark:text-slate-200">Country evidence</div>
              <pre className="mt-1 max-h-32 overflow-auto rounded-lg bg-slate-50 p-2 text-[11px] dark:bg-slate-950">{JSON.stringify(selected.inspectionTrail, null, 2)}</pre>
            </div>
            <div className="mt-3">
              <div className="font-semibold text-slate-800 dark:text-slate-200">Human history</div>
              <pre className="mt-1 max-h-32 overflow-auto rounded-lg bg-slate-50 p-2 text-[11px] dark:bg-slate-950">{JSON.stringify(selected.history, null, 2)}</pre>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-4 text-xs dark:border-slate-800 dark:bg-slate-900">
            <h3 className="text-sm font-bold text-slate-900 dark:text-white">Human decision</h3>
            <p className="mt-1 text-slate-500 dark:text-slate-400">System prediction: <b>{selected.tradingStatus || 'UNCERTAIN'}</b>. This is not the label.</p>
            <label htmlFor="intake-decision" className="mt-3 block font-semibold">Decision</label>
            <select id="intake-decision" value={decision} onChange={e => setDecision(e.target.value as Decision)} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-950">
              <option value="TRADING">TRADING</option>
              <option value="NON_TRADING">NON_TRADING</option>
              <option value="AMBIGUOUS">AMBIGUOUS / insufficient evidence</option>
            </select>
            <label htmlFor="intake-reason" className="mt-3 block font-semibold">Reason</label>
            <textarea id="intake-reason" value={reason} onChange={e => setReason(e.target.value)} rows={3} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-950" />
            <label htmlFor="intake-notes" className="mt-3 block font-semibold">Notes / corrections</label>
            <textarea id="intake-notes" value={notes} onChange={e => setNotes(e.target.value)} rows={3} placeholder="What evidence did you inspect? What did the system miss?" className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-950" />
            <div className="mt-3 grid grid-cols-2 gap-2">
              <div><label htmlFor="intake-country" className="block font-semibold">Corrected country</label><input id="intake-country" value={correctedCountry} onChange={e => setCorrectedCountry(e.target.value)} placeholder={selected.country || 'UNKNOWN'} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-950" /></div>
              <div><label htmlFor="intake-language" className="block font-semibold">Corrected language</label><input id="intake-language" value={correctedLanguage} onChange={e => setCorrectedLanguage(e.target.value)} placeholder={selected.language || 'und'} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-950" /></div>
            </div>
            {selected.state !== 'PENDING' && (
              <p className="mt-3 rounded-lg bg-amber-50 p-2 text-[11px] text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                This review is {selected.state}. Decisions are immutable.
                {selected.state === 'DECIDED' && selected.decision === 'AMBIGUOUS'
                  ? ' A changed-evidence recheck will open a new review version.'
                  : ' This row is retained for audit only.'}
              </p>
            )}
            <button disabled={busy || selected.state !== 'PENDING' || !reason.trim()} onClick={() => void submitDecision()} className="mt-4 rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white disabled:opacity-40">
              {busy ? 'Saving…' : 'Save human decision'}
            </button>
            <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">TRADING returns the channel to normal enrichment; NON_TRADING closes it; AMBIGUOUS keeps it deferred for a later evidence recheck.</p>
          </div>
        </div>
      )}
    </div>
  );
};

export default IntakeDeferredReview;
