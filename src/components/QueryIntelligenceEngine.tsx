import React, { useState, useEffect } from 'react';
import { QueryRecord, QueryExecutionLog, ExtractedTermRecord, CountryVocabulary } from '../types';
import {
  Brain,
  Sparkles,
  Zap,
  TrendingUp,
  RotateCw,
  Search,
  BookOpen,
  History,
  Layers,
  Award,
  Filter,
  CheckCircle2,
  AlertCircle,
  XCircle,
  Plus,
  Play,
  Pause,
  Globe,
  Flag,
  Check,
  Save,
  ShieldAlert
} from 'lucide-react';

interface Props {
  countryVocabularies: CountryVocabulary[];
  onManualCycleTriggered?: () => void;
}

export const QueryIntelligenceEngine: React.FC<Props> = ({ countryVocabularies }) => {
  const [queries, setQueries] = useState<QueryRecord[]>([]);
  const [extractedVocabulary, setExtractedVocabulary] = useState<ExtractedTermRecord[]>([]);
  const [logs, setLogs] = useState<QueryExecutionLog[]>([]);
  const [status, setStatus] = useState<{
    isRunning: boolean;
    isPaused?: boolean;
    scope?: 'GLOBAL' | 'SELECTED_COUNTRIES';
    selectedCountries?: string[];
    lastRunTime?: string;
    nextScheduledTime?: string;
    lastReport?: any;
  }>({ isRunning: false, isPaused: false, scope: 'GLOBAL', selectedCountries: [] });

  const [selectedCountry, setSelectedCountry] = useState<string>('All');
  const [selectedCollection, setSelectedCollection] = useState<string>('ALL');
  const [isCycleRunning, setIsCycleRunning] = useState(false);
  const [isPauseToggling, setIsPauseToggling] = useState(false);
  const [isGeneratingCandidates, setIsGeneratingCandidates] = useState(false);
  const [activeSubTab, setActiveSubTab] = useState<'library' | 'vocabulary' | 'logs' | 'settings'>('library');

  // Discovery Scope State
  const [scopeMode, setScopeMode] = useState<'GLOBAL' | 'SELECTED_COUNTRIES'>('GLOBAL');
  const [scopeCountries, setScopeCountries] = useState<string[]>([]);
  const [countryToAdd, setCountryToAdd] = useState<string>('');
  const [isSavingScope, setIsSavingScope] = useState(false);
  const [scopeSaveMessage, setScopeSaveMessage] = useState<string | null>(null);

  // Fetch data
  const fetchData = async () => {
    try {
      const [libRes, vocabRes, logRes, statusRes, scopeRes] = await Promise.all([
        fetch('/api/query-intelligence/library'),
        fetch('/api/query-intelligence/vocabulary'),
        fetch('/api/query-intelligence/logs'),
        fetch('/api/query-intelligence/status'),
        fetch('/api/query-intelligence/scope')
      ]);

      if (libRes.ok) setQueries(await libRes.json());
      if (vocabRes.ok) setExtractedVocabulary(await vocabRes.json());
      if (logRes.ok) setLogs(await logRes.json());
      if (statusRes.ok) {
        const statusData = await statusRes.json();
        setStatus(statusData);
      }
      if (scopeRes.ok) {
        const scopeData = await scopeRes.json();
        setScopeMode(scopeData.scope || 'GLOBAL');
        setScopeCountries(scopeData.selectedCountries || []);
      }
    } catch (err) {
      console.error('Error fetching Query Intelligence data:', err);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 10000); // refresh every 10s
    return () => clearInterval(interval);
  }, []);

  // Handle Pause / Resume toggle
  const handleTogglePause = async () => {
    setIsPauseToggling(true);
    try {
      const endpoint = status.isPaused ? '/api/query-intelligence/resume' : '/api/query-intelligence/pause';
      const res = await fetch(endpoint, { method: 'POST' });
      if (res.ok) {
        await fetchData();
      }
    } catch (err) {
      console.error('Error toggling pause state:', err);
    } finally {
      setIsPauseToggling(false);
    }
  };

  // Save Discovery Scope Setting
  const handleSaveScope = async (mode = scopeMode, countries = scopeCountries) => {
    setIsSavingScope(true);
    setScopeSaveMessage(null);
    try {
      const res = await fetch('/api/query-intelligence/scope', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: mode, selectedCountries: countries })
      });
      if (res.ok) {
        const updated = await res.json();
        setScopeMode(updated.scope);
        setScopeCountries(updated.selectedCountries);
        setScopeSaveMessage('Discovery Scope saved successfully.');
        setTimeout(() => setScopeSaveMessage(null), 3000);
        await fetchData();
      }
    } catch (err) {
      console.error('Error saving discovery scope:', err);
      setScopeSaveMessage('Failed to save Discovery Scope.');
    } finally {
      setIsSavingScope(false);
    }
  };

  const handleAddScopeCountry = (country: string) => {
    if (!country || scopeCountries.includes(country)) return;
    const newCountries = [...scopeCountries, country];
    setScopeCountries(newCountries);
    setCountryToAdd('');
    handleSaveScope(scopeMode, newCountries);
  };

  const handleRemoveScopeCountry = (country: string) => {
    const newCountries = scopeCountries.filter(c => c.toLowerCase() !== country.toLowerCase());
    setScopeCountries(newCountries);
    handleSaveScope(scopeMode, newCountries);
  };

  // Trigger manual discovery cycle
  const handleTriggerCycle = async () => {
    setIsCycleRunning(true);
    try {
      const res = await fetch('/api/query-intelligence/run-cycle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ country: selectedCountry !== 'All' ? selectedCountry : undefined })
      });
      if (res.ok) {
        await fetchData();
      }
    } catch (err) {
      console.error('Error triggering cycle:', err);
    } finally {
      setIsCycleRunning(false);
    }
  };

  // Generate candidate queries using AI
  const handleGenerateCandidates = async () => {
    if (selectedCountry === 'All') return;
    setIsGeneratingCandidates(true);
    try {
      const res = await fetch('/api/query-intelligence/generate-candidates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ country: selectedCountry, count: 3 })
      });
      if (res.ok) {
        await fetchData();
      }
    } catch (err) {
      console.error('Error generating candidates:', err);
    } finally {
      setIsGeneratingCandidates(false);
    }
  };

  // Change query collection manually
  const handleMoveCollection = async (queryId: number, collection: 'PROVEN' | 'EXPERIMENTAL' | 'REJECTED') => {
    try {
      const res = await fetch(`/api/query-intelligence/queries/${queryId}/collection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection })
      });
      if (res.ok) {
        await fetchData();
      }
    } catch (err) {
      console.error('Error updating collection:', err);
    }
  };

  // Filter queries
  const filteredQueries = queries.filter(q => {
    const matchCountry = selectedCountry === 'All' || q.country.toLowerCase() === selectedCountry.toLowerCase();
    const matchCollection = selectedCollection === 'ALL' || q.collection === selectedCollection;
    return matchCountry && matchCollection;
  });

  // Calculate statistics
  const provenCount = queries.filter(q => q.collection === 'PROVEN').length;
  const experimentalCount = queries.filter(q => q.collection === 'EXPERIMENTAL').length;
  const rejectedCount = queries.filter(q => q.collection === 'REJECTED').length;

  return (
    <div className="space-y-6">
      {/* Top Banner Header */}
      <div className="bg-gradient-to-r from-slate-900 via-indigo-950 to-slate-900 border border-slate-800 rounded-2xl p-6 text-white shadow-xl">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <div className="p-3 bg-indigo-600/30 border border-indigo-500/40 rounded-xl text-indigo-400">
                <Brain className="w-7 h-7" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-xl font-black tracking-tight">Query Intelligence Engine</h2>
                  <span className="px-2.5 py-0.5 text-xs font-mono font-bold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 rounded-full flex items-center gap-1">
                    <Sparkles className="w-3 h-3 text-indigo-400" /> Self-Learning MAB
                  </span>
                  {status.isPaused && (
                    <span className="px-2.5 py-0.5 text-xs font-mono font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40 rounded-full flex items-center gap-1">
                      <Pause className="w-3 h-3 text-amber-400" /> PAUSED
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-300 mt-0.5">
                  Multi-Armed Bandit (UCB1) query selection, non-engagement creator scoring, and native trading vocabulary learning feedback loop.
                </p>
              </div>
            </div>
          </div>

          {/* Autonomous Controls: Pause / Resume & On-Demand Execution */}
          <div className="flex flex-wrap items-center gap-3">
            {/* Status indicator */}
            <div className="px-4 py-2 bg-slate-800/80 border border-slate-700 rounded-xl flex items-center gap-3 text-xs">
              <div className="flex items-center gap-2">
                <span className={`w-2.5 h-2.5 rounded-full ${
                  status.isPaused
                    ? 'bg-amber-400'
                    : status.isRunning || isCycleRunning
                    ? 'bg-emerald-400 animate-ping'
                    : 'bg-emerald-400'
                }`}></span>
                <span className="text-slate-300 font-medium">
                  {status.isPaused
                    ? 'Engine Paused (State Preserved)'
                    : status.isRunning || isCycleRunning
                    ? 'Executing Cycle...'
                    : '30-Min Scheduler Active'}
                </span>
              </div>
              {!status.isPaused && status.nextScheduledTime && (
                <span className="text-slate-400 font-mono text-[11px] border-l border-slate-700 pl-3">
                  Next: {new Date(status.nextScheduledTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              )}
            </div>

            {/* Pause / Resume Button */}
            <button
              onClick={handleTogglePause}
              disabled={isPauseToggling}
              className={`px-4 py-2.5 font-bold text-xs rounded-xl shadow-lg transition-all flex items-center gap-2 cursor-pointer disabled:opacity-50 ${
                status.isPaused
                  ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
                  : 'bg-amber-600/90 hover:bg-amber-500 text-white border border-amber-500/40'
              }`}
              title={status.isPaused ? 'Resume discovery from saved state' : 'Safely finish current creator and pause engine'}
            >
              {status.isPaused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
              <span>{isPauseToggling ? 'Updating...' : status.isPaused ? 'Resume Engine' : 'Pause Engine'}</span>
            </button>

            {/* On-Demand Cycle Trigger */}
            <button
              onClick={handleTriggerCycle}
              disabled={isCycleRunning || status.isRunning || status.isPaused}
              className="px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white font-bold text-xs rounded-xl shadow-lg transition-all flex items-center gap-2 disabled:opacity-50 cursor-pointer"
            >
              <Play className={`w-4 h-4 ${isCycleRunning ? 'animate-spin' : ''}`} />
              <span>{isCycleRunning ? 'Running Intelligence Cycle...' : 'Run Cycle On-Demand'}</span>
            </button>
          </div>
        </div>

        {/* Persistent Discovery Scope Bar */}
        <div className="mt-5 p-4 bg-slate-800/60 border border-slate-700/80 rounded-xl text-xs space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-2 font-bold text-slate-200">
              <Globe className="w-4 h-4 text-indigo-400" />
              <span>Persistent Discovery Scope:</span>
              <span className={`px-2.5 py-0.5 rounded-full text-[11px] font-mono font-black uppercase ${
                scopeMode === 'GLOBAL' ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/40' : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
              }`}>
                {scopeMode === 'GLOBAL' ? 'Global (Automatic)' : `Selected Countries (${scopeCountries.length})`}
              </span>
            </div>

            {/* Scope Mode Switcher */}
            <div className="flex items-center gap-2 bg-slate-900/80 p-1 rounded-lg border border-slate-700">
              <button
                onClick={() => {
                  setScopeMode('GLOBAL');
                  handleSaveScope('GLOBAL', scopeCountries);
                }}
                className={`px-3 py-1 rounded-md font-bold text-[11px] transition-all flex items-center gap-1.5 cursor-pointer ${
                  scopeMode === 'GLOBAL' ? 'bg-indigo-600 text-white shadow-xs' : 'text-slate-400 hover:text-white'
                }`}
              >
                <Globe className="w-3.5 h-3.5" />
                <span>Global</span>
              </button>

              <button
                onClick={() => {
                  setScopeMode('SELECTED_COUNTRIES');
                  handleSaveScope('SELECTED_COUNTRIES', scopeCountries);
                }}
                className={`px-3 py-1 rounded-md font-bold text-[11px] transition-all flex items-center gap-1.5 cursor-pointer ${
                  scopeMode === 'SELECTED_COUNTRIES' ? 'bg-indigo-600 text-white shadow-xs' : 'text-slate-400 hover:text-white'
                }`}
              >
                <Flag className="w-3.5 h-3.5" />
                <span>Selected Countries</span>
              </button>
            </div>
          </div>

          {/* Selected Countries Scope Editor */}
          {scopeMode === 'SELECTED_COUNTRIES' && (
            <div className="pt-2 border-t border-slate-700/60 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-slate-400 font-medium">Prioritized Countries:</span>
                {scopeCountries.length === 0 ? (
                  <span className="text-amber-400 font-medium italic">No countries selected. Please add target countries below!</span>
                ) : (
                  scopeCountries.map(c => (
                    <span key={c} className="px-2.5 py-1 bg-indigo-950/80 border border-indigo-600/50 text-indigo-200 rounded-lg text-xs font-bold flex items-center gap-1.5">
                      <Flag className="w-3 h-3 text-indigo-400" />
                      <span>{c}</span>
                      <button
                        onClick={() => handleRemoveScopeCountry(c)}
                        className="hover:text-rose-400 ml-1 cursor-pointer font-black"
                        title="Remove from scope"
                      >
                        ×
                      </button>
                    </span>
                  ))
                )}
              </div>

              <div className="flex items-center gap-2 pt-1">
                <select
                  value={countryToAdd}
                  onChange={e => {
                    const val = e.target.value;
                    setCountryToAdd(val);
                    if (val) handleAddScopeCountry(val);
                  }}
                  className="px-3 py-1.5 bg-slate-900 border border-slate-700 text-slate-200 text-xs rounded-lg focus:outline-hidden focus:ring-2 focus:ring-indigo-500"
                >
                  <option value="">+ Add Country to Persistent Scope...</option>
                  {countryVocabularies
                    .filter(v => !scopeCountries.some(sc => sc.toLowerCase() === v.country.toLowerCase()))
                    .map(v => (
                      <option key={v.country} value={v.country}>{v.country}</option>
                    ))}
                </select>

                {scopeSaveMessage && (
                  <span className="text-emerald-400 font-mono text-[11px] font-bold flex items-center gap-1">
                    <Check className="w-3.5 h-3.5" /> {scopeSaveMessage}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Quick KPI Bar */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-6 pt-5 border-t border-slate-800/80 text-xs">
          <div className="bg-slate-800/40 p-3 rounded-xl border border-slate-700/50">
            <div className="text-slate-400 flex items-center gap-1.5 mb-1">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
              <span>Proven Queries</span>
            </div>
            <div className="text-lg font-black font-mono text-emerald-400">{provenCount}</div>
          </div>

          <div className="bg-slate-800/40 p-3 rounded-xl border border-slate-700/50">
            <div className="text-slate-400 flex items-center gap-1.5 mb-1">
              <Zap className="w-3.5 h-3.5 text-amber-400" />
              <span>Experimental Queries</span>
            </div>
            <div className="text-lg font-black font-mono text-amber-400">{experimentalCount}</div>
          </div>

          <div className="bg-slate-800/40 p-3 rounded-xl border border-slate-700/50">
            <div className="text-slate-400 flex items-center gap-1.5 mb-1">
              <XCircle className="w-3.5 h-3.5 text-rose-400" />
              <span>Rejected Queries</span>
            </div>
            <div className="text-lg font-black font-mono text-rose-400">{rejectedCount}</div>
          </div>

          <div className="bg-slate-800/40 p-3 rounded-xl border border-slate-700/50">
            <div className="text-slate-400 flex items-center gap-1.5 mb-1">
              <BookOpen className="w-3.5 h-3.5 text-indigo-400" />
              <span>Extracted Local Terms</span>
            </div>
            <div className="text-lg font-black font-mono text-indigo-300">{extractedVocabulary.length}</div>
          </div>
        </div>
      </div>

      {/* Navigation Sub-Tabs & Filters Bar */}
      <div className="bg-white dark:bg-slate-900 p-4 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-xs space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-1.5 bg-slate-100 dark:bg-slate-800/80 p-1 rounded-xl">
            <button
              onClick={() => setActiveSubTab('library')}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 ${
                activeSubTab === 'library'
                  ? 'bg-indigo-600 text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <Layers className="w-3.5 h-3.5" />
              <span>Query Library ({queries.length})</span>
            </button>

            <button
              onClick={() => setActiveSubTab('vocabulary')}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 ${
                activeSubTab === 'vocabulary'
                  ? 'bg-indigo-600 text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <BookOpen className="w-3.5 h-3.5" />
              <span>Extracted Vocabulary ({extractedVocabulary.length})</span>
            </button>

            <button
              onClick={() => setActiveSubTab('logs')}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 ${
                activeSubTab === 'logs'
                  ? 'bg-indigo-600 text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <History className="w-3.5 h-3.5" />
              <span>Discovery Cycle History ({logs.length})</span>
            </button>
          </div>

          {/* Filters */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-2 text-xs">
              <span className="text-slate-500 dark:text-slate-400 flex items-center gap-1 font-medium">
                <Filter className="w-3.5 h-3.5" /> Country:
              </span>
              <select
                value={selectedCountry}
                onChange={e => setSelectedCountry(e.target.value)}
                className="px-3 py-1.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white text-xs font-semibold rounded-xl focus:outline-hidden focus:ring-2 focus:ring-indigo-500"
              >
                <option value="All">All Countries</option>
                {countryVocabularies.map(v => (
                  <option key={v.country} value={v.country}>{v.country}</option>
                ))}
              </select>
            </div>

            {activeSubTab === 'library' && (
              <div className="flex items-center gap-2 text-xs">
                <span className="text-slate-500 dark:text-slate-400 font-medium">Collection:</span>
                <select
                  value={selectedCollection}
                  onChange={e => setSelectedCollection(e.target.value)}
                  className="px-3 py-1.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white text-xs font-semibold rounded-xl focus:outline-hidden focus:ring-2 focus:ring-indigo-500"
                >
                  <option value="ALL">All Collections</option>
                  <option value="PROVEN">Proven Only</option>
                  <option value="EXPERIMENTAL">Experimental Only</option>
                  <option value="REJECTED">Rejected Only</option>
                </select>
              </div>
            )}

            {selectedCountry !== 'All' && activeSubTab === 'library' && (
              <button
                onClick={handleGenerateCandidates}
                disabled={isGeneratingCandidates}
                className="px-3 py-1.5 bg-indigo-50 dark:bg-indigo-950/50 border border-indigo-200 dark:border-indigo-800/80 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100 font-bold text-xs rounded-xl transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
              >
                <Sparkles className="w-3.5 h-3.5 text-indigo-500" />
                <span>{isGeneratingCandidates ? 'Generating...' : 'AI Generate Candidates'}</span>
              </button>
            )}
          </div>
        </div>

        {/* --- SUB-TAB 1: QUERY LIBRARY TABLE --- */}
        {activeSubTab === 'library' && (
          <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
            <table className="w-full text-left border-collapse text-xs">
              <thead className="bg-slate-50 dark:bg-slate-800/80 text-slate-600 dark:text-slate-300 font-extrabold uppercase tracking-wider">
                <tr>
                  <th className="p-3">Query & Intent</th>
                  <th className="p-3">Country</th>
                  <th className="p-3">Collection</th>
                  <th className="p-3 text-center">UCB Score</th>
                  <th className="p-3 text-center">Executions</th>
                  <th className="p-3 text-center">Unique Creators</th>
                  <th className="p-3 text-center">Avg Quality</th>
                  <th className="p-3 text-center">Perf Rating</th>
                  <th className="p-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-slate-700 dark:text-slate-300">
                {filteredQueries.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="p-8 text-center text-slate-400 dark:text-slate-500">
                      No queries found matching the selected filters. Trigger an autonomous cycle or generate AI candidates!
                    </td>
                  </tr>
                ) : (
                  filteredQueries.map(q => {
                    const badgeColor =
                      q.collection === 'PROVEN'
                        ? 'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-800/60'
                        : q.collection === 'EXPERIMENTAL'
                        ? 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-800/60'
                        : 'bg-rose-100 text-rose-800 border-rose-200 dark:bg-rose-950 dark:text-rose-300 dark:border-rose-800/60';

                    return (
                      <tr key={q.id} className="hover:bg-slate-50/80 dark:hover:bg-slate-800/40 transition-colors">
                        <td className="p-3 font-semibold text-slate-900 dark:text-white">
                          <div className="font-mono text-xs">{q.query}</div>
                          <span className="inline-block px-2 py-0.5 mt-1 text-[10px] font-medium bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 rounded-md">
                            {q.intent.replace('_', ' ')}
                          </span>
                        </td>
                        <td className="p-3 font-medium text-slate-600 dark:text-slate-400">{q.country}</td>
                        <td className="p-3">
                          <span className={`px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-wider rounded-md border ${badgeColor}`}>
                            {q.collection}
                          </span>
                        </td>
                        <td className="p-3 text-center font-mono font-bold text-indigo-600 dark:text-indigo-400">
                          {q.ucb_score ?? '--'}
                        </td>
                        <td className="p-3 text-center font-mono">{q.times_executed}</td>
                        <td className="p-3 text-center font-mono font-semibold text-emerald-600 dark:text-emerald-400">
                          {q.unique_channels_found}
                        </td>
                        <td className="p-3 text-center font-mono font-bold">
                          <span className={q.avg_quality_score >= 60 ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-500'}>
                            {q.avg_quality_score}/100
                          </span>
                        </td>
                        <td className="p-3 text-center font-mono font-black text-slate-900 dark:text-white">
                          {q.performance_score}/100
                        </td>
                        <td className="p-3 text-right">
                          <select
                            value={q.collection}
                            onChange={e => handleMoveCollection(q.id, e.target.value as any)}
                            className="px-2 py-1 text-[11px] bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-700 dark:text-slate-300 focus:outline-hidden"
                          >
                            <option value="PROVEN">Set PROVEN</option>
                            <option value="EXPERIMENTAL">Set EXPERIMENTAL</option>
                            <option value="REJECTED">Set REJECTED</option>
                          </select>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* --- SUB-TAB 2: EXTRACTED VOCABULARY --- */}
        {activeSubTab === 'vocabulary' && (
          <div className="space-y-4">
            <p className="text-xs text-slate-500 dark:text-slate-400">
              The engine automatically extracts recurring native trading terminology, popular financial instruments, and localized jargon from discovered high-quality creators and feeds it into future search queries.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {extractedVocabulary.length === 0 ? (
                <div className="col-span-full p-8 text-center text-slate-400 dark:text-slate-500 border border-dashed border-slate-200 dark:border-slate-800 rounded-2xl">
                  No extracted vocabulary yet. Extracted terms will automatically appear here as high-quality trading channels are discovered!
                </div>
              ) : (
                extractedVocabulary.map(item => (
                  <div key={item.id} className="p-3.5 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700/70 rounded-xl space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-black text-slate-900 dark:text-white font-mono">{item.term}</span>
                      <span className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300 rounded-md">
                        {item.category}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400 pt-1">
                      <span>Country: <strong className="text-slate-700 dark:text-slate-300">{item.country}</strong></span>
                      <span className="font-mono">Occurrences: <strong className="text-indigo-600 dark:text-indigo-400">{item.occurrences}</strong></span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* --- SUB-TAB 3: DISCOVERY CYCLE LOGS --- */}
        {activeSubTab === 'logs' && (
          <div className="space-y-3">
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Complete execution history of 30-minute autonomous intelligence cycles.
            </p>
            <div className="space-y-2">
              {logs.length === 0 ? (
                <div className="p-8 text-center text-slate-400 dark:text-slate-500 border border-dashed border-slate-200 dark:border-slate-800 rounded-2xl">
                  No execution logs recorded yet. Trigger a manual cycle or wait for the 30-minute autonomous scheduler.
                </div>
              ) : (
                logs.map(log => (
                  <div key={log.id} className="p-4 bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700/60 rounded-xl space-y-2 text-xs">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-200 dark:border-slate-700/50 pb-2">
                      <div className="flex items-center gap-2">
                        <span className="font-extrabold text-slate-900 dark:text-white font-mono">"{log.query}"</span>
                        <span className="px-2 py-0.5 text-[10px] font-semibold bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 rounded-md">
                          {log.country}
                        </span>
                      </div>
                      <span className="text-[11px] font-mono text-slate-400">
                        {new Date(log.executed_at).toLocaleString()}
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-4 text-slate-600 dark:text-slate-300 font-mono text-[11px]">
                      <span>Discovered: <strong>{log.channels_discovered}</strong></span>
                      <span>Unique New: <strong className="text-emerald-600 dark:text-emerald-400">{log.unique_new_channels}</strong></span>
                      <span>Quality Creators: <strong className="text-indigo-600 dark:text-indigo-400">{log.quality_creators_discovered}</strong></span>
                      <span>Communities Found: <strong className="text-amber-600 dark:text-amber-400">{log.communities_discovered}</strong></span>
                      <span>Cycle Score: <strong className="text-slate-900 dark:text-white">{log.cycle_quality_score}/100</strong></span>
                    </div>

                    {log.logs && log.logs.length > 0 && (
                      <div className="p-2.5 bg-slate-900 text-slate-300 font-mono text-[11px] rounded-lg overflow-x-auto space-y-0.5">
                        {log.logs.map((l, i) => (
                          <div key={i}>{l}</div>
                        ))}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

