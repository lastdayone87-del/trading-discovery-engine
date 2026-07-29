import React, { useState, useEffect } from 'react';
import { ChannelRecord, CountryVocabulary, ExcludedCountry, QueueStatus, QuotaInfo } from './types';
import { Navbar } from './components/Navbar';
import { SearchPanel } from './components/SearchPanel';
import { ResultsTable } from './components/ResultsTable';
import { PendingRecheckPanel } from './components/PendingRecheckPanel';
import { QueueMonitor } from './components/QueueMonitor';
import { CountrySettings } from './components/CountrySettings';
import { InspectionModal } from './components/InspectionModal';
import { QueryIntelligenceEngine } from './components/QueryIntelligenceEngine';
import { RegressionSuiteDashboard } from './components/RegressionSuiteDashboard';
import { ReviewDashboard } from './components/ReviewDashboard';

export default function App() {
  const [activeTab, setActiveTab] = useState<'discovery' | 'intelligence' | 'regression' | 'results' | 'review' | 'pending' | 'queues' | 'settings'>('discovery');


  const [channels, setChannels] = useState<ChannelRecord[]>([]);
  const [includeRejected, setIncludeRejected] = useState(false);
  const [vocabularies, setVocabularies] = useState<CountryVocabulary[]>([]);
  const [excludedCountries, setExcludedCountries] = useState<ExcludedCountry[]>([]);
  const [queueStatus, setQueueStatus] = useState<QueueStatus | null>(null);
  const [quotaInfo, setQuotaInfo] = useState<QuotaInfo | null>(null);

  const [inspectingChannel, setInspectingChannel] = useState<ChannelRecord | null>(null);

  // Fetch Channels
  const fetchChannels = async (overrideInclude?: boolean) => {
    try {
      const showAll = overrideInclude !== undefined ? overrideInclude : includeRejected;
      const res = await fetch(`/api/channels${showAll ? '?include_rejected=true' : ''}`);
      const cType = res.headers.get('content-type');
      if (res.ok && cType && cType.includes('application/json')) {
        const data = await res.json();
        setChannels(data);
      }
    } catch (e) {
      console.error('Failed to fetch channels:', e);
    }
  };

  // Fetch Vocabularies & Exclusions
  const fetchSettings = async () => {
    try {
      const [vRes, eRes] = await Promise.all([
        fetch('/api/country-vocabularies'),
        fetch('/api/excluded-countries')
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
      const res = await fetch('/api/queues/status');
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

  // Poll Data
  useEffect(() => {
    fetchChannels();
    fetchSettings();
    fetchQueueStatus();

    const interval = setInterval(() => {
      fetchChannels();
      fetchQueueStatus();
    }, 3000); // 3-second auto refresh

    return () => clearInterval(interval);
  }, [includeRejected]);

  // Handlers
  const handleManualSearch = async (query: string, country: string) => {
    const res = await fetch('/api/search/manual', {
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
    const res = await fetch('/api/search/automated', {
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
      const res = await fetch(`/api/channels/${channelId}/recheck`, {
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
    await fetch('/api/country-vocabularies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(vocab)
    });
    await fetchSettings();
  };

  const handleAddExcluded = async (country: ExcludedCountry) => {
    await fetch('/api/excluded-countries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(country)
    });
    await fetchSettings();
  };

  const handleRemoveExcluded = async (countryName: string) => {
    await fetch(`/api/excluded-countries/${encodeURIComponent(countryName)}`, {
      method: 'DELETE'
    });
    await fetchSettings();
  };

  const handleTogglePauseQueue = async (queueName: string, isPaused: boolean) => {
    await fetch('/api/queues/pause', {
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
        channels={channels}
        queueStatus={queueStatus}
        quotaInfo={quotaInfo}
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
                  Recently Discovered Channels ({channels.length})
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
                onInspect={channel => setInspectingChannel(channel)}
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
                Discovered Channel Directory ({channels.length} {includeRejected ? 'total records including rejected' : 'validated active channels'})
              </h2>
              <label className="flex items-center gap-2 text-xs font-semibold text-slate-600 dark:text-slate-400 cursor-pointer bg-white dark:bg-slate-900 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 shadow-xs">
                <input
                  type="checkbox"
                  checked={includeRejected}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setIncludeRejected(checked);
                    fetchChannels(checked);
                  }}
                  className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                />
                <span>Show Diagnostics / Excluded Channels</span>
              </label>
            </div>
            <ResultsTable
              channels={channels}
              onRecheck={handleRecheck}
              onInspect={channel => setInspectingChannel(channel)}
            />
          </div>
        )}

        {activeTab === 'pending' && (
          <PendingRecheckPanel
            channels={channels}
            onRecheck={handleRecheck}
            onInspect={channel => setInspectingChannel(channel)}
          />
        )}

        {activeTab === 'review' && <ReviewDashboard />}

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
