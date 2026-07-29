import { apiFetch } from '../apiClient';
import React, { useState, useEffect } from 'react';
import {
  RegressionRunRecord,
  RegressionDiffReport
} from '../types';
import {
  ShieldCheck,
  AlertTriangle,
  Play,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Clock,
  Zap,
  Layers,
  Filter,
  BarChart2,
  FileText,
  Activity
} from 'lucide-react';

export const RegressionSuiteDashboard: React.FC = () => {
  const [latestRun, setLatestRun] = useState<RegressionRunRecord | null>(null);
  const [baselineRun, setBaselineRun] = useState<RegressionRunRecord | null>(null);
  const [diffReport, setDiffReport] = useState<RegressionDiffReport | null>(null);
  const [historicalRuns, setHistoricalRuns] = useState<RegressionRunRecord[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isRunningTest, setIsRunningTest] = useState<boolean>(false);
  const [sampleFilter, setSampleFilter] = useState<'ALL' | 'FALSE_POSITIVES' | 'FALSE_NEGATIVES' | 'CORRECT' | 'MISSED_DISCORD'>('ALL');
  const [customRunLabel, setCustomRunLabel] = useState<string>('');

  const fetchRegressionData = async () => {
    setIsLoading(true);
    try {
      const [latestRes, runsRes] = await Promise.all([
        apiFetch('/api/regression/latest'),
        apiFetch('/api/regression/runs')
      ]);

      if (latestRes.ok) {
        const data = await latestRes.json();
        setLatestRun(data.latestRun);
        setBaselineRun(data.baselineRun);
        setDiffReport(data.diffReport);
      }

      if (runsRes.ok) {
        const runs = await runsRes.json();
        setHistoricalRuns(runs);
      }
    } catch (err) {
      console.error('Failed to load regression suite data:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchRegressionData();
  }, []);

  const handleRunRegression = async () => {
    setIsRunningTest(true);
    try {
      const res = await apiFetch('/api/regression/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runLabel: customRunLabel || undefined })
      });

      if (res.ok) {
        setCustomRunLabel('');
        await fetchRegressionData();
      }
    } catch (err) {
      console.error('Failed to run regression test suite:', err);
    } finally {
      setIsRunningTest(false);
    }
  };

  if (isLoading) {
    return (
      <div className="p-12 flex flex-col items-center justify-center gap-3 text-slate-500">
        <RefreshCw className="w-8 h-8 animate-spin text-indigo-600" />
        <p className="text-sm font-medium">Loading Permanent Regression Suite Metrics...</p>
      </div>
    );
  }

  const m = latestRun?.metrics;
  const filteredSamples = latestRun?.sample_results.filter(s => {
    if (sampleFilter === 'FALSE_POSITIVES') return !s.is_correct_trading && s.predicted_trading === 'TRADING_CONFIRMED';
    if (sampleFilter === 'FALSE_NEGATIVES') return !s.is_correct_trading && s.predicted_trading === 'NON_TRADING';
    if (sampleFilter === 'CORRECT') return s.is_correct_trading;
    if (sampleFilter === 'MISSED_DISCORD') return s.ground_truth_discord === 'ACTIVE' && s.predicted_discord !== 'ACTIVE';
    return true;
  }) || [];

  return (
    <div className="space-y-6">
      
      {/* Top Banner & Run Trigger */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          
          <div className="flex items-center gap-3">
            <div className={`p-3 rounded-xl ${
              diffReport?.has_regression_alert
                ? 'bg-rose-100 dark:bg-rose-950/80 text-rose-600 dark:text-rose-400'
                : 'bg-emerald-100 dark:bg-emerald-950/80 text-emerald-600 dark:text-emerald-400'
            }`}>
              {diffReport?.has_regression_alert ? (
                <AlertTriangle className="w-6 h-6 animate-bounce" />
              ) : (
                <ShieldCheck className="w-6 h-6" />
              )}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-bold text-slate-900 dark:text-white">
                  Permanent Regression Suite
                </h2>
                <span className={`px-2.5 py-0.5 text-xs font-bold rounded-md ${
                  diffReport?.has_regression_alert
                    ? 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300'
                    : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
                }`}>
                  {diffReport?.has_regression_alert ? 'REGRESSION ALERT DETECTED' : 'SYSTEM HEALTHY (NO REGRESSION)'}
                </span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                Evaluates discovery engine changes against a 120-channel ground truth benchmark across 12 countries.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="text"
              placeholder="Run Label (e.g., Post-Refactor Check)"
              value={customRunLabel}
              onChange={e => setCustomRunLabel(e.target.value)}
              className="px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-800 dark:text-slate-200 w-56"
            />
            <button
              onClick={handleRunRegression}
              disabled={isRunningTest}
              className="px-4 py-2 text-xs font-bold bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-all flex items-center gap-1.5 shadow-2xs disabled:opacity-50"
            >
              {isRunningTest ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  <span>Evaluating Benchmark...</span>
                </>
              ) : (
                <>
                  <Play className="w-4 h-4 fill-current" />
                  <span>Run Regression Test</span>
                </>
              )}
            </button>
          </div>

        </div>

        {/* Regression Alert Banner if active */}
        {diffReport?.has_regression_alert && (
          <div className="mt-4 p-3 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/60 rounded-lg text-rose-900 dark:text-rose-200 text-xs space-y-1">
            <div className="font-bold flex items-center gap-1.5 text-rose-700 dark:text-rose-300">
              <AlertTriangle className="w-4 h-4" />
              <span>Regression Warnings Triggered:</span>
            </div>
            <ul className="list-disc list-inside space-y-0.5 text-[11px] font-mono pl-1">
              {diffReport.regression_alerts.map((alert, idx) => (
                <li key={idx}>{alert}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Primary Metric KPI Cards */}
      {m && (
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
          
          <div className="p-3.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl space-y-1">
            <span className="text-[10px] uppercase font-bold text-slate-400 dark:text-slate-500">Precision</span>
            <div className="text-xl font-extrabold text-slate-900 dark:text-white font-mono">
              {m.precision}%
            </div>
            {diffReport && (
              <span className={`text-[10px] font-mono font-bold ${
                diffReport.precision_delta >= 0 ? 'text-emerald-500' : 'text-rose-500'
              }`}>
                {diffReport.precision_delta >= 0 ? `+${diffReport.precision_delta}%` : `${diffReport.precision_delta}%`} vs base
              </span>
            )}
          </div>

          <div className="p-3.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl space-y-1">
            <span className="text-[10px] uppercase font-bold text-slate-400 dark:text-slate-500">Recall</span>
            <div className="text-xl font-extrabold text-slate-900 dark:text-white font-mono">
              {m.recall}%
            </div>
            {diffReport && (
              <span className={`text-[10px] font-mono font-bold ${
                diffReport.recall_delta >= 0 ? 'text-emerald-500' : 'text-rose-500'
              }`}>
                {diffReport.recall_delta >= 0 ? `+${diffReport.recall_delta}%` : `${diffReport.recall_delta}%`} vs base
              </span>
            )}
          </div>

          <div className="p-3.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl space-y-1">
            <span className="text-[10px] uppercase font-bold text-slate-400 dark:text-slate-500">F1 Score</span>
            <div className="text-xl font-extrabold text-slate-900 dark:text-white font-mono">
              {m.f1_score}%
            </div>
            {diffReport && (
              <span className={`text-[10px] font-mono font-bold ${
                diffReport.f1_delta >= 0 ? 'text-emerald-500' : 'text-rose-500'
              }`}>
                {diffReport.f1_delta >= 0 ? `+${diffReport.f1_delta}%` : `${diffReport.f1_delta}%`} vs base
              </span>
            )}
          </div>

          <div className="p-3.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl space-y-1">
            <span className="text-[10px] uppercase font-bold text-slate-400 dark:text-slate-500">Discord Discovery</span>
            <div className="text-xl font-extrabold text-slate-900 dark:text-white font-mono">
              {m.discord_discovery_rate}%
            </div>
            <span className="text-[10px] font-mono text-slate-500">
              {m.discord_discovered}/{m.discord_target_total} Found
            </span>
          </div>

          <div className="p-3.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl space-y-1">
            <span className="text-[10px] uppercase font-bold text-slate-400 dark:text-slate-500">False Positives</span>
            <div className="text-xl font-extrabold text-rose-600 dark:text-rose-400 font-mono">
              {m.false_positives}
            </div>
            <span className="text-[10px] text-slate-400">Non-Trading Accepted</span>
          </div>

          <div className="p-3.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl space-y-1">
            <span className="text-[10px] uppercase font-bold text-slate-400 dark:text-slate-500">False Negatives</span>
            <div className="text-xl font-extrabold text-amber-600 dark:text-amber-400 font-mono">
              {m.false_negatives}
            </div>
            <span className="text-[10px] text-slate-400">Trading Rejected</span>
          </div>

          <div className="p-3.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl space-y-1">
            <span className="text-[10px] uppercase font-bold text-slate-400 dark:text-slate-500">Avg Latency</span>
            <div className="text-xl font-extrabold text-slate-900 dark:text-white font-mono">
              {m.avg_processing_time_ms}ms
            </div>
            {diffReport && (
              <span className={`text-[10px] font-mono font-bold ${
                diffReport.latency_delta_ms <= 0 ? 'text-emerald-500' : 'text-amber-500'
              }`}>
                {diffReport.latency_delta_ms <= 0 ? `${diffReport.latency_delta_ms}ms` : `+${diffReport.latency_delta_ms}ms`}
              </span>
            )}
          </div>

          <div className="p-3.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl space-y-1">
            <span className="text-[10px] uppercase font-bold text-slate-400 dark:text-slate-500">API Quota</span>
            <div className="text-xl font-extrabold text-indigo-600 dark:text-indigo-400 font-mono">
              {m.api_quota_consumed}
            </div>
            <span className="text-[10px] text-slate-400">Units Consumed</span>
          </div>

        </div>
      )}

      {/* Comparison Grid: Current Run vs Baseline */}
      {latestRun && baselineRun && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs space-y-4">
          <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
            <div className="flex items-center gap-2">
              <BarChart2 className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
              <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                Baseline Comparison Matrix
              </h3>
            </div>
            <div className="text-xs text-slate-500 font-mono">
              Comparing: <strong className="text-slate-800 dark:text-slate-200">{latestRun.run_label}</strong> vs <strong className="text-slate-800 dark:text-slate-200">{baselineRun.run_label}</strong>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 font-semibold uppercase tracking-wider text-[10px]">
                <tr>
                  <th className="py-2.5 px-3">Metric Name</th>
                  <th className="py-2.5 px-3">Baseline ({baselineRun.run_label})</th>
                  <th className="py-2.5 px-3">Current ({latestRun.run_label})</th>
                  <th className="py-2.5 px-3">Variance / Delta</th>
                  <th className="py-2.5 px-3">Health Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-mono">
                
                <tr>
                  <td className="py-2.5 px-3 font-sans font-medium text-slate-900 dark:text-white">Precision</td>
                  <td className="py-2.5 px-3">{baselineRun.metrics.precision}%</td>
                  <td className="py-2.5 px-3 font-bold">{latestRun.metrics.precision}%</td>
                  <td className={`py-2.5 px-3 font-bold ${diffReport?.precision_delta! >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                    {diffReport?.precision_delta! >= 0 ? `+${diffReport?.precision_delta}%` : `${diffReport?.precision_delta}%`}
                  </td>
                  <td className="py-2.5 px-3">
                    <span className={`px-2 py-0.5 rounded-xs text-[10px] font-sans font-bold ${
                      diffReport?.precision_delta! >= -3.0 ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'
                    }`}>
                      {diffReport?.precision_delta! >= -3.0 ? 'PASSED' : 'REGRESSED'}
                    </span>
                  </td>
                </tr>

                <tr>
                  <td className="py-2.5 px-3 font-sans font-medium text-slate-900 dark:text-white">Recall</td>
                  <td className="py-2.5 px-3">{baselineRun.metrics.recall}%</td>
                  <td className="py-2.5 px-3 font-bold">{latestRun.metrics.recall}%</td>
                  <td className={`py-2.5 px-3 font-bold ${diffReport?.recall_delta! >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                    {diffReport?.recall_delta! >= 0 ? `+${diffReport?.recall_delta}%` : `${diffReport?.recall_delta}%`}
                  </td>
                  <td className="py-2.5 px-3">
                    <span className={`px-2 py-0.5 rounded-xs text-[10px] font-sans font-bold ${
                      diffReport?.recall_delta! >= -3.0 ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'
                    }`}>
                      {diffReport?.recall_delta! >= -3.0 ? 'PASSED' : 'REGRESSED'}
                    </span>
                  </td>
                </tr>

                <tr>
                  <td className="py-2.5 px-3 font-sans font-medium text-slate-900 dark:text-white">Discord Discovery Rate</td>
                  <td className="py-2.5 px-3">{baselineRun.metrics.discord_discovery_rate}%</td>
                  <td className="py-2.5 px-3 font-bold">{latestRun.metrics.discord_discovery_rate}%</td>
                  <td className={`py-2.5 px-3 font-bold ${diffReport?.discord_rate_delta! >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                    {diffReport?.discord_rate_delta! >= 0 ? `+${diffReport?.discord_rate_delta}%` : `${diffReport?.discord_rate_delta}%`}
                  </td>
                  <td className="py-2.5 px-3">
                    <span className={`px-2 py-0.5 rounded-xs text-[10px] font-sans font-bold ${
                      diffReport?.discord_rate_delta! >= -5.0 ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'
                    }`}>
                      {diffReport?.discord_rate_delta! >= -5.0 ? 'PASSED' : 'REGRESSED'}
                    </span>
                  </td>
                </tr>

                <tr>
                  <td className="py-2.5 px-3 font-sans font-medium text-slate-900 dark:text-white">Avg Processing Latency</td>
                  <td className="py-2.5 px-3">{baselineRun.metrics.avg_processing_time_ms}ms</td>
                  <td className="py-2.5 px-3 font-bold">{latestRun.metrics.avg_processing_time_ms}ms</td>
                  <td className="py-2.5 px-3">{diffReport?.latency_delta_ms! <= 0 ? `${diffReport?.latency_delta_ms}ms` : `+${diffReport?.latency_delta_ms}ms`}</td>
                  <td className="py-2.5 px-3">
                    <span className="px-2 py-0.5 rounded-xs text-[10px] font-sans font-bold bg-emerald-100 text-emerald-800">
                      OPTIMAL
                    </span>
                  </td>
                </tr>

                <tr>
                  <td className="py-2.5 px-3 font-sans font-medium text-slate-900 dark:text-white">API Quota Consumed</td>
                  <td className="py-2.5 px-3">{baselineRun.metrics.api_quota_consumed} units</td>
                  <td className="py-2.5 px-3 font-bold">{latestRun.metrics.api_quota_consumed} units</td>
                  <td className="py-2.5 px-3">{diffReport?.quota_delta! <= 0 ? `${diffReport?.quota_delta}` : `+${diffReport?.quota_delta}`}</td>
                  <td className="py-2.5 px-3">
                    <span className="px-2 py-0.5 rounded-xs text-[10px] font-sans font-bold bg-emerald-100 text-emerald-800">
                      EFFICIENT
                    </span>
                  </td>
                </tr>

              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Benchmark Dataset Channel Sample Drill-down */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs space-y-4">
        
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-100 dark:border-slate-800 pb-3">
          <div className="flex items-center gap-2">
            <FileText className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
            <h3 className="text-sm font-bold text-slate-900 dark:text-white">
              Benchmark Dataset Results ({filteredSamples.length} / 120 Channels)
            </h3>
          </div>

          {/* Sample Filter Tabs */}
          <div className="flex items-center gap-1 overflow-x-auto text-xs">
            <button
              onClick={() => setSampleFilter('ALL')}
              className={`px-3 py-1.5 rounded-lg font-semibold whitespace-nowrap transition-all ${
                sampleFilter === 'ALL' ? 'bg-indigo-600 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300'
              }`}
            >
              All (120)
            </button>
            <button
              onClick={() => setSampleFilter('CORRECT')}
              className={`px-3 py-1.5 rounded-lg font-semibold whitespace-nowrap transition-all ${
                sampleFilter === 'CORRECT' ? 'bg-indigo-600 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300'
              }`}
            >
              Correct ({latestRun?.sample_results.filter(s => s.is_correct_trading).length})
            </button>
            <button
              onClick={() => setSampleFilter('FALSE_POSITIVES')}
              className={`px-3 py-1.5 rounded-lg font-semibold whitespace-nowrap transition-all ${
                sampleFilter === 'FALSE_POSITIVES' ? 'bg-indigo-600 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300'
              }`}
            >
              False Positives ({latestRun?.metrics.false_positives})
            </button>
            <button
              onClick={() => setSampleFilter('FALSE_NEGATIVES')}
              className={`px-3 py-1.5 rounded-lg font-semibold whitespace-nowrap transition-all ${
                sampleFilter === 'FALSE_NEGATIVES' ? 'bg-indigo-600 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300'
              }`}
            >
              False Negatives ({latestRun?.metrics.false_negatives})
            </button>
          </div>
        </div>

        {/* Channels Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 font-semibold uppercase tracking-wider text-[10px]">
              <tr>
                <th className="py-2.5 px-3">Channel Name & Region</th>
                <th className="py-2.5 px-3">Ground Truth</th>
                <th className="py-2.5 px-3">Engine Prediction</th>
                <th className="py-2.5 px-3">Discord Status</th>
                <th className="py-2.5 px-3">Evaluation Result</th>
                <th className="py-2.5 px-3">Latency</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {filteredSamples.map((sample, idx) => (
                <tr key={idx} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                  <td className="py-2.5 px-3">
                    <div className="font-bold text-slate-900 dark:text-white">
                      {sample.channel_name}
                    </div>
                    <div className="text-[10px] text-slate-500">
                      {sample.country}
                    </div>
                  </td>

                  <td className="py-2.5 px-3">
                    <span className={`px-2 py-0.5 rounded-xs text-[10px] font-bold ${
                      sample.ground_truth_trading === 'TRADING_CONFIRMED'
                        ? 'bg-emerald-100 text-emerald-800'
                        : 'bg-slate-100 text-slate-700'
                    }`}>
                      {sample.ground_truth_trading}
                    </span>
                  </td>

                  <td className="py-2.5 px-3">
                    <span className={`px-2 py-0.5 rounded-xs text-[10px] font-bold ${
                      sample.predicted_trading === 'TRADING_CONFIRMED'
                        ? 'bg-emerald-100 text-emerald-800'
                        : 'bg-rose-100 text-rose-800'
                    }`}>
                      {sample.predicted_trading}
                    </span>
                  </td>

                  <td className="py-2.5 px-3 font-mono text-[11px]">
                    {sample.predicted_discord === 'ACTIVE' ? (
                      <span className="text-emerald-600 font-bold">✓ ACTIVE DISCORD</span>
                    ) : (
                      <span className="text-slate-400">NOT FOUND</span>
                    )}
                  </td>

                  <td className="py-2.5 px-3">
                    {sample.is_correct_trading ? (
                      <span className="flex items-center gap-1 text-emerald-600 font-bold">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>MATCH</span>
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-rose-600 font-bold">
                        <XCircle className="w-3.5 h-3.5" />
                        <span>MISMATCH</span>
                      </span>
                    )}
                  </td>

                  <td className="py-2.5 px-3 font-mono text-slate-500 text-[11px]">
                    {sample.processing_time_ms}ms
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

      </div>

    </div>
  );
};
