import type { DashboardChannelFilters } from './components/ResultsTable';

/** One canonical filter serialization shared by page fetches and revision polls. */
export function channelListingSearchParams(filters:DashboardChannelFilters,includeRejected:boolean):URLSearchParams {
  const params=new URLSearchParams();
  if(includeRejected)params.set('include_rejected','true');
  if(filters.search)params.set('search',filters.search);
  if(filters.country!=='ALL')params.set('country',filters.country);
  if(filters.countryStatus!=='ALL')params.set('country_status',filters.countryStatus);
  if(filters.tradingStatus!=='ALL')params.set('trading_status',filters.tradingStatus);
  if(filters.discordStatus!=='ALL')params.set('discord_status',filters.discordStatus);
  if(filters.scanStatus!=='ALL')params.set('scan_status',filters.scanStatus);
  return params;
}
