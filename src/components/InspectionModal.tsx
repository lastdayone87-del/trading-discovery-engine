import React from 'react';
import { ChannelRecord } from '../types';
import { X, CheckCircle2, AlertCircle, StopCircle, ArrowRight, ExternalLink, ShieldCheck } from 'lucide-react';

interface Props {
  channel: ChannelRecord | null;
  onClose: () => void;
}

export const InspectionModal: React.FC<Props> = ({ channel, onClose }) => {
  if (!channel) return null;

  const trail = channel.inspection_trail || [];

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col shadow-2xl">
        
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-slate-50 dark:bg-slate-900/50">
          <div>
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
              <h3 className="text-lg font-bold text-slate-900 dark:text-white">
                Inspection Trail Audit Log
              </h3>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Channel: <span className="font-semibold text-slate-700 dark:text-slate-300">{channel.channel_name}</span> ({channel.country})
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-6 overflow-y-auto space-y-4">
          
          {/* Summary Box */}
          <div className="p-4 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 flex items-center justify-between">
            <div>
              <span className="text-xs text-slate-500 uppercase tracking-wider font-semibold block">Discord Detection Result</span>
              <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold mt-1 ${
                channel.discord_status === 'ACTIVE'
                  ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300'
                  : channel.discord_status === 'ACTIVE_LOW_VOLUME'
                  ? 'bg-teal-100 text-teal-800 dark:bg-teal-950/60 dark:text-teal-300'
                  : channel.discord_status === 'NON_TRADING'
                  ? 'bg-purple-100 text-purple-800 dark:bg-purple-950/60 dark:text-purple-300 border border-purple-200 dark:border-purple-800'
                  : channel.discord_status === 'DEAD'
                  ? 'bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300'
                  : channel.discord_status === 'PENDING'
                  ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300'
                  : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
              }`}>
                {channel.discord_status}
              </span>
            </div>

            {channel.discord_invite && (
              <a
                href={channel.discord_invite}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-colors"
              >
                <span>Open Discord</span>
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2 rounded-lg border border-slate-200 dark:border-slate-800 p-3 text-[11px]">
            <div><span className="text-slate-500 block">Resolution</span><b>{channel.discord_resolution_status?.replaceAll('_',' ')||'NOT ATTEMPTED'}</b></div>
            <div><span className="text-slate-500 block">Liveness</span><b>{channel.discord_liveness_status?.replaceAll('_',' ')||'NOT CHECKED'}</b></div>
            <div><span className="text-slate-500 block">Relevance</span><b>{channel.discord_relevance_status?.replaceAll('_',' ')||'NOT CHECKED'}</b></div>
            <div><span className="text-slate-500 block">Validation</span><b>{channel.discord_validation_status?.replaceAll('_',' ')||'NOT STARTED'}</b></div>
            {channel.discord_candidate_raw_locator&&<div className="col-span-2"><span className="text-slate-500 block">Source locator ({channel.discord_candidate_type?.replaceAll('_',' ')})</span><code className="break-all">{channel.discord_candidate_raw_locator}</code></div>}
            {channel.discord_candidate_locator&&<div className="col-span-2"><span className="text-slate-500 block">Resolved candidate</span><code className="break-all">{channel.discord_candidate_locator}</code></div>}
          </div>

          {/* Early Stopping Rule Info */}
          <div className="text-xs text-slate-500 dark:text-slate-400 bg-indigo-50/50 dark:bg-indigo-950/20 p-3 rounded-lg border border-indigo-100 dark:border-indigo-900/30 flex items-start gap-2">
            <StopCircle className="w-4 h-4 text-indigo-600 dark:text-indigo-400 shrink-0 mt-0.5" />
            <span>
              <strong>Bounded Candidate Protocol:</strong> Supported surfaces are inspected in order, while distinct Discord candidates are retained so an invalid first locator cannot hide a later valid one.
            </span>
          </div>

          {/* AI Trading Classifier Audit Breakdown */}
          {channel.trading_relevance_breakdown && (
            <div className="p-4 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-950/40 text-xs space-y-2.5">
              <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-2">
                <span className="font-bold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                  🤖 AI & Heuristic Trading Classifier Audit
                </span>
                <span className="px-2 py-0.5 rounded bg-indigo-100 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300 font-mono text-[10px] font-bold">
                  {channel.trading_relevance_breakdown.classification_method || 'HEURISTIC_PREFILTER'}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2 text-[11px]">
                <div>
                  <span className="text-slate-500 block">Trading Status:</span>
                  <span className="font-semibold text-slate-800 dark:text-slate-200">{channel.trading_status} ({channel.trading_confidence_score}% score)</span>
                </div>
                <div>
                  <span className="text-slate-500 block">Detected Category:</span>
                  <span className="font-semibold text-slate-800 dark:text-slate-200">{channel.trading_category}</span>
                </div>
              </div>

              {channel.trading_relevance_breakdown.reasoning && channel.trading_relevance_breakdown.reasoning.length > 0 && (
                <div className="space-y-1.5 pt-1">
                  <span className="text-[11px] font-semibold text-slate-600 dark:text-slate-400 block">
                    Evidence Engine Audit Trail:
                  </span>
                  <div className="space-y-1.5 text-[11px] text-slate-700 dark:text-slate-300">
                    {channel.trading_relevance_breakdown.reasoning.map((r, i) => {
                      if (r.startsWith('[+EVIDENCE]')) {
                        const content = r.replace('[+EVIDENCE]', '').trim();
                        return (
                          <div key={i} className="flex items-start gap-1.5 p-2 rounded bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800/40 text-emerald-900 dark:text-emerald-200">
                            <span className="px-1.5 py-0.5 rounded bg-emerald-200 dark:bg-emerald-800 font-bold text-[9px] uppercase shrink-0 text-emerald-950 dark:text-emerald-100 mt-0.5">+EVIDENCE</span>
                            <span className="font-medium text-[11px] leading-relaxed">{content}</span>
                          </div>
                        );
                      }
                      if (r.startsWith('[-EVIDENCE]')) {
                        const content = r.replace('[-EVIDENCE]', '').trim();
                        return (
                          <div key={i} className="flex items-start gap-1.5 p-2 rounded bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800/40 text-rose-900 dark:text-rose-200">
                            <span className="px-1.5 py-0.5 rounded bg-rose-200 dark:bg-rose-800 font-bold text-[9px] uppercase shrink-0 text-rose-950 dark:text-rose-100 mt-0.5">-EVIDENCE</span>
                            <span className="font-medium text-[11px] leading-relaxed">{content}</span>
                          </div>
                        );
                      }
                      return (
                        <div key={i} className="p-1.5 rounded bg-slate-100 dark:bg-slate-900/50 text-slate-700 dark:text-slate-300 font-mono text-[10px] border border-slate-200/60 dark:border-slate-800">
                          • {r}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Exact Prompt Payload and Raw Response Inspection */}
              {(channel.trading_relevance_breakdown.ai_prompt_payload || channel.trading_relevance_breakdown.ai_raw_response) && (
                <div className="pt-2 border-t border-slate-200 dark:border-slate-800 space-y-2">
                  <span className="font-bold text-slate-700 dark:text-slate-300 block text-[11px]">
                    Gemini AI Model Audit ({channel.trading_relevance_breakdown.ai_model || 'gemini-3.6-flash'}):
                  </span>
                  
                  {channel.trading_relevance_breakdown.ai_prompt_payload && (
                    <details className="group">
                      <summary className="cursor-pointer text-[11px] font-semibold text-indigo-600 dark:text-indigo-400 hover:underline">
                        ▶ View Exact Gemini Prompt Payload
                      </summary>
                      <pre className="mt-1.5 p-2.5 rounded bg-slate-900 text-slate-100 font-mono text-[10px] whitespace-pre-wrap max-h-48 overflow-y-auto border border-slate-800">
                        {channel.trading_relevance_breakdown.ai_prompt_payload}
                      </pre>
                    </details>
                  )}

                  {channel.trading_relevance_breakdown.ai_raw_response && (
                    <details className="group">
                      <summary className="cursor-pointer text-[11px] font-semibold text-emerald-600 dark:text-emerald-400 hover:underline">
                        ▶ View Raw Gemini Model Response
                      </summary>
                      <pre className="mt-1.5 p-2.5 rounded bg-slate-900 text-emerald-300 font-mono text-[10px] whitespace-pre-wrap max-h-48 overflow-y-auto border border-slate-800">
                        {channel.trading_relevance_breakdown.ai_raw_response}
                      </pre>
                    </details>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Trail Steps List */}
          <div className="space-y-3 relative before:absolute before:inset-0 before:left-4 before:w-0.5 before:bg-slate-200 dark:before:bg-slate-800">
            {trail.length === 0 ? (
              <div className="py-8 text-center text-sm text-slate-500">
                No inspection steps recorded yet for this channel.
              </div>
            ) : (
              trail.map((step, idx) => (
                <div key={idx} className="relative pl-9">
                  
                  {/* Icon Node */}
                  <div className={`absolute left-2.5 top-1 -translate-x-1/2 w-4 h-4 rounded-full border-2 flex items-center justify-center bg-white dark:bg-slate-900 ${
                    step.status === 'FOUND'
                      ? 'border-emerald-500 text-emerald-500'
                      : step.status === 'REJECTED'
                      ? 'border-rose-500 text-rose-500'
                      : step.status === 'NOT_FOUND'
                      ? 'border-slate-300 dark:border-slate-700 text-slate-400'
                      : 'border-slate-200 dark:border-slate-800 text-slate-300'
                  }`}>
                    {step.status === 'FOUND' && <CheckCircle2 className="w-3 h-3 text-emerald-500" />}
                    {step.status === 'REJECTED' && <AlertCircle className="w-3 h-3 text-rose-500" />}
                  </div>

                  {/* Card */}
                  <div className={`p-3.5 rounded-lg border text-xs transition-all ${
                    step.status === 'FOUND'
                      ? 'bg-emerald-50/40 border-emerald-200 dark:bg-emerald-950/20 dark:border-emerald-900/40'
                      : step.status === 'REJECTED'
                      ? 'bg-rose-50/40 border-rose-200 dark:bg-rose-950/20 dark:border-rose-900/40'
                      : 'bg-white border-slate-200 dark:bg-slate-900 dark:border-slate-800'
                  }`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-slate-800 dark:text-slate-200">
                        {step.title}
                      </span>
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                        step.status === 'FOUND'
                          ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-300'
                          : step.status === 'REJECTED'
                          ? 'bg-rose-100 text-rose-800 dark:bg-rose-900/60 dark:text-rose-300'
                          : step.status === 'SKIPPED'
                          ? 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'
                          : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400'
                      }`}>
                        {step.status}
                      </span>
                    </div>

                    {step.details && (
                      <div className="mt-2 text-[11px] font-mono text-slate-700 dark:text-slate-300 bg-slate-100/80 dark:bg-slate-950/50 p-2.5 rounded border border-slate-200/60 dark:border-slate-800/80 whitespace-pre-line leading-relaxed overflow-x-auto max-h-48">
                        {step.details}
                      </div>
                    )}

                    {(step.detectedInvites?.length || step.detectedInvite) && (
                      <div className="mt-2 font-mono text-[11px] bg-emerald-100/70 dark:bg-emerald-950/60 text-emerald-900 dark:text-emerald-200 p-2 rounded border border-emerald-200 dark:border-emerald-800 flex items-center justify-between">
                        <div className="flex flex-col gap-0.5">
                          {(step.detectedInvites?.length ? step.detectedInvites : [step.detectedInvite!]).map((inviteCode, inviteIndex) => (
                            <span key={`${inviteCode}-${inviteIndex}`}>Invite Code{(step.detectedInvites?.length || 1) > 1 ? ` ${inviteIndex + 1}` : ''}: <strong>{inviteCode}</strong></span>
                          ))}
                          {step.inviteLocation && (
                            <span className="text-[10px] text-emerald-800 dark:text-emerald-300">Found in: <strong className="uppercase bg-emerald-200/50 dark:bg-emerald-800/50 px-1 rounded">{step.inviteLocation}</strong></span>
                          )}
                        </div>
                        <span className="text-[10px] uppercase font-sans font-bold text-emerald-700 dark:text-emerald-400 text-right">Candidate Retained</span>
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>

        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50 text-right">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-xs font-semibold bg-slate-200 hover:bg-slate-300 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 rounded-lg transition-colors"
          >
            Close
          </button>
        </div>

      </div>
    </div>
  );
};
