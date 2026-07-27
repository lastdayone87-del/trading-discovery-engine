import React from 'react';
import { QueueStatus, QuotaInfo } from '../types';
import { Play, Pause, RefreshCw, Cpu, Layers, Activity } from 'lucide-react';

interface Props {
  queueStatus: QueueStatus | null;
  quotaInfo: QuotaInfo | null;
  onTogglePause: (queueName: string, isPaused: boolean) => Promise<void>;
  onRefresh: () => void;
}

export const QueueMonitor: React.FC<Props> = ({ queueStatus, quotaInfo, onTogglePause, onRefresh }) => {
  if (!queueStatus) return null;

  const queues = [
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
  ];

  const quotaPercent = quotaInfo ? Math.min(100, Math.round((quotaInfo.unitsUsed / quotaInfo.dailyLimit) * 100)) : 0;

  return (
    <div className="space-y-6">
      
      {/* Top Header & Quota Gauge */}
      <div className="p-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Cpu className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
            <h3 className="text-base font-bold text-slate-900 dark:text-white">Crawl Job Queue Engine</h3>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            3 processing queues with pause/resume controls and live quota management.
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
                className={`h-full transition-all duration-500 ${
                  quotaPercent > 85 ? 'bg-rose-500' : quotaPercent > 60 ? 'bg-amber-500' : 'bg-indigo-600'
                }`}
                style={{ width: `${quotaPercent}%` }}
              />
            </div>

            {quotaInfo.keyUsage && quotaInfo.keyUsage.length > 0 && (
              <div className="mt-2.5 pt-2 border-t border-slate-200/60 dark:border-slate-700/60 space-y-1.5">
                <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Per-Key Rotation Breakdown:</div>
                <div className="max-h-28 overflow-y-auto space-y-1 pr-1">
                  {quotaInfo.keyUsage.map((ku) => (
                    <div key={ku.keyIndex} className="flex items-center justify-between text-[11px] bg-white dark:bg-slate-900 px-2 py-1 rounded border border-slate-200/80 dark:border-slate-800">
                      <div className="flex items-center gap-1.5">
                        <span className={`w-1.5 h-1.5 rounded-full ${ku.isActive ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400'}`} />
                        <span className="font-mono font-medium text-slate-700 dark:text-slate-300">Key #{ku.keyIndex} ({ku.maskedKey})</span>
                      </div>
                      <span className="font-mono text-slate-500 dark:text-slate-400">{ku.unitsUsed} / {ku.limit}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex items-center justify-between text-[10px] text-slate-500 dark:text-slate-400 mt-2 pt-1 border-t border-slate-200/40 dark:border-slate-700/40">
              <span>Pool Capacity: {quotaInfo.totalKeys || 1} × 10k</span>
              <span>Reset: {quotaInfo.lastReset}</span>
            </div>
          </div>
        )}
      </div>

      {/* Queue Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {queues.map(q => (
          <div
            key={q.key}
            className={`p-4 rounded-xl border transition-all ${
              q.data.isPaused
                ? 'border-amber-200 bg-amber-50/30 dark:border-amber-900/40 dark:bg-amber-950/10'
                : 'border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 shadow-xs'
            }`}
          >
            <div className="flex items-center justify-between mb-2">
              <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                q.data.isPaused
                  ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-300'
                  : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-300'
              }`}>
                {q.data.isPaused ? 'PAUSED' : 'ACTIVE WORKER'}
              </span>

              <button
                onClick={() => onTogglePause(q.key, !q.data.isPaused)}
                className={`p-1.5 rounded-lg text-xs font-semibold flex items-center gap-1 transition-colors ${
                  q.data.isPaused
                    ? 'bg-emerald-600 hover:bg-emerald-700 text-white'
                    : 'bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300'
                }`}
              >
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
