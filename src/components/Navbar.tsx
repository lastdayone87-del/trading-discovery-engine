import React from 'react';
import { ChannelRecord, QueueStatus, QuotaInfo } from '../types';
import { Radar, Table, Clock, Cpu, Settings, ShieldCheck, Database, Radio, Brain } from 'lucide-react';

interface Props {
  activeTab: 'discovery' | 'results' | 'pending' | 'queues' | 'settings' | 'intelligence' | 'regression';
  setActiveTab: (tab: 'discovery' | 'results' | 'pending' | 'queues' | 'settings' | 'intelligence' | 'regression') => void;
  channels: ChannelRecord[];
  queueStatus: QueueStatus | null;
  quotaInfo: QuotaInfo | null;
}

export const Navbar: React.FC<Props> = ({ activeTab, setActiveTab, channels, queueStatus, quotaInfo }) => {
  const activeDiscords = channels.filter(c => c.discord_status === 'ACTIVE' || c.discord_status === 'ACTIVE_LOW_VOLUME').length;
  const pendingScans = channels.filter(c => c.scan_status === 'PENDING' || c.scan_status === 'LOCKED').length;

  const navItems = [
    { id: 'discovery', label: 'Discovery & Search', icon: Radar },
    { id: 'intelligence', label: 'Query Intelligence', icon: Brain },
    { id: 'regression', label: 'Regression Suite', icon: ShieldCheck },
    { id: 'results', label: `Channels Table (${channels.length})`, icon: Table },
    { id: 'pending', label: 'Pending & Re-checks', icon: Clock },
    { id: 'queues', label: 'Queue Monitor', icon: Cpu },
    { id: 'settings', label: 'Country & Vocabulary', icon: Settings }
  ] as const;


  return (
    <header className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 sticky top-0 z-40 shadow-xs">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        
        {/* Top Branding & Metrics Row */}
        <div className="py-3.5 flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-100 dark:border-slate-800/80">
          
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-indigo-600 text-white rounded-xl shadow-xs">
              <Radar className="w-6 h-6 animate-pulse" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-base font-extrabold text-slate-900 dark:text-white tracking-tight">
                  Trading Community Discovery Engine
                </h1>
                <span className="px-2 py-0.5 text-[10px] font-mono font-bold bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300 rounded-md">
                  v3.0 Final
                </span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Traders First. Communities Second. Universal Storage Protocol.
              </p>
            </div>
          </div>

          {/* Key KPI Summary Pills */}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <div className="px-3 py-1.5 rounded-lg bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 flex items-center gap-2">
              <Database className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />
              <span className="text-slate-500 dark:text-slate-400">Stored Channels:</span>
              <span className="font-extrabold font-mono text-slate-900 dark:text-white">{channels.length}</span>
            </div>

            <div className="px-3 py-1.5 rounded-lg bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900/50 flex items-center gap-2 text-emerald-800 dark:text-emerald-300">
              <Radio className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
              <span>Active Discords:</span>
              <span className="font-extrabold font-mono">{activeDiscords}</span>
            </div>

            <div className="px-3 py-1.5 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/50 flex items-center gap-2 text-amber-800 dark:text-amber-300">
              <Clock className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
              <span>Pending Scans:</span>
              <span className="font-extrabold font-mono">{pendingScans}</span>
            </div>
          </div>

        </div>

        {/* Navigation Tabs Bar */}
        <div className="flex items-center gap-1 overflow-x-auto py-2 scrollbar-none">
          {navItems.map(item => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                className={`px-3.5 py-2 rounded-lg text-xs font-semibold whitespace-nowrap transition-all flex items-center gap-2 ${
                  isActive
                    ? 'bg-indigo-600 text-white shadow-2xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                <Icon className="w-4 h-4" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>

      </div>
    </header>
  );
};
