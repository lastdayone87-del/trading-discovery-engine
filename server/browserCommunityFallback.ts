import { extractDiscordCandidates } from './discordCandidates';

export interface BrowserFallbackBudget {
  maxPages: number;
  maxScrollsPerPage: number;
  maxClicksPerPage: number;
  navigationTimeoutMs: number;
  totalTimeoutMs: number;
}

export interface BrowserFallbackResult {
  foundInvite: string | null;
  foundLocation?: string;
  inspectedPages: number;
  scrolls: number;
  clicks: number;
  complete: boolean;
  retryable: boolean;
  detail: string;
}

export const DEFAULT_BROWSER_FALLBACK_BUDGET: BrowserFallbackBudget = {
  maxPages: 4,
  maxScrollsPerPage: 4,
  maxClicksPerPage: 3,
  navigationTimeoutMs: 12_000,
  totalTimeoutMs: 35_000,
};

const COMMUNITY_HINTS = /discord|community|join|chat|member|membership|vip|group|private|trading.?room|links?|social|contact|about/i;

function nativeInvite(text: string): string | null {
  return extractDiscordCandidates(text).find(candidate => candidate.nativeInviteCode)?.nativeInviteCode || null;
}

/**
 * Expensive Tier-2 acquisition. The normal static crawler should always run first.
 * Playwright/Crawlee are loaded lazily so ordinary inspections do not launch a
 * browser or pay its memory/startup cost.
 */
export async function crawlRenderedCommunitySurface(
  seedUrl: string,
  budget: Partial<BrowserFallbackBudget> = {},
): Promise<BrowserFallbackResult> {
  const limits = { ...DEFAULT_BROWSER_FALLBACK_BUDGET, ...budget };
  const startedAt = Date.now();
  let inspectedPages = 0;
  let scrolls = 0;
  let clicks = 0;
  let foundInvite: string | null = nativeInvite(seedUrl);
  let foundLocation: string | undefined = foundInvite ? seedUrl : undefined;

  if (foundInvite) return { foundInvite, foundLocation, inspectedPages, scrolls, clicks, complete: true, retryable: false, detail: 'Direct Discord invite in seed URL' };

  try {
    const { PlaywrightCrawler } = await import('crawlee');
    const crawler = new PlaywrightCrawler({
      maxRequestsPerCrawl: limits.maxPages,
      maxConcurrency: 1,
      maxRequestRetries: 1,
      navigationTimeoutSecs: Math.ceil(limits.navigationTimeoutMs / 1000),
      requestHandlerTimeoutSecs: Math.ceil(limits.totalTimeoutMs / 1000),
      launchContext: { launchOptions: { headless: true } },
      preNavigationHooks: [async ({ page }) => {
        await page.route('**/*', async route => {
          const type = route.request().resourceType();
          if (['image', 'media', 'font'].includes(type)) await route.abort();
          else await route.continue();
        });
      }],
      async requestHandler({ page, request, enqueueLinks }) {
        if (foundInvite || Date.now() - startedAt >= limits.totalTimeoutMs) return;
        inspectedPages++;

        const inspect = async () => {
          const url = page.url();
          const html = await page.content();
          const text = `${url}\n${html}`;
          const invite = nativeInvite(text);
          if (invite) {
            foundInvite = invite;
            foundLocation = url;
            return true;
          }
          return false;
        };

        if (await inspect()) return;

        for (let i = 0; i < limits.maxScrollsPerPage && !foundInvite; i++) {
          if (Date.now() - startedAt >= limits.totalTimeoutMs) break;
          const before = await page.evaluate(() => document.body?.scrollHeight || 0);
          await page.evaluate(() => window.scrollTo(0, document.body?.scrollHeight || 0));
          await page.waitForTimeout(500);
          scrolls++;
          if (await inspect()) return;
          const after = await page.evaluate(() => document.body?.scrollHeight || 0);
          if (after <= before) break;
        }

        const candidates = await page.locator('a,button,[role="button"]').evaluateAll((nodes, pattern) => {
          const re = new RegExp(pattern, 'i');
          return nodes.map((node, index) => ({
            index,
            text: `${(node as HTMLElement).innerText || ''} ${(node as HTMLAnchorElement).href || ''} ${(node as HTMLElement).getAttribute('aria-label') || ''}`,
          })).filter(item => re.test(item.text)).slice(0, 12);
        }, COMMUNITY_HINTS.source);

        for (const candidate of candidates.slice(0, limits.maxClicksPerPage)) {
          if (foundInvite || Date.now() - startedAt >= limits.totalTimeoutMs) break;
          const locator = page.locator('a,button,[role="button"]').nth(candidate.index);
          const href = await locator.getAttribute('href').catch(() => null);
          const direct = nativeInvite(`${candidate.text} ${href || ''}`);
          if (direct) { foundInvite = direct; foundLocation = page.url(); return; }
          try {
            await locator.click({ timeout: 2_000 });
            clicks++;
            await page.waitForTimeout(400);
            if (await inspect()) return;
          } catch { /* a failed optional click does not abort acquisition */ }
        }

        if (!foundInvite && Date.now() - startedAt < limits.totalTimeoutMs) {
          await enqueueLinks({
            strategy: 'same-hostname',
            transformRequestFunction: req => COMMUNITY_HINTS.test(req.url) ? req : false,
          });
        }
      },
    });

    await crawler.run([seedUrl]);
    const timedOut = Date.now() - startedAt >= limits.totalTimeoutMs;
    return {
      foundInvite,
      foundLocation,
      inspectedPages,
      scrolls,
      clicks,
      complete: Boolean(foundInvite) || !timedOut,
      retryable: !foundInvite && timedOut,
      detail: foundInvite
        ? `Discord invite discovered by rendered fallback after ${inspectedPages} page(s)`
        : timedOut
          ? 'Rendered acquisition budget expired before coverage completed'
          : `Rendered acquisition completed across ${inspectedPages} page(s) without an invite`,
    };
  } catch (error: any) {
    return {
      foundInvite: null,
      inspectedPages,
      scrolls,
      clicks,
      complete: false,
      retryable: true,
      detail: `Rendered acquisition unavailable or failed: ${String(error?.message || error)}`,
    };
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
