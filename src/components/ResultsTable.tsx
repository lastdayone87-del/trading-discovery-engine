import React, { useState } from 'react';
import { ChannelRecord, ReviewQueueItem } from '../types';
import { ExternalLink, RefreshCw, Eye, Copy, Check, Search, CheckCircle2, XCircle, ShieldAlert, X } from 'lucide-react';

interface Props {
  channels: ChannelRecord[];
  onRecheck: (channelId: string) => Promise<void>;
  onInspect: (channel: ChannelRecord) => void;
  onReviewCompleted?: () => Promise<void>;
  reviewEnabled?: boolean;
}

type ReviewAction = 'approve' | 'reject' | 'force-rescan';

export const ResultsTable: React.FC<Props> = ({ channels, onRecheck, onInspect, onReviewCompleted, reviewEnabled = false }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCountry, setSelectedCountry] = useState('ALL');
  const [selectedCountryStatus, setSelectedCountryStatus] = useState('ALL');
  const [selectedTradingStatus, setSelectedTradingStatus] = useState('ALL');
  const [selectedDiscordStatus, setSelectedDiscordStatus] = useState('ALL');
  const [selectedScanStatus, setSelectedScanStatus] = useState('ALL');

  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [recheckingId, setRecheckingId] = useState<string | null>(null);
  const [reviewToken, setReviewToken] = useState(() => localStorage.getItem('review-token') || '');
  const [reviewer, setReviewer] = useState(() => localStorage.getItem('reviewer-id') || '');
  const [pendingReviewOnly, setPendingReviewOnly] = useState(false);
  const [reviewBusy, setReviewBusy] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState('');
  const [reviewDetails, setReviewDetails] = useState<ReviewQueueItem | null>(null);
  const [decidedChannelIds, setDecidedChannelIds] = useState<Set<string>>(() => new Set());

  const countries = Array.from(new Set(channels.map(c => c.country)));

  const filteredChannels = channels.filter(c => {
    const matchesSearch = c.channel_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      c.youtube_url.toLowerCase().includes(searchTerm.toLowerCase());

    const matchesCountry = selectedCountry === 'ALL' || c.country === selectedCountry;
    const matchesCountryStatus = selectedCountryStatus === 'ALL' || c.country_status === selectedCountryStatus;
    const matchesTradingStatus = selectedTradingStatus === 'ALL' || c.trading_status === selectedTradingStatus;
    const matchesDiscordStatus = selectedDiscordStatus === 'ALL' || c.discord_status === selectedDiscordStatus;
    const matchesScanStatus = selectedScanStatus === 'ALL' || c.scan_status === selectedScanStatus;
    const matchesReviewView = !pendingReviewOnly || (c.scan_status === 'NEEDS_REVIEW' && !decidedChannelIds.has(c.channel_id));

    return matchesSearch && matchesCountry && matchesCountryStatus && matchesTradingStatus && matchesDiscordStatus && matchesScanStatus && matchesReviewView;
  });

  const handleCopyLink = (url: string, id: string) => {
    navigator.clipboard.writeText(url);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const reviewHeaders = () => ({
    Authorization: `Bearer ${reviewToken}`,
    'X-Reviewer-Id': reviewer
  });

  const parseError = async (response: Response) => {
    const body = await response.json().catch(() => ({}));
    return body.error || `Review request failed (${response.status}).`;
  };

  const loadReviewDetails = async (channelId: string) => {
    setReviewError('');
    const response = await fetch(`/api/reviews/${encodeURIComponent(channelId)}`, { headers: reviewHeaders() });
    if (!response.ok) throw new Error(await parseError(response));
    return response.json() as Promise<ReviewQueueItem>;
  };

  const openReviewDetails = async (channelId: string) => {
    if (!reviewToken || !reviewer) {
      setReviewError('Enter a reviewer API token and reviewer identity to inspect or decide reviews.');
      return;
    }
    setReviewBusy(`${channelId}:details`);
    try {
      setReviewDetails(await loadReviewDetails(channelId));
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : 'Unable to load review details.');
    } finally {
      setReviewBusy(null);
    }
  };

  const handleReviewAction = async (channelId: string, action: ReviewAction, currentDetails?: ReviewQueueItem) => {
    if (!reviewToken || !reviewer) {
      setReviewError('Enter a reviewer API token and reviewer identity before making a decision.');
      return;
    }

    const reason = window.prompt(`Reason for ${action}`)?.trim();
    if (!reason) return;
    const notes = window.prompt('Optional notes')?.trim() || '';
    setReviewError('');
    setReviewBusy(`${channelId}:${action}`);

    try {
      const details = currentDetails || await loadReviewDetails(channelId);
      const response = await fetch(`/api/reviews/${encodeURIComponent(channelId)}/${action}`, {
        method: 'POST',
        headers: {
          ...reviewHeaders(),
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID()
        },
        body: JSON.stringify({ reviewVersion: details.reviewVersion, reason, notes })
      });
      if (!response.ok) throw new Error(await parseError(response));

      setReviewDetails(null);
      setDecidedChannelIds(previous => new Set(previous).add(channelId));
      await onReviewCompleted?.();
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : 'Unable to complete the review action.');
      try {
        setReviewDetails(await loadReviewDetails(channelId));
      } catch {
        // The action error remains the useful message if refreshed details are unavailable.
      }
    } finally {
      setReviewBusy(null);
    }
  };

  const handleRecheckClick = async (channel: ChannelRecord) => {
    if (channel.scan_status === 'LOCKED') return;
    setRecheckingId(channel.channel_id);
    try {
      await onRecheck(channel.channel_id);
    } finally {
      setRecheckingId(null);
    }
  };

  return (
    <div className="space-y-4">
      
      {/* Search & Filter Toolbar */}
      <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs space-y-3">
        {reviewEnabled && (
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 pb-3 border-b border-slate-100 dark:border-slate-800">
            <div>
              <div className="flex items-center gap-2 font-bold text-sm text-slate-900 dark:text-white">
                <ShieldAlert className="w-4 h-4 text-amber-500" />
                Human review
              </div>
              <p className="text-[11px] text-slate-500 mt-0.5">Review channels awaiting a decision directly in the table.</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                aria-label="Reviewer API token"
                type="password"
                value={reviewToken}
                onChange={event => {
                  setReviewToken(event.target.value);
                  localStorage.setItem('review-token', event.target.value);
                }}
                placeholder="Reviewer API token"
                className="w-44 px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800"
              />
              <input
                aria-label="Reviewer identity"
                value={reviewer}
                onChange={event => {
                  setReviewer(event.target.value);
                  localStorage.setItem('reviewer-id', event.target.value);
                }}
                placeholder="Reviewer identity"
                className="w-40 px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800"
              />
              <button
                type="button"
                onClick={() => setPendingReviewOnly(value => !value)}
                className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${pendingReviewOnly ? 'bg-violet-600 border-violet-600 text-white' : 'border-violet-200 dark:border-violet-800 text-violet-700 dark:text-violet-300 hover:bg-violet-50 dark:hover:bg-violet-950'}`}
              >
                Pending review ({channels.filter(channel => channel.scan_status === 'NEEDS_REVIEW' && !decidedChannelIds.has(channel.channel_id)).length})
              </button>
            </div>
          </div>
        )}
        {reviewEnabled && reviewError && (
          <div role="alert" className="flex items-center justify-between gap-3 rounded-lg bg-rose-50 dark:bg-rose-950/40 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
            <span>{reviewError}</span>
            <button type="button" onClick={() => setReviewError('')} aria-label="Dismiss review error"><X className="w-3.5 h-3.5" /></button>
          </div>
        )}
        <div className="flex flex-col md:flex-row gap-3 items-center justify-between">
          
          {/* Search Input */}
          <div className="relative w-full md:w-72">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              placeholder="Filter channels by name..."
              className="w-full pl-9 pr-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          {/* Filters Row */}
          <div className="flex flex-wrap items-center gap-2 w-full md:w-auto">
            {/* Country Filter */}
            <select
              value={selectedCountry}
              onChange={e => setSelectedCountry(e.target.value)}
              className="px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-800 dark:text-slate-200"
            >
              <option value="ALL">All Countries</option>
              {countries.map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>

            {/* Country Status */}
            <select
              value={selectedCountryStatus}
              onChange={e => setSelectedCountryStatus(e.target.value)}
              className="px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-800 dark:text-slate-200"
            >
              <option value="ALL">Country Status (All)</option>
              <option value="CONFIRMED">CONFIRMED (80%+)</option>
              <option value="LIKELY">LIKELY (60-79%)</option>
              <option value="UNCERTAIN">UNCERTAIN (40-59%)</option>
              <option value="REJECTED">REJECTED (Hard Gate)</option>
            </select>

            {/* Trading Domain Status Filter */}
            <select
              value={selectedTradingStatus}
              onChange={e => setSelectedTradingStatus(e.target.value)}
              className="px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-800 dark:text-slate-200"
            >
              <option value="ALL">Trading Relevance (All)</option>
              <option value="TRADING_CONFIRMED">TRADING CONFIRMED</option>
              <option value="NON_TRADING">NON-TRADING (Filtered Out)</option>
              <option value="UNCERTAIN">UNCERTAIN</option>
              <option value="NEEDS_REVIEW">NEEDS REVIEW</option>
            </select>

            {/* Discord Status */}
            <select
              value={selectedDiscordStatus}
              onChange={e => setSelectedDiscordStatus(e.target.value)}
              className="px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-800 dark:text-slate-200"
            >
              <option value="ALL">Discord Status (All)</option>
              <option value="ACTIVE">ACTIVE (50+ members)</option>
              <option value="ACTIVE_LOW_VOLUME">ACTIVE LOW VOL (&lt;50 members)</option>
              <option value="UNCERTAIN">UNCERTAIN (Ambiguous Niche)</option>
              <option value="NON_TRADING">NON_TRADING (Irrelevant Niche)</option>
              <option value="NOT_FOUND">NOT FOUND</option>
              <option value="PENDING">PENDING</option>
              <option value="DEAD">DEAD / Expired</option>
            </select>

            {/* Scan Status */}
            <select
              value={selectedScanStatus}
              onChange={e => setSelectedScanStatus(e.target.value)}
              className="px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-800 dark:text-slate-200"
            >
              <option value="ALL">Scan Status (All)</option>
              <option value="COMPLETED">COMPLETED</option>
              <option value="SKIPPED_EXCLUDED">SKIPPED (Excluded Country)</option>
              <option value="SKIPPED_NON_TRADING">SKIPPED (Non-Trading)</option>
              <option value="PENDING">PENDING</option>
              <option value="LOCKED">LOCKED</option>
              <option value="ENRICHMENT_PENDING">ENRICHMENT PENDING</option>
              <option value="ENRICHING">ENRICHING</option>
              <option value="NEEDS_REVIEW">NEEDS REVIEW</option>
              <option value="FAILED">FAILED</option>
              <option value="FAILED_PERMANENT">FAILED_PERMANENT</option>
            </select>
          </div>

        </div>
      </div>

      {/* Table Section */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden shadow-xs">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            
            <thead className="bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 font-semibold uppercase tracking-wider text-[10px]">
              <tr>
                <th className="py-3 px-4">Channel & YouTube</th>
                <th className="py-3 px-4">Trading Relevance</th>
                <th className="py-3 px-4">Country & Confidence</th>
                <th className="py-3 px-4">Creator Quality</th>
                <th className="py-3 px-4">Discord Status & Invite</th>
                <th className="py-3 px-4">Scan Status</th>
                <th className="py-3 px-4">Last Scanned</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>

            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
              {filteredChannels.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-12 text-center text-slate-500 dark:text-slate-400">
                    {pendingReviewOnly ? 'No channels are awaiting human review.' : 'No validated channels match the selected filters.'}
                  </td>
                </tr>
              ) : (
                filteredChannels.map(c => (
                  <tr key={c.channel_id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40 transition-colors">
                    
                    {/* Channel & Link */}
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-3">
                        {c.channel_thumbnail_url ? (
                          <img
                            src={c.channel_thumbnail_url}
                            alt={c.channel_name}
                            className="w-9 h-9 rounded-full object-cover border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 shrink-0"
                            onError={(e) => {
                              // Fallback if image fails to load
                              (e.target as HTMLImageElement).src = `https://ui-avatars.com/api/?name=${encodeURIComponent(c.channel_name)}&background=0f172a&color=38bdf8&bold=true`;
                            }}
                          />
                        ) : (
                          <div className="w-9 h-9 rounded-full bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200 font-bold flex items-center justify-center text-xs shrink-0">
                            {c.channel_name.charAt(0)}
                          </div>
                        )}

                        <div>
                          <div className="font-bold text-slate-900 dark:text-white text-xs">
                            {c.channel_name}
                          </div>

                          {c.subscriber_count && (
                            <div className="text-[10px] text-slate-500 dark:text-slate-400 font-medium">
                              {c.subscriber_count}
                            </div>
                          )}

                          <a
                            href={c.youtube_url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-[11px] text-indigo-600 dark:text-indigo-400 hover:underline mt-0.5 font-medium"
                          >
                            <span>YouTube Link</span>
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        </div>
                      </div>
                    </td>

                    {/* Gate 1: Trading Relevance Classifier */}
                    <td className="py-3 px-4">
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-1.5">
                          <span className={`px-2 py-0.5 rounded-md text-[10px] font-bold ${
                            c.trading_status === 'TRADING_CONFIRMED'
                              ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 border border-emerald-300/50 dark:border-emerald-800'
                              : c.trading_status === 'NON_TRADING'
                              ? 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300 border border-rose-300/50 dark:border-rose-800'
                              : 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
                          }`}>
                            {c.trading_status === 'TRADING_CONFIRMED' ? 'TRADING CONFIRMED' : c.trading_status === 'NON_TRADING' ? 'NON-TRADING' : c.trading_status === 'NEEDS_REVIEW' ? 'NEEDS REVIEW' : 'UNCERTAIN'}
                          </span>
                          <span className="text-[10px] font-mono font-semibold text-slate-500 dark:text-slate-400">
                            {c.trading_confidence_score || 0}%
                          </span>
                        </div>
                        <div className="text-[10px] font-medium text-slate-600 dark:text-slate-300">
                          {c.trading_category || 'General Trading'}
                        </div>
                        {c.trading_relevance_breakdown?.ai_reviewed && (
                          <span className="text-[9px] text-indigo-500 dark:text-indigo-400 font-semibold">
                            ✦ AI Verified
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Country & Score */}
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-slate-800 dark:text-slate-200">{c.country}</span>
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                          c.country_status === 'CONFIRMED'
                            ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
                            : c.country_status === 'LIKELY'
                            ? 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300'
                            : 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
                        }`}>
                          {c.country_status}
                        </span>
                      </div>

                      {/* Confidence Bar */}
                      <div className="mt-1.5 flex items-center gap-2">
                        <div className="w-20 h-1.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                          <div
                            className={`h-full ${c.confidence_score >= 80 ? 'bg-emerald-500' : c.confidence_score >= 60 ? 'bg-sky-500' : 'bg-amber-500'}`}
                            style={{ width: `${c.confidence_score}%` }}
                          />
                        </div>
                        <span className="text-[10px] font-mono font-medium text-slate-500">{c.confidence_score}%</span>
                      </div>
                    </td>

                    {/* Creator Quality Score */}
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-2">
                        <span className={`px-2.5 py-1 rounded-lg font-mono font-black text-xs ${
                          (c.quality_score || 0) >= 70
                            ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 border border-emerald-300 dark:border-emerald-800'
                            : (c.quality_score || 0) >= 50
                            ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 border border-amber-300 dark:border-amber-800'
                            : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
                        }`}>
                          {c.quality_score || 0}/100
                        </span>
                      </div>
                      <div className="text-[10px] text-slate-500 dark:text-slate-400 mt-1">
                        {(c.quality_score || 0) >= 60 ? 'Active Educational' : 'Standard Creator'}
                      </div>
                    </td>

                    {/* Discord Status & Link */}
                    <td className="py-3 px-4">
                      <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-bold ${
                        c.discord_status === 'ACTIVE'
                          ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/80 dark:text-emerald-300'
                          : c.discord_status === 'ACTIVE_LOW_VOLUME'
                          ? 'bg-teal-100 text-teal-800 dark:bg-teal-950/80 dark:text-teal-300'
                          : c.discord_status === 'UNCERTAIN'
                          ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/80 dark:text-amber-300 border border-amber-200 dark:border-amber-800'
                          : c.discord_status === 'NON_TRADING'
                          ? 'bg-purple-100 text-purple-800 dark:bg-purple-950/80 dark:text-purple-300 border border-purple-200 dark:border-purple-800'
                          : c.discord_status === 'DEAD'
                          ? 'bg-rose-100 text-rose-800 dark:bg-rose-950/80 dark:text-rose-300'
                          : c.discord_status === 'PENDING'
                          ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/80 dark:text-amber-300'
                          : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
                      }`}>
                        {c.discord_status}
                      </span>

                      {c.discord_invite && (
                        <div className="mt-1 flex items-center gap-1.5">
                          <a
                            href={c.discord_invite}
                            target="_blank"
                            rel="noreferrer"
                            className="font-mono text-[11px] text-indigo-600 dark:text-indigo-400 font-semibold hover:underline"
                          >
                            {c.discord_invite.replace('https://', '')}
                          </a>
                          <button
                            onClick={() => handleCopyLink(c.discord_invite!, c.channel_id)}
                            className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                            title="Copy link"
                          >
                            {copiedId === c.channel_id ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
                          </button>
                        </div>
                      )}
                    </td>

                    {/* Scan Status */}
                    <td className="py-3 px-4">
                      <span className={`font-mono text-[11px] font-semibold ${
                        c.scan_status === 'COMPLETED'
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : c.scan_status === 'LOCKED' || c.scan_status === 'ENRICHING'
                          ? 'text-amber-600 dark:text-amber-400 animate-pulse'
                          : c.scan_status === 'NEEDS_REVIEW'
                          ? 'text-violet-600 dark:text-violet-400 font-bold'
                          : c.scan_status === 'FAILED_PERMANENT'
                          ? 'text-rose-600 dark:text-rose-400 font-bold'
                          : 'text-slate-500'
                      }`}>
                        {c.scan_status === 'LOCKED' ? 'LOCKED (Scanning)' : c.scan_status === 'ENRICHING' ? 'ENRICHING (Reclassifying)' : c.scan_status}
                      </span>
                      {c.scan_attempts > 0 && (
                        <span className="block text-[10px] text-slate-400 mt-0.5">
                          Attempts: {c.scan_attempts}
                        </span>
                      )}
                    </td>

                    {/* Last Scanned */}
                    <td className="py-3 px-4 text-slate-500 text-[11px]">
                      <div>{c.last_checked ? new Date(c.last_checked).toLocaleString() : 'Never'}</div>
                    </td>

                    {/* Actions */}
                    <td className="py-3 px-4 text-right space-x-1.5">
                      {reviewEnabled && c.scan_status === 'NEEDS_REVIEW' && !decidedChannelIds.has(c.channel_id) && (
                        <>
                          <button
                            onClick={() => handleReviewAction(c.channel_id, 'approve')}
                            disabled={Boolean(reviewBusy)}
                            className="px-2.5 py-1 text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-lg transition-colors inline-flex items-center gap-1"
                          >
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            <span>Approve</span>
                          </button>
                          <button
                            onClick={() => handleReviewAction(c.channel_id, 'reject')}
                            disabled={Boolean(reviewBusy)}
                            className="px-2.5 py-1 text-xs font-semibold bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white rounded-lg transition-colors inline-flex items-center gap-1"
                          >
                            <XCircle className="w-3.5 h-3.5" />
                            <span>Reject</span>
                          </button>
                        </>
                      )}

                      {reviewEnabled && (c.scan_status === 'NEEDS_REVIEW' || c.trading_status === 'HUMAN_REJECTED') && (
                        <button
                          onClick={() => openReviewDetails(c.channel_id)}
                          disabled={Boolean(reviewBusy)}
                          className="px-2.5 py-1 text-xs font-semibold bg-violet-100 hover:bg-violet-200 dark:bg-violet-950 dark:hover:bg-violet-900 text-violet-700 dark:text-violet-300 rounded-lg transition-colors inline-flex items-center gap-1"
                          title="View review evidence and immutable decision history"
                        >
                          <ShieldAlert className="w-3.5 h-3.5" />
                          <span>Review details</span>
                        </button>
                      )}

                      <button
                        onClick={() => onInspect(c)}
                        className="px-2.5 py-1 text-xs font-semibold bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 rounded-lg transition-colors inline-flex items-center gap-1"
                        title="View inspection step-by-step trail"
                      >
                        <Eye className="w-3.5 h-3.5" />
                        <span>Trail</span>
                      </button>

                      <button
                        onClick={() => handleRecheckClick(c)}
                        disabled={c.scan_status === 'LOCKED' || recheckingId === c.channel_id}
                        className={`px-2.5 py-1 text-xs font-semibold rounded-lg transition-colors inline-flex items-center gap-1 ${
                          c.scan_status === 'LOCKED'
                            ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 cursor-not-allowed'
                            : 'bg-indigo-600 hover:bg-indigo-700 text-white'
                        }`}
                      >
                        <RefreshCw className={`w-3.5 h-3.5 ${recheckingId === c.channel_id ? 'animate-spin' : ''}`} />
                        <span>{c.scan_status === 'LOCKED' ? 'Currently processing' : 'Re-check Now'}</span>
                      </button>
                    </td>

                  </tr>
                ))
              )}
            </tbody>

          </table>
        </div>
      </div>

      {reviewEnabled && reviewDetails && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4" role="dialog" aria-modal="true" aria-labelledby="review-details-title">
          <div className="w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-xl p-5 space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 id="review-details-title" className="font-bold text-lg">{reviewDetails.channelName}</h3>
                <a className="text-indigo-600 dark:text-indigo-400 text-sm hover:underline" href={reviewDetails.youtubeUrl} target="_blank" rel="noreferrer">Open YouTube channel</a>
                <p className="text-xs text-slate-500">{reviewDetails.country} · {reviewDetails.state} · version {reviewDetails.reviewVersion}</p>
              </div>
              <button type="button" onClick={() => setReviewDetails(null)} className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Close review details"><X className="w-5 h-5" /></button>
            </div>
            <div>
              <h4 className="font-semibold text-sm mb-1">Evidence snapshot</h4>
              <pre className="text-xs overflow-auto max-h-64 bg-slate-100 dark:bg-slate-950 p-3 rounded-lg">{JSON.stringify(reviewDetails.evidenceSnapshot, null, 2)}</pre>
            </div>
            <div>
              <h4 className="font-semibold text-sm">Decision history</h4>
              {reviewDetails.history?.length ? reviewDetails.history.map(entry => (
                <div key={entry.id} className="text-xs border-l-2 border-violet-400 pl-2 my-2">
                  <b>{entry.decision}</b> by {entry.reviewer} · v{entry.review_version}<br />
                  {entry.reason}{entry.notes && <> — {entry.notes}</>}
                </div>
              )) : <p className="text-xs text-slate-500 mt-1">No decisions yet.</p>}
            </div>
            <div className="flex flex-wrap gap-2">
              {reviewDetails.state === 'PENDING' && (
                <>
                  <button disabled={Boolean(reviewBusy)} onClick={() => handleReviewAction(reviewDetails.channelId, 'approve', reviewDetails)} className="flex items-center gap-1 bg-emerald-600 disabled:opacity-50 text-white rounded-lg px-3 py-2 text-sm font-semibold"><CheckCircle2 size={16} />Approve</button>
                  <button disabled={Boolean(reviewBusy)} onClick={() => handleReviewAction(reviewDetails.channelId, 'reject', reviewDetails)} className="flex items-center gap-1 bg-rose-600 disabled:opacity-50 text-white rounded-lg px-3 py-2 text-sm font-semibold"><XCircle size={16} />Reject</button>
                </>
              )}
              {reviewDetails.state === 'REJECTED' && (
                <button disabled={Boolean(reviewBusy)} onClick={() => handleReviewAction(reviewDetails.channelId, 'force-rescan', reviewDetails)} className="flex items-center gap-1 bg-amber-600 disabled:opacity-50 text-white rounded-lg px-3 py-2 text-sm font-semibold"><RefreshCw size={16} />Force rescan</button>
              )}
            </div>
          </div>
        </div>
      )}

    </div>
  );
};
