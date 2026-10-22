/**
 * Test-only wrappers that keep fixture hostnames deterministic after the
 * production crawler switched its default resolver to real DNS.
 *
 * These wrappers are imported only by tests. Production code never imports
 * this module, and no synthetic-public fallback exists in the production
 * resolver selection.
 */
import {
  crawlExternalLinks,
  crawlMessagingPreview,
  runChannelInspection,
} from './inspector';
import type { DnsResolver } from './publicDestination';

export const publicTestResolver: DnsResolver = async () => ['93.184.216.1'];

function withDefaultResolver<T extends (...args: any[]) => any>(
  fn: T,
  resolverIndex: number,
): (...args: Parameters<T>) => ReturnType<T> {
  return (...args: Parameters<T>): ReturnType<T> => {
    const next = [...args] as any[];
    while (next.length < resolverIndex) next.push(undefined);
    if (next.length === resolverIndex || next[resolverIndex] === undefined) {
      next[resolverIndex] = publicTestResolver;
    }
    return (fn as (...innerArgs: any[]) => ReturnType<T>)(...next);
  };
}

export const crawlExternalLinksForTest = withDefaultResolver(crawlExternalLinks, 13);
export const crawlMessagingPreviewForTest = withDefaultResolver(crawlMessagingPreview, 6);

export const runChannelInspectionForTest = (
  channelData: Parameters<typeof runChannelInspection>[0],
): ReturnType<typeof runChannelInspection> => runChannelInspection({
  ...channelData,
  destinationResolver: channelData.destinationResolver ?? publicTestResolver,
});
