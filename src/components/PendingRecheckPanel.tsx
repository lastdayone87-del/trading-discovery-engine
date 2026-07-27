import React from 'react';
import { ChannelRecord } from '../types';
import { Clock, RefreshCw, AlertOctagon, CheckCircle2, ShieldAlert } from 'lucide-react';

interface Props {
  channels: ChannelRecord[];
  onRecheck: (channelId: string) => Promise<void>;
  onInspect: (channel: ChannelRecord) => void;
}

export const PendingRecheckPanel: React.FC<Props> = ({ channels, onRecheck, onInspect }) => {
  const pendingOrNotFound = channels.filter(c => c.discord_status === 'PENDING' || c.discord_status === 'NOT_FOUND');
  const failedPermanent = channels.filter(c => c.scan_status === 'FAILED_PERMANENT');

  return (
    <div className="space-y-6">
      
      {/* 1. MANUAL RE-SCAN QUEUE PANEL */}
      <div className="p-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <Clock className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
              <h3 className="text-base font-bold text-slate-900 dark:text-white">Unverified & Pending Channels</h3>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Channels are scanned once upon discovery. Operators can manually trigger a live Re-scan at any time.
            </p>
          </div>
          <span className="px-3 py-1 bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 rounded-full font-mono text-xs font-bold">
            {pendingOrNotFound.length} Unverified Channels
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 font-semibold uppercase text-[10px]">
              <tr>
                <th className="py-2.5 px-4">Channel</th>
                <th className="py-2.5 px-4">Country</th>
                <th className="py-2.5 px-4">Discord Status</th>
                <th className="py-2.5 px-4">Scan Attempts</th>
                <th className="py-2.5 px-4">Last Scanned</th>
                <th className="py-2.5 px-4 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
              {pendingOrNotFound.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-slate-500">
                    No unverified channels currently pending.
                  </td>
                </tr>
              ) : (
                pendingOrNotFound.map(c => (
                  <tr key={c.channel_id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40">
                    <td className="py-2.5 px-4 font-bold text-slate-900 dark:text-white">{c.channel_name}</td>
                    <td className="py-2.5 px-4 text-slate-700 dark:text-slate-300">{c.country}</td>
                    <td className="py-2.5 px-4">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                        c.discord_status === 'PENDING' ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-700'
                      }`}>
                        {c.discord_status}
                      </span>
                    </td>
                    <td className="py-2.5 px-4 font-mono">{c.scan_attempts} / 3</td>
                    <td className="py-2.5 px-4 text-slate-500">{c.last_checked ? new Date(c.last_checked).toLocaleString() : 'Never'}</td>
                    <td className="py-2.5 px-4 text-right">
                      <button
                        onClick={() => onRecheck(c.channel_id)}
                        disabled={c.scan_status === 'LOCKED'}
                        className="px-2.5 py-1 text-xs bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-400 text-white font-semibold rounded-lg transition-colors inline-flex items-center gap-1"
                      >
                        <RefreshCw className="w-3 h-3" />
                        <span>Re-scan Now</span>
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* 2. FAILED PERMANENT FLAGS PANEL */}
      {failedPermanent.length > 0 && (
        <div className="p-5 rounded-xl border border-rose-200 dark:border-rose-900/40 bg-rose-50/40 dark:bg-rose-950/10 shadow-xs space-y-3">
          <div className="flex items-center gap-2">
            <AlertOctagon className="w-5 h-5 text-rose-600 dark:text-rose-400" />
            <h3 className="text-base font-bold text-rose-950 dark:text-rose-100">
              Permanently Failed Channels (3 Consecutive Scan Failures)
            </h3>
          </div>
          <p className="text-xs text-rose-800 dark:text-rose-300">
            These channels failed inspection 3 consecutive times and were removed from the automatic re-check schedule. Operators can manually retry them.
          </p>

          <div className="space-y-2">
            {failedPermanent.map(c => (
              <div key={c.channel_id} className="p-3 bg-white dark:bg-slate-900 rounded-lg border border-rose-200 dark:border-rose-900/50 flex items-center justify-between text-xs">
                <div>
                  <span className="font-bold text-slate-900 dark:text-white block">{c.channel_name} ({c.country})</span>
                  <span className="text-[11px] text-rose-600 dark:text-rose-400 font-mono">Status: FAILED_PERMANENT ({c.scan_attempts} attempts)</span>
                </div>

                <button
                  onClick={() => onRecheck(c.channel_id)}
                  className="px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white font-semibold rounded-lg text-xs transition-colors flex items-center gap-1"
                >
                  <RefreshCw className="w-3 h-3" />
                  <span>Manual Reset & Retry</span>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

    </div>
  );
};
