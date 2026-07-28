import React, { useEffect, useState } from 'react';
import { CountryVocabulary } from '../types';
import { Search, Sparkles, Play, CheckCircle2, ShieldAlert, Terminal, Check, ArrowRight, Loader2, XCircle } from 'lucide-react';

interface Props {
  vocabularies: CountryVocabulary[];
  onManualSearch: (query: string, country: string) => Promise<any>;
  onAutomatedSearch: (country: string) => Promise<void>;
}

export const SearchPanel: React.FC<Props> = ({ vocabularies, onManualSearch, onAutomatedSearch }) => {
  const [manualQuery, setManualQuery] = useState('');
  const [manualCountry, setManualCountry] = useState(vocabularies[0]?.country || 'United States');
  const [autoCountry, setAutoCountry] = useState(vocabularies[0]?.country || 'Germany');
  
  const [isSearchingManual, setIsSearchingManual] = useState(false);
  const [isSearchingAuto, setIsSearchingAuto] = useState(false);
  const [currentStage, setCurrentStage] = useState<string | null>(null);
  const [executionResult, setExecutionResult] = useState<any>(null);
  const [autoSuccessMsg, setAutoSuccessMsg] = useState('');

  const session = executionResult?.session;
  useEffect(() => {
    if (!session?.id || !['RUNNING', 'CANCEL_REQUESTED'].includes(session.status)) return;
    const timer = setInterval(async () => {
      const response = await fetch(`/api/search/manual/sessions/${session.id}`);
      if (response.ok) { const updatedSession = await response.json(); setExecutionResult((current: any) => ({ ...current, session: updatedSession })); }
    }, 2000);
    return () => clearInterval(timer);
  }, [session?.id, session?.status]);

  const cancelManualSearch = async () => {
    if (!session?.id) return;
    const response = await fetch(`/api/search/manual/sessions/${session.id}/cancel`, { method: 'POST' });
    if (response.ok) { const updatedSession = await response.json(); setExecutionResult((current: any) => ({ ...current, session: updatedSession })); }
  };

  // Find vocabulary for automated generator preview
  const selectedVocab = vocabularies.find(v => v.country === autoCountry) || vocabularies[0];

  const handleManualSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualQuery.trim()) return;

    setIsSearchingManual(true);
    setExecutionResult(null);
    setCurrentStage('QUEUED');

    try {
      // Simulate visual transition through pipeline steps before completion
      const steps = ['QUEUED', 'SEARCHING', 'PROCESSING CHANNELS', 'VALIDATING COUNTRY', 'INSPECTING', 'COMPLETED'];
      
      const res = await onManualSearch(manualQuery, manualCountry);
      setExecutionResult(res);
      setCurrentStage('COMPLETED');
    } catch (e: any) {
      alert(e.message || 'Search failed');
      setCurrentStage(null);
    } finally {
      setIsSearchingManual(false);
    }
  };

  const handleAutoSubmit = async () => {
    setIsSearchingAuto(true);
    setAutoSuccessMsg('');
    try {
      await onAutomatedSearch(autoCountry);
      setAutoSuccessMsg(`Generated native trading queries for ${autoCountry} and queued jobs.`);
    } catch (e: any) {
      alert(e.message || 'Automated search failed');
    } finally {
      setIsSearchingAuto(false);
    }
  };

  return (
    <div className="space-y-6">
      
      {/* Strict Workflow Principles Banner */}
      <div className="p-4 rounded-xl border border-amber-200 dark:border-amber-900/40 bg-amber-50/60 dark:bg-amber-950/20 text-amber-900 dark:text-amber-200 text-xs leading-relaxed flex items-start gap-3 shadow-xs">
        <ShieldAlert className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
        <div>
          <strong className="font-bold text-amber-950 dark:text-amber-100 block text-sm">
            Core Rule: Find Traders First. Find Communities Second.
          </strong>
          Searching for "discord trading" or "forex discord" is strictly prohibited because it brings spam-heavy, low-quality channels. The engine searches YouTube using native trading terminology (e.g. <em>NQ futures, DAX Analyse, Order flow</em>) and then extracts active Discord communities from discovered creators.
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* 1. MANUAL SEARCH MODE */}
        <div className="p-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs flex flex-col justify-between">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Search className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
              <h3 className="font-bold text-sm text-slate-900 dark:text-white">Manual Search Mode</h3>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
              Execute a targeted trading query for a specific allowed country.
            </p>

            <form onSubmit={handleManualSubmit} className="space-y-3">
              <div>
                <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400 mb-1">
                  Custom Trading Query
                </label>
                <input
                  type="text"
                  value={manualQuery}
                  onChange={e => setManualQuery(e.target.value)}
                  placeholder="e.g. NQ futures order flow, DAX Analyse, CAC 40 trading"
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-indigo-500"
                  required
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400 mb-1">
                  Target Country
                </label>
                <select
                  value={manualCountry}
                  onChange={e => setManualCountry(e.target.value)}
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-indigo-500"
                >
                  {vocabularies.map(v => (
                    <option key={v.country} value={v.country}>
                      {v.country} ({v.languages.join(', ')})
                    </option>
                  ))}
                </select>
              </div>

              {/* Required Status Flow Pipeline Display */}
              {(isSearchingManual || executionResult) && (
                <div className="mt-4 p-3.5 rounded-xl border border-indigo-200 dark:border-indigo-900/60 bg-indigo-50/50 dark:bg-indigo-950/30 space-y-3">
                  <div className="flex items-center justify-between text-xs font-bold text-slate-800 dark:text-slate-200">
                    <span className="flex items-center gap-1.5">
                      <Terminal className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                      Execution Status Flow:
                    </span>
                    {isSearchingManual || session?.status === 'RUNNING' || session?.status === 'CANCEL_REQUESTED' ? (
                      <span className="flex items-center gap-1 text-indigo-600 dark:text-indigo-400 text-[11px] animate-pulse">
                        <Loader2 className="w-3.5 h-3.5 animate-spin" /> {session?.status === 'CANCEL_REQUESTED' ? 'Cancelling…' : 'Deep discovery running…'}
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400 text-[11px]">
                        <CheckCircle2 className="w-3.5 h-3.5" /> Completed
                      </span>
                    )}
                  </div>

                  {session && (
                    <div className="space-y-2 border-t border-indigo-200 dark:border-indigo-900 pt-3">
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
                        <div><span className="block text-slate-500">Pages completed</span><strong>{session.pagesProcessed}</strong></div>
                        <div><span className="block text-slate-500">Creators discovered</span><strong>{session.uniqueChannelIds.length}</strong></div>
                        <div><span className="block text-slate-500">Quota consumed</span><strong>{session.quotaConsumed} units</strong></div>
                        <div><span className="block text-slate-500">Current page</span><strong>{session.currentPage ?? '—'}</strong></div>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800"><div className="h-full bg-indigo-600 transition-all" style={{ width: `${session.progress}%` }} /></div>
                      <div className="flex items-center justify-between gap-3 text-[11px]">
                        <span>{session.stopReason ? `Stop reason: ${session.stopReason.replaceAll('_', ' ')}` : session.estimatedCompletion ? `Estimated completion: ${new Date(session.estimatedCompletion).toLocaleTimeString()}` : 'Evaluating discovery yield…'}</span>
                        {session.status === 'RUNNING' && <button type="button" onClick={cancelManualSearch} className="flex items-center gap-1 font-semibold text-rose-600 hover:text-rose-700"><XCircle className="h-3.5 w-3.5" /> Cancel</button>}
                      </div>
                    </div>
                  )}

                  {/* Flow Badges */}
                  <div className="flex flex-wrap items-center gap-1 text-[10px] font-mono font-semibold">
                    {['QUEUED', 'SEARCHING', 'PROCESSING CHANNELS', 'VALIDATING COUNTRY', 'INSPECTING', 'COMPLETED'].map((step, idx) => {
                      const isDone = executionResult || (!isSearchingManual && idx < 5);
                      return (
                        <React.Fragment key={step}>
                          {idx > 0 && <ArrowRight className="w-3 h-3 text-slate-400 dark:text-slate-600 shrink-0" />}
                          <span className={`px-2 py-0.5 rounded-md flex items-center gap-1 ${
                            isDone 
                              ? 'bg-emerald-100 dark:bg-emerald-950/80 text-emerald-800 dark:text-emerald-300 border border-emerald-300 dark:border-emerald-800' 
                              : isSearchingManual && idx === 1
                              ? 'bg-indigo-600 text-white animate-pulse'
                              : 'bg-slate-200 dark:bg-slate-800 text-slate-500'
                          }`}>
                            {isDone && <Check className="w-2.5 h-2.5" />}
                            {step}
                          </span>
                        </React.Fragment>
                      );
                    })}
                  </div>
                </div>
              )}

              <button
                type="submit"
                disabled={isSearchingManual}
                className="w-full py-2.5 px-4 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-semibold text-xs rounded-lg shadow-xs transition-colors flex items-center justify-center gap-2"
              >
                {isSearchingManual ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Executing Pipeline...</span>
                  </>
                ) : (
                  <>
                    <Play className="w-3.5 h-3.5 fill-current" />
                    <span>Execute Manual Search</span>
                  </>
                )}
              </button>
            </form>
          </div>
        </div>

        {/* 2. AUTOMATED COUNTRY QUERY GENERATOR */}
        <div className="p-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs flex flex-col justify-between">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Sparkles className="w-4 h-4 text-purple-600 dark:text-purple-400" />
              <h3 className="font-bold text-sm text-slate-900 dark:text-white">Country-Aware Automated Query Generator</h3>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
              Generates country-specific trading searches using real local market vocabulary.
            </p>

            <div className="space-y-3">
              <div>
                <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400 mb-1">
                  Select Country for Native Generation
                </label>
                <select
                  value={autoCountry}
                  onChange={e => setAutoCountry(e.target.value)}
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-purple-500"
                >
                  {vocabularies.map(v => (
                    <option key={v.country} value={v.country}>
                      {v.country}
                    </option>
                  ))}
                </select>
              </div>

              {/* Generated Terms Preview */}
              {selectedVocab && (
                <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 text-xs space-y-1.5">
                  <span className="font-semibold text-slate-700 dark:text-slate-300 block text-[11px]">
                    Native Vocabulary Terms ({selectedVocab.country}):
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {selectedVocab.native_trading_terminology.slice(0, 5).map((term, i) => (
                      <span key={i} className="px-2 py-0.5 bg-purple-100 text-purple-800 dark:bg-purple-950/60 dark:text-purple-300 rounded text-[10px] font-medium">
                        {term}
                      </span>
                    ))}
                    {selectedVocab.popular_instruments.slice(0, 3).map((inst, i) => (
                      <span key={i} className="px-2 py-0.5 bg-slate-200 text-slate-800 dark:bg-slate-700 dark:text-slate-300 rounded text-[10px] font-medium">
                        {inst}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {autoSuccessMsg && (
                <div className="p-2.5 rounded-lg bg-emerald-50 dark:bg-emerald-950/30 text-emerald-800 dark:text-emerald-300 text-xs flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                  <span>{autoSuccessMsg}</span>
                </div>
              )}

              <button
                type="button"
                onClick={handleAutoSubmit}
                disabled={isSearchingAuto}
                className="w-full py-2.5 px-4 bg-purple-600 hover:bg-purple-700 disabled:bg-purple-400 text-white font-semibold text-xs rounded-lg shadow-xs transition-colors flex items-center justify-center gap-2"
              >
                <Sparkles className="w-3.5 h-3.5 fill-current" />
                <span>{isSearchingAuto ? 'Generating Jobs...' : `Generate & Queue Queries for ${autoCountry}`}</span>
              </button>
            </div>
          </div>
        </div>

      </div>

      {/* Execution Logs Terminal */}
      {executionResult && (
        <div className="p-5 rounded-2xl border border-slate-800 bg-slate-950 text-slate-100 shadow-xl space-y-4">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <div className="flex items-center gap-2">
              <Terminal className="w-4 h-4 text-emerald-400" />
              <h4 className="font-mono text-xs font-bold text-white uppercase tracking-wider">
                Pipeline Execution Trace Log
              </h4>
            </div>
            <div className="flex items-center gap-3 text-[11px] font-mono">
              <span className="text-slate-400">Query: <strong className="text-slate-200">{executionResult.sanitizedQuery}</strong></span>
              <span className="text-slate-400">Country: <strong className="text-slate-200">{executionResult.summary?.country}</strong></span>
              <span className="px-2 py-0.5 rounded bg-emerald-950 text-emerald-400 border border-emerald-800 font-semibold">
                Completed
              </span>
            </div>
          </div>

          {/* Metrics Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 font-mono text-[11px]">
            <div className="p-2.5 rounded-lg bg-slate-900/80 border border-slate-800">
              <span className="text-slate-400 block text-[10px]">YouTube API Returned</span>
              <span className="text-base font-bold text-white">{executionResult.summary?.returnedFromYouTube || 0}</span>
            </div>
            <div className="p-2.5 rounded-lg bg-slate-900/80 border border-slate-800">
              <span className="text-slate-400 block text-[10px]">Channels Extracted</span>
              <span className="text-base font-bold text-indigo-400">{executionResult.summary?.extracted || 0}</span>
            </div>
            <div className="p-2.5 rounded-lg bg-slate-900/80 border border-slate-800">
              <span className="text-slate-400 block text-[10px]">Country Validated</span>
              <span className="text-base font-bold text-emerald-400">
                {executionResult.summary?.acceptedCountry || 0} <span className="text-[10px] text-slate-400">({executionResult.summary?.rejectedCountry || 0} rejected)</span>
              </span>
            </div>
            <div className="p-2.5 rounded-lg bg-slate-900/80 border border-slate-800">
              <span className="text-slate-400 block text-[10px]">Database Inserts/Updates</span>
              <span className="text-base font-bold text-amber-400">{executionResult.summary?.insertedOrUpdatedInDb || 0}</span>
            </div>
          </div>

          {/* Terminal Console Logs */}
          <div className="p-3.5 rounded-xl bg-black/60 border border-slate-800 font-mono text-[11px] leading-relaxed text-emerald-400/90 max-h-60 overflow-y-auto space-y-1">
            {executionResult.logs?.map((log: string, idx: number) => (
              <div key={idx} className={log.startsWith('[Stage') ? 'text-indigo-300 font-bold mt-2' : log.includes('REJECTED') ? 'text-amber-400 font-semibold' : ''}>
                {log}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
