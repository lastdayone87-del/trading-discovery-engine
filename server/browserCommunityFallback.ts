import { candidateFromNativeInvite, extractDiscordCandidates, mergeDiscordCandidates, type DiscordCandidate } from './discordCandidates';
import { browserLaunchOptions, classifyBrowserFailure, markBrowserCapabilityReady, markBrowserCapabilityUnavailable, type BrowserFailureClass } from './browserCapability';
import {
  DEFAULT_RENDERED_MAX_REQUEST_RETRIES,
  DEFAULT_RENDERED_MAX_SESSION_ROTATIONS,
  renderedCrawlerRetryPolicy,
} from './renderedCrawlerPolicy';

export interface BrowserFallbackBudget {
  maxPages: number;
  maxScrollsPerPage: number;
  maxClicksPerPage: number;
  maxRequestRetries: number;
  maxSessionRotations: number;
  navigationTimeoutMs: number;
  totalTimeoutMs: number;
}

export interface BrowserFallbackResult {
  foundInvite: string | null;
  foundLocation?: string;
  candidates?: DiscordCandidate[];
  inspectedPages: number;
  scrolls: number;
  clicks: number;
  complete: boolean;
  retryable: boolean;
  failureClass?: BrowserFailureClass;
  detail: string;
}

export const DEFAULT_BROWSER_FALLBACK_BUDGET: BrowserFallbackBudget = {
  maxPages: 6,
  maxScrollsPerPage: 5,
  maxClicksPerPage: 4,
  maxRequestRetries: DEFAULT_RENDERED_MAX_REQUEST_RETRIES,
  maxSessionRotations: DEFAULT_RENDERED_MAX_SESSION_ROTATIONS,
  navigationTimeoutMs: 15_000,
  totalTimeoutMs: 60_000,
};

const COMMUNITY_HINTS = /discord|community|join|chat|member|membership|vip|group|private|trading.?room|links?|social|contact|about/i;

/**
 * Telegram channel pages contain a link for virtually every message. Those
 * message permalinks are content pages, not additional creator/community
 * surfaces, so recursively crawling them spends the rendered acquisition
 * budget without increasing Discord coverage. A post permalink can still be
 * used as the initial seed when explicitly supplied; this only filters links
 * discovered while traversing a rendered page.
 */
export function isTelegramPostPermalink(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (hostname !== 't.me' && hostname !== 'telegram.me') return false;
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length === 2) return /^\d+$/.test(parts[1]);
    if (parts.length === 3 && parts[0].toLowerCase() === 's') return /^\d+$/.test(parts[2]);
    return false;
  } catch {
    return false;
  }
}

export function shouldEnqueueRenderedCommunityLink(rawUrl: string): boolean {
  if (isTelegramPostPermalink(rawUrl)) return false;
  return COMMUNITY_HINTS.test(rawUrl);
}

function boundedEnvInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

export class RenderedFallbackGate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(readonly concurrency: number, readonly maxPending: number) {}

  private acquire(): Promise<() => void> {
    if (this.active >= this.concurrency && this.waiters.length >= this.maxPending) return Promise.reject(new Error('RENDERED_FALLBACK_SATURATED'));
    return new Promise(resolve => {
      const grant = () => {
        this.active++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.active--;
          const next = this.waiters.shift();
          if (next) next();
        });
      };
      if (this.active < this.concurrency) grant(); else this.waiters.push(grant);
    });
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try { return await operation(); } finally { release(); }
  }

  snapshot(): { active: number; pending: number; concurrency: number; maxPending: number } {
    return { active: this.active, pending: this.waiters.length, concurrency: this.concurrency, maxPending: this.maxPending };
  }
}

export const renderedFallbackGate = new RenderedFallbackGate(
  boundedEnvInt(process.env.RENDERED_FALLBACK_CONCURRENCY, 1, 1, 2),
  boundedEnvInt(process.env.RENDERED_FALLBACK_MAX_PENDING, 8, 0, 32),
);

/** Expensive Tier-2 acquisition. Finding one invite no longer terminates the
 * rendered crawl: every invite visible within the bounded page/click budget is
 * retained so ownership can be decided after acquisition. */
export async function crawlRenderedCommunitySurface(seedUrl: string, budget: Partial<BrowserFallbackBudget> = {}): Promise<BrowserFallbackResult> {
  const limits = { ...DEFAULT_BROWSER_FALLBACK_BUDGET, ...budget };
  let inspectedPages = 0, scrolls = 0, clicks = 0;
  const discovered:DiscordCandidate[]=[];
  const retain=(text:string,sourceUrl:string)=>{
    const candidates=extractDiscordCandidates(text,'CREATOR_WEBSITES',sourceUrl).filter(candidate=>candidate.nativeInviteCode);
    discovered.push(...candidates);
  };
  retain(seedUrl,seedUrl);

  try {
    return await renderedFallbackGate.run(async () => {
      const startedAt = Date.now();
      try {
        const { PlaywrightCrawler } = await import('crawlee');
        const crawler = new PlaywrightCrawler({
          maxRequestsPerCrawl: limits.maxPages,
          maxConcurrency: 1,
          maxRequestRetries: limits.maxRequestRetries,
          maxSessionRotations: limits.maxSessionRotations,
          useSessionPool: true,
          persistCookiesPerSession: true,
          retryOnBlocked: true,
          sameDomainDelaySecs: 1,
          navigationTimeoutSecs: Math.ceil(limits.navigationTimeoutMs / 1000),
          requestHandlerTimeoutSecs: Math.ceil(limits.totalTimeoutMs / 1000),
          launchContext: { launchOptions: browserLaunchOptions() },
          preNavigationHooks: [async ({ page }) => {
            await page.route('**/*', async route => {
              const type = route.request().resourceType();
              if (['image', 'media', 'font'].includes(type)) await route.abort(); else await route.continue();
            });
          }],
          errorHandler: async ({ request, session }, error) => {
            const policy = renderedCrawlerRetryPolicy(error, request.retryCount || 0);
            if (policy.retireSession) session?.retire();
            const remainingMs = Math.max(0, limits.totalTimeoutMs - (Date.now() - startedAt));
            if (policy.delayMs > 0 && remainingMs > 0) await new Promise(resolve => setTimeout(resolve, Math.min(policy.delayMs, remainingMs)));
          },
          async requestHandler({ page, enqueueLinks }) {
            if (Date.now() - startedAt >= limits.totalTimeoutMs) return;
            inspectedPages++;
            const inspect = async () => {
              const url=page.url(),html=await page.content();
              retain(`${url}\n${html}`,url);
            };
            await inspect();

            for (let i = 0; i < limits.maxScrollsPerPage; i++) {
              if (Date.now() - startedAt >= limits.totalTimeoutMs) break;
              const before = await page.evaluate(() => document.body?.scrollHeight || 0);
              await page.evaluate(() => window.scrollTo(0, document.body?.scrollHeight || 0));
              await page.waitForTimeout(500); scrolls++; await inspect();
              const after = await page.evaluate(() => document.body?.scrollHeight || 0);
              if (after <= before) break;
            }

            const controls = await page.locator('a,button,[role="button"]').evaluateAll((nodes, pattern) => {
              const re = new RegExp(pattern, 'i');
              return nodes.map((node, index) => ({index,text:`${(node as HTMLElement).innerText || ''} ${(node as HTMLAnchorElement).href || ''} ${(node as HTMLElement).getAttribute('aria-label') || ''}`})).filter(item => re.test(item.text)).slice(0, 12);
            }, COMMUNITY_HINTS.source);

            for (const control of controls.slice(0, limits.maxClicksPerPage)) {
              if (Date.now() - startedAt >= limits.totalTimeoutMs) break;
              const locator=page.locator('a,button,[role="button"]').nth(control.index);
              const href=await locator.getAttribute('href').catch(()=>null);
              retain(`${control.text} ${href||''}`,page.url());
              try { await locator.click({timeout:2_000}); clicks++; await page.waitForTimeout(400); await inspect(); } catch { /* optional interaction */ }
            }

            if (Date.now() - startedAt < limits.totalTimeoutMs) {
              await enqueueLinks({strategy:'same-hostname',transformRequestFunction:req=>shouldEnqueueRenderedCommunityLink(req.url)?req:false});
            }
          },
        });

        await crawler.run([seedUrl]);
        markBrowserCapabilityReady();
        const timedOut=Date.now()-startedAt>=limits.totalTimeoutMs;
        const candidates=mergeDiscordCandidates(discovered);
        const first=candidates[0];
        return {
          foundInvite:first?.nativeInviteCode||null,
          foundLocation:first?.sourceUrl,
          candidates,
          inspectedPages,scrolls,clicks,
          complete:!timedOut,
          retryable:timedOut,
          detail:candidates.length
            ? `Rendered fallback retained ${candidates.length} distinct Discord candidate(s) across ${inspectedPages} page(s)`
            : timedOut?'Rendered acquisition budget expired before coverage completed':`Rendered acquisition completed across ${inspectedPages} page(s) without an invite`,
        };
      } catch (error:any) {
        const candidates=mergeDiscordCandidates(discovered);
        const failureClass=classifyBrowserFailure(error);
        markBrowserCapabilityUnavailable(error);
        return {foundInvite:candidates[0]?.nativeInviteCode||null,foundLocation:candidates[0]?.sourceUrl,candidates,inspectedPages,scrolls,clicks,complete:false,retryable:true,failureClass,detail:`Rendered acquisition unavailable or failed: ${String(error?.message||error)}`};
      }
    });
  } catch (error:any) {
    const candidates=mergeDiscordCandidates(discovered);
    const saturated=error?.message==='RENDERED_FALLBACK_SATURATED';
    if(!saturated)markBrowserCapabilityUnavailable(error);
    return {foundInvite:candidates[0]?.nativeInviteCode||null,foundLocation:candidates[0]?.sourceUrl,candidates,inspectedPages,scrolls,clicks,complete:false,retryable:true,failureClass:saturated?undefined:classifyBrowserFailure(error),detail:saturated?'Rendered acquisition deferred because the process-wide browser launch gate is saturated':`Rendered acquisition unavailable or failed: ${String(error?.message||error)}`};
  }
}

export function shouldEscalateToRenderedFallback(input: {
  staticOutcome: 'FOUND'|'INSPECTED_NO_MATCH'|'PARTIALLY_INSPECTED'|'ACQUISITION_FAILED';
  creatorLikelyTrading?: boolean;
  surface: 'CREATOR_WEBSITES'|'SOCIAL_PROFILES'|'OTHER';
}): boolean {
  if (input.staticOutcome === 'FOUND') return false;
  if (!input.creatorLikelyTrading) return false;
  if (input.surface === 'OTHER') return false;
  return input.staticOutcome === 'PARTIALLY_INSPECTED' || input.staticOutcome === 'ACQUISITION_FAILED' || input.staticOutcome === 'INSPECTED_NO_MATCH';
}
