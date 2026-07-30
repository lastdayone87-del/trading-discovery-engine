import { AUTH_REQUIRED_EVENT, apiFetch, operatorToken, setOperatorToken } from './apiClient';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { ChannelRecord, CountryVocabulary, DashboardOperationalSummary, ExcludedCountry, QueueStatus, QuotaInfo } from './types';
import { Navbar } from './components/Navbar';
import { SearchPanel } from './components/SearchPanel';
import { ResultsTable } from './components/ResultsTable';
import type { DashboardChannelFilters } from './components/ResultsTable';
import { PendingRecheckPanel } from './components/PendingRecheckPanel';
import { QueueMonitor } from './components/QueueMonitor';
import { CountrySettings } from './components/CountrySettings';
import { InspectionModal } from './components/InspectionModal';
import { QueryIntelligenceEngine } from './components/QueryIntelligenceEngine';
import { RegressionSuiteDashboard } from './components/RegressionSuiteDashboard';
import { channelListingSearchParams } from './channelListingQuery';

export default function App() {
  const [activeTab, setActiveTab] = useState<'discovery' | 'intelligence' | 'regression' | 'results' | 'pending' | 'queues' | 'settings'>('discovery');


  const [channels, setChannels] = useState<ChannelRecord[]>([]);
  const [channelTotal, setChannelTotal] = useState(0);
  const [channelOffset, setChannelOffset] = useState(0);
  const listingRevision = useRef<string | null>(null);
  const [channelFilters,setChannelFilters]=useState<DashboardChannelFilters>({search:'',country:'ALL',countryStatus:'ALL',tradingStatus:'ALL',discordStatus:'ALL',scanStatus:'ALL'});
  const [includeRejected, setIncludeRejected] = useState(false);
  const [vocabularies, setVocabularies] = useState<CountryVocabulary[]>([]);
  const [excludedCountries, setExcludedCountries] = useState<ExcludedCountry[]>([]);
  const [queueStatus, setQueueStatus] = useState<QueueStatus | null>(null);
  const [quotaInfo, setQuotaInfo] = useState<QuotaInfo | null>(null);
  const [operationalSummary,setOperationalSummary]=useState<DashboardOperationalSummary|null>(null);
  const [accessToken, setAccessToken] = useState(() => operatorToken());
  const [tokenDraft, setTokenDraft] = useState(() => operatorToken());
  const [authError, setAuthError] = useState<'missing' | 'invalid' | null>(() => operatorToken() ? null : 'missing');

  const [inspectingChannel, setInspectingChannel] = useState<ChannelRecord | null>(null);

  // Fetch Channels
  const fetchChannels = useCallback(async (overrideInclude?: boolean, overrideOffset?: number) => {
    try {
      const showAll = overrideInclude !== undefined ? overrideInclude : includeRejected;
      const offset=overrideOffset ?? channelOffset;
      const params=channelListingSearchParams(channelFilters,showAll);params.set('limit','100');params.set('offset',String(offset));
      const res = await apiFetch(`/api/channels?${params}`);
      const cType = res.headers.get('content-type');
      if (res.ok && cType && cType.includes('application/json')) {
        const data = await res.json();
        setChannels(data.items); setChannelTotal(data.total); listingRevision.current=data.revision;
      }
    } catch (e) {
      console.error('Failed to fetch channels:', e);
    }
  },[includeRejected,channelOffset,channelFilters]);

  useEffect(() => {
    const onAuthRequired = (event: Event) => {
      const status = (event as CustomEvent<{ status: number }>).detail?.status;
      setAuthError('invalid');
    };
    window.addEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);
  }, []);

  // Fetch Vocabularies & Exclusions
  const fetchSettings = async () => {
    try {
      const [vRes, eRes] = await Promise.all([
        apiFetch('/api/country-vocabularies'),
        apiFetch('/api/excluded-countries')
      ]);
      const vType = vRes.headers.get('content-type');
      const eType = eRes.headers.get('content-type');
      if (vRes.ok && vType && vType.includes('application/json')) setVocabularies(await vRes.json());
      if (eRes.ok && eType && eType.includes('application/json')) setExcludedCountries(await eRes.json());
    } catch (e) {
      console.error('Failed to fetch settings:', e);
    }
  };

  // Fetch Queue & Quota Status
  const fetchQueueStatus = async () => {
    try {
      const res = await apiFetch('/api/queues/status');
      const cType = res.headers.get('content-type');
      if (res.ok && cType && cType.includes('application/json')) {
        const data = await res.json();
        setQueueStatus(data.queues);
        setQuotaInfo(data.quota);
      }
    } catch (e) {
      console.error('Failed to fetch queue status:', e);
    }
  };
  const fetchOperationalSummary=async()=>{try{const response=await apiFetch('/api/dashboard/summary');if(response.ok)setOperationalSummary(await response.json());}catch(error){console.error('Failed to fetch dashboard summary:',error);}};

  // Poll Data
  useEffect(() => {
    if (!accessToken) return;
    fetchChannels();
    fetchSettings();
    fetchQueueStatus();
    fetchOperationalSummary();

    const revisionInterval = setInterval(async () => {
      if(document.hidden)return;
      const params=channelListingSearchParams(channelFilters,includeRejected);
      const response=await apiFetch(`/api/channels-revision?${params}`);
      if(response.ok){const snapshot=await response.json();if(snapshot.revision!==listingRevision.current)await fetchChannels();}
    }, 3000);
    const statusInterval=setInterval(()=>{if(!document.hidden){void fetchQueueStatus();void fetchOperationalSummary();}},10000);

    return () => {clearInterval(revisionInterval);clearInterval(statusInterval);};
  }, [includeRejected, accessToken, fetchChannels]);

  const changeChannelPage=(offset:number)=>{setChannelOffset(offset);void fetchChannels(undefined,offset);};

  const inspectChannel=async(channel:ChannelRecord)=>{const response=await apiFetch(`/api/channels/${encodeURIComponent(channel.channel_id)}`);setInspectingChannel(response.ok?await response.json():channel);};
  const updateChannelFilters=useCallback((filters:DashboardChannelFilters)=>{setChannelFilters(filters);setChannelOffset(0);},[]);

  const authenticateDashboard = (event: React.FormEvent) => {
    event.preventDefault();
    const token = tokenDraft.trim();
    setOperatorToken(token);
    setAccessToken(token);
    setAuthError(token ? null : 'missing');
  };

  if (authError) {
    const message = authError === 'missing'
      ? 'Enter the production operator or administrator token to load runtime data.'
      : 'The API rejected this credential. Verify the deployed operator token and try again.';
    return (
      <main className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6">
        <form onSubmit={authenticateDashboard} className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl space-y-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-widest text-indigo-400">Trading Discovery Engine</p>
            <h1 className="mt-2 text-xl font-bold">Operator authentication required</h1>
            <p className="mt-2 text-sm leading-6 text-slate-400">{message}</p>
          </div>
          <label className="block text-xs font-semibold text-slate-300">
            API token
            <input
              type="password"
              autoComplete="current-password"
              value={tokenDraft}
              onChange={event => setTokenDraft(event.target.value)}
              className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white outline-hidden focus:ring-2 focus:ring-indigo-500"
              autoFocus
              required
            />
          </label>
          <button type="submit" className="w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-indigo-500">
            Load dashboard
          </button>
          <p className="text-[11px] leading-5 text-slate-500">The credential stays in this browser and is sent only as a bearer token to same-origin API requests.</p>
        </form>
      </main>
    );
  }

  // Handlers
  const handleManualSearch = async (query: string, country: string) => {
    const res = await apiFetch('/api/search/manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, country })
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Search failed');
    }
    await fetchChannels();
    await fetchQueueStatus();
    return data;
  };

  const handleAutomatedSearch = async (country: string) => {
    const res = await apiFetch('/api/search/automated', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ country })
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Automated search failed');
    }
    await fetchChannels();
    await fetchQueueStatus();
  };

  const handleRecheck = async (channelId: string) => {
    try {
      const res = await apiFetch(`/api/channels/${channelId}/recheck`, {
        method: 'POST'
      });
      const data = await res.json();
      if (data.channel) {
        setInspectingChannel(data.channel);
      } else if (!data.success && data.message) {
        alert(data.message);
      }
      await fetchChannels();
      await fetchQueueStatus();
    } catch (e: any) {
      console.error('Manual re-scan error:', e);
      alert('Manual re-scan failed: ' + (e.message || 'Unknown error'));
    }
  };

  const handleSaveVocabulary = async (vocab: CountryVocabulary) => {
    await apiFetch('/api/country-vocabularies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(vocab)
    });
    await fetchSettings();
  };

  const handleAddExcluded = async (country: ExcludedCountry) => {
    await apiFetch('/api/excluded-countries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(country)
    });
    await fetchSettings();
  };

  const handleRemoveExcluded = async (countryName: string) => {
    await apiFetch(`/api/excluded-countries/${encodeURIComponent(countryName)}`, {
      method: 'DELETE'
    });
    await fetchSettings();
  };

  const handleTogglePauseQueue = async (queueName: string, isPaused: boolean) => {
    await apiFetch('/api/queues/pause', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queueName, isPaused })
    });
    await fetchQueueStatus();
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 flex flex-col font-sans selection:bg-indigo-500 selection:text-white">
      
      {/* Top Navigation Bar */}
      <Navbar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        queueStatus={queueStatus}
        quotaInfo={quotaInfo}
        matchingResults={channelTotal}
        operationalSummary={operationalSummary}
      />

      {/* Main View Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6">
        
        {activeTab === 'discovery' && (
          <div className="space-y-6">
            <SearchPanel
              vocabularies={vocabularies}
              onManualSearch={handleManualSearch}
              onAutomatedSearch={handleAutomatedSearch}
            />

            {/* Quick Table Preview */}
            <div className="pt-4 border-t border-slate-200 dark:border-slate-800">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-bold text-sm text-slate-900 dark:text-white">
                  Recently Discovered Channels (showing {Math.min(10,channels.length)} of {channelTotal} matching)
                </h3>
                <button
                  onClick={() => setActiveTab('results')}
                  className="text-xs text-indigo-600 dark:text-indigo-400 font-semibold hover:underline"
                >
                  View Full Table &rarr;
                </button>
              </div>

              <ResultsTable
                channels={channels.slice(0, 10)}
                onRecheck={handleRecheck}
                onInspect={inspectChannel}
              />
            </div>
          </div>
        )}

        {activeTab === 'intelligence' && (
          <QueryIntelligenceEngine
            countryVocabularies={vocabularies}
            onManualCycleTriggered={fetchChannels}
          />
        )}

        {activeTab === 'regression' && (
          <RegressionSuiteDashboard />
        )}


        {activeTab === 'results' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between px-1">
              <h2 className="text-sm font-bold text-slate-800 dark:text-slate-200">
                Matching Results: {channelTotal} {includeRejected ? '(including diagnostics / excluded channels)' : '(validated active channels)'}

              </h2>
              <label className="flex items-center gap-2 text-xs font-semibold text-slate-600 dark:text-slate-400 cursor-pointer bg-white dark:bg-slate-900 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 shadow-xs">
                <input
                  type="checkbox"
                  checked={includeRejected}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setIncludeRejected(checked);
                    setChannelOffset(0); fetchChannels(checked,0);
                  }}
                  className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                />
                <span>Show Diagnostics / Excluded Channels</span>
              </label>
            </div>
            <ResultsTable
              channels={channels}
              onRecheck={handleRecheck}
              onInspect={inspectChannel}
              onReviewCompleted={fetchChannels}
              reviewEnabled
              onFiltersChange={updateChannelFilters}
            />
            {channelTotal>100&&<div className="flex items-center justify-end gap-2 text-xs"><button disabled={channelOffset===0} onClick={()=>changeChannelPage(Math.max(0,channelOffset-100))} className="rounded border px-3 py-1.5 disabled:opacity-40">Previous</button><span>{channelOffset+1}–{Math.min(channelOffset+100,channelTotal)} of {channelTotal}</span><button disabled={channelOffset+100>=channelTotal} onClick={()=>changeChannelPage(channelOffset+100)} className="rounded border px-3 py-1.5 disabled:opacity-40">Next</button></div>}
          </div>
        )}

        {activeTab === 'pending' && (
          <PendingRecheckPanel
            channels={channels}
            onRecheck={handleRecheck}
            onInspect={inspectChannel}
          />
        )}

        {activeTab === 'queues' && (
          <QueueMonitor
            queueStatus={queueStatus}
            quotaInfo={quotaInfo}
            onTogglePause={handleTogglePauseQueue}
            onRefresh={fetchQueueStatus}
          />
        )}

        {activeTab === 'settings' && (
          <CountrySettings
            vocabularies={vocabularies}
            excludedCountries={excludedCountries}
            onSaveVocabulary={handleSaveVocabulary}
            onAddExcluded={handleAddExcluded}
            onRemoveExcluded={handleRemoveExcluded}
          />
        )}

      </main>

      {/* Inspection Trail Audit Modal */}
      <InspectionModal
        channel={inspectingChannel}
        onClose={() => setInspectingChannel(null)}
      />

      {/* Footer */}
      <footer className="border-t border-slate-200 dark:border-slate-800 py-4 bg-white dark:bg-slate-900 text-center text-xs text-slate-500">
        Trading Community Discovery Engine — v3.0 Final &bull; Universal Channel Storage Protocol
      </footer>

    </div>
  );
}
