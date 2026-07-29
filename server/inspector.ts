import * as cheerio from 'cheerio';
import { InspectionStep } from '../src/types';
import { incrementQuota } from './db';
import { fetchRecentVideoDescriptionsFromAPI } from './youtube';

export interface InspectionResult {
  debugLog?: any;
  foundInvite: string | null;
  foundLocation?: string;
  steps: InspectionStep[];
  extractedThumbnailUrl?: string;
  observedAboutBio: string;
  observedChannelLinks: string[];
}

/**
 * Extracts clean Discord invite code or link from raw text.
 * Handles obfuscated formats, JSON escaping, and alternative URL formats:
 * - discord.gg/XXXXX
 * - discord.com/invite/XXXXX
 * - discordapp.com/invite/XXXXX
 * - discord.app/invite/XXXXX
 * - dsc.gg/XXXXX
 * - discord.me/XXXXX
 * - discord.io/XXXXX
 * - disboard.org/server/XXXXX
 * - Obfuscated: discord [dot] gg / XXXXX, discord.gg: XXXXX
 */
export function extractDiscordInvite(text: string): string | null {
  if (!text) return null;

  // 1. De-escape JSON slashes & URL encoding
  let cleanText = text
    .replace(/\\\/|\\u002f/gi, '/')
    .replace(/\\u003a/gi, ':')
    .replace(/\\u0026/gi, '&')
    .replace(/%2f/gi, '/')
    .replace(/%3a/gi, ':');

  // 2. De-obfuscate common patterns
  cleanText = cleanText
    .replace(/discord\s*(\[|\()?dot(\]|\))?\s*gg\s*[\/\\]\s*/gi, 'discord.gg/')
    .replace(/discord\s*\[?\.\]?\s*gg\s*[\/\\]\s*/gi, 'discord.gg/')
    .replace(/discord\s*\.\s*gg\s*[\/\\]\s*/gi, 'discord.gg/')
    .replace(/discord\s*(\[|\()?dot(\]|\))?\s*com\s*[\/\\]\s*invite\s*[\/\\]\s*/gi, 'discord.com/invite/')
    .replace(/discord\s*\[?\.\]?\s*com\s*[\/\\]\s*invite\s*[\/\\]\s*/gi, 'discord.com/invite/')
    .replace(/discord\s*\.\s*com\s*[\/\\]\s*invite\s*[\/\\]\s*/gi, 'discord.com/invite/')
    .replace(/discordapp\s*(\[|\()?dot(\]|\))?\s*com\s*[\/\\]\s*invite\s*[\/\\]\s*/gi, 'discordapp.com/invite/')
    .replace(/discordapp\s*\[?\.\]?\s*com\s*[\/\\]\s*invite\s*[\/\\]\s*/gi, 'discordapp.com/invite/')
    .replace(/discordapp\s*\.\s*com\s*[\/\\]\s*invite\s*[\/\\]\s*/gi, 'discordapp.com/invite/');

  const reservedWords = [
    'channels', 'guilds', 'store', 'download', 'nitro', 'login', 'register',
    'api', 'widget', 'terms', 'privacy', 'branding', 'jobs', 'before', 'after',
    'next', 'prev', 'index', 'home', 'about', 'contact', 'faq', 'support',
    'invite', 'oauth2', 'template'
  ];

  // 3. Primary regex: discord.gg/code, discord.com/invite/code, discordapp.com/invite/code, discord.app/invite/code
  const primaryRegex = /(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord\.com\/invite|discordapp\.com\/invite|discord\.app\/invite)\/([a-zA-Z0-9\-_]{2,32})/gi;
  let match: RegExpExecArray | null;
  while ((match = primaryRegex.exec(cleanText)) !== null) {
    const code = match[1];
    const lower = code.toLowerCase();
    if (!reservedWords.includes(lower)) {
      return code;
    }
  }

  // 4. Secondary regex: dsc.gg/code, discord.me/code, discord.io/code, disboard.org/server/code
  const altRegex = /(?:https?:\/\/)?(?:www\.)?(?:dsc\.gg|discord\.me|discord\.io|disboard\.org\/server)\/([a-zA-Z0-9\-_]{2,32})/gi;
  while ((match = altRegex.exec(cleanText)) !== null) {
    const code = match[1];
    if (code && !reservedWords.includes(code.toLowerCase())) return code;
  }

  // 5. Colon regex: "Discord: CODE" or "discord.gg: CODE"
  const colonRegex = /discord(?:\.gg)?\s*[:=\-]\s*([a-zA-Z0-9\-_]{4,25})/gi;
  while ((match = colonRegex.exec(cleanText)) !== null) {
    const code = match[1];
    const lower = code.toLowerCase();
    if (!['http', 'https', 'com', 'org', 'net', 'join', 'server', 'link', ...reservedWords].includes(lower)) {
      return code;
    }
  }

  return null;
}

/**
 * Extracts raw HTTP/HTTPS URLs embedded in any arbitrary text block.
 */
export function extractExternalUrlsFromText(text: string): string[] {
  if (!text) return [];
  const clean = text
    .replace(/\\\/|\\u002f/gi, '/')
    .replace(/\\u003a/gi, ':')
    .replace(/\\u0026/gi, '&')
    .replace(/%2f/gi, '/')
    .replace(/%3a/gi, ':');

  const regex = /https?:\/\/[^\s"'<>\)\\]+/gi;
  const matches = clean.match(regex) || [];

  const results: string[] = [];
  for (let m of matches) {
    m = m.replace(/[\.,\)\;\:\>\<\"]+$/, ''); // Clean trailing punctuation
    const lowerM = m.toLowerCase();
    if (
      !lowerM.includes('youtube.com') &&
      !lowerM.includes('youtu.be') &&
      !lowerM.includes('google.com') &&
      !lowerM.includes('googleusercontent.com') &&
      !lowerM.includes('ggpht.com') &&
      !lowerM.includes('gstatic.com') &&
      !lowerM.includes('doubleclick.net') &&
      !lowerM.includes('googlesyndication.com') &&
      !lowerM.includes('schema.org') &&
      !lowerM.includes('w3.org') &&
      !lowerM.includes('googleapis.com') &&
      !lowerM.includes('googlevideo.com') &&
      !lowerM.includes('ytimg.com') &&
      !/\.(png|jpg|jpeg|gif|webp|svg|css|js|wasm|ico|woff|woff2|ttf|eot)(\?.*)?$/i.test(m)
    ) {
      if (!results.includes(m)) {
        results.push(m);
      }
    }
  }
  return results;
}

/**
 * Safely fetches a URL with 10s timeout, max redirect depth.
 */
async function fetchWithTimeout(url: string, depth = 0): Promise<{ html: string; finalUrl: string } | null> {
  if (depth > 2) return null;

  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5'
      },
      redirect: 'follow'
    });
    clearTimeout(id);

    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('json') && !contentType.includes('plain')) {
      return null;
    }

    const html = await res.text();
    return { html, finalUrl: res.url };
  } catch (err) {
    return null;
  }
}

/**
 * Crawls external links (Linktree, Beacons, Carrd, Dub.sh, Bitly, websites) for Discord invites.
 * Resolves HTTP redirects automatically and verifies final landing URL.
 */
export async function crawlExternalLinks(
  links: string[],
  logDetails: string[] = [],
  debugLog?: any
): Promise<{ foundInvite: string | null;  foundLocation?: string; details: string }> {
  let scannedCount = 0;

  for (const rawUrl of links) {
    if (!rawUrl || typeof rawUrl !== 'string') continue;
    let url = rawUrl.trim();
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = `https://${url}`;
    }

    scannedCount++;
    logDetails.push(`[Link #${scannedCount}] Inspecting target: ${url}`);

    // Direct check if URL itself contains invite code
    const directInvite = extractDiscordInvite(url);
    if (debugLog) debugLog.discordRegexAttempts.push({ source: 'crawlExternalLinks_direct', url, result: directInvite });
    if (directInvite) {
      logDetails.push(`Direct Discord link detected in URL parameter: ${url} (Invite: ${directInvite})`);
      return { foundInvite: directInvite, details: logDetails.join('\n') };
    }

    // Crawl target page (fetchWithTimeout follows HTTP redirects)
    const page = await fetchWithTimeout(url, 0);
    if (debugLog && page) {
      debugLog.redirectsFollowed.push({ from: url, to: page.finalUrl });
    }
    if (!page) {
      logDetails.push(`Failed or timed out trying to reach external URL: ${url}`);
      continue;
    }

    logDetails.push(`Successfully loaded ${page.finalUrl} (${page.html.length} bytes)`);

    // CHECK FINAL URL AFTER REDIRECT RESOLUTION!
    const finalUrlInvite = extractDiscordInvite(page.finalUrl);
    if (debugLog) debugLog.discordRegexAttempts.push({ source: 'crawlExternalLinks_finalUrl', url: page.finalUrl, result: finalUrlInvite });
    if (finalUrlInvite) {
      logDetails.push(`Redirect target URL resolved to Discord invite on ${page.finalUrl} (Invite: ${finalUrlInvite})`);
      return { foundInvite: finalUrlInvite, details: logDetails.join('\n') };
    }

    // Extract directly from page HTML (covers embedded JSON state objects in Next.js/React/Nuxt)
    const inviteFromHtml = extractDiscordInvite(page.html);
    if (debugLog) debugLog.discordRegexAttempts.push({ source: 'crawlExternalLinks_html', url: page.finalUrl, textLength: page.html.length, result: inviteFromHtml });
    if (inviteFromHtml) {
      logDetails.push(`Discord invite extracted from page HTML payload on ${page.finalUrl} (Invite: ${inviteFromHtml})`);
      return { foundInvite: inviteFromHtml, details: logDetails.join('\n') };
    }

    // Parse anchor tags
    const $ = cheerio.load(page.html);
    let pageFound: string | null = null;
    const subpagesToVisit: string[] = [];

    $('a[href]').each((_, el) => {
      const href = ($(el).attr('href') || '').trim();
      if (!href) return;

      const inv = extractDiscordInvite(href);
      if (debugLog) debugLog.discordRegexAttempts.push({ source: 'crawlExternalLinks_anchorHref', url: href, result: inv });
      if (inv) {
        pageFound = inv;
        logDetails.push(`Discord link found in anchor href: ${href}`);
        return false;
      }

      // Check for community subpages on custom website domains
      if (
        (href.includes('/discord') || href.includes('/community') || href.includes('/join') || href.includes('/chat')) &&
        !href.includes('youtube.com') && !href.includes('twitter.com')
      ) {
        let fullSub = href;
        if (href.startsWith('/')) {
          try {
            const parsed = new URL(page.finalUrl);
            fullSub = `${parsed.origin}${href}`;
          } catch (e) {}
        }
        if (fullSub.startsWith('http') && !subpagesToVisit.includes(fullSub)) {
          subpagesToVisit.push(fullSub);
        }
      }
    });

    if (pageFound) {
      return { foundInvite: pageFound, details: logDetails.join('\n') };
    }

    // Level 2 depth crawl for community subpages
    for (const subUrl of subpagesToVisit.slice(0, 3)) {
      logDetails.push(`Subpage crawl level 2: ${subUrl}`);
      const subPage = await fetchWithTimeout(subUrl, 1);
      if (subPage) {
        if (debugLog) debugLog.redirectsFollowed.push({ from: subUrl, to: subPage.finalUrl });
        const subFinalInv = extractDiscordInvite(subPage.finalUrl);
        if (debugLog) debugLog.discordRegexAttempts.push({ source: 'crawlExternalLinks_subPage_finalUrl', url: subPage.finalUrl, result: subFinalInv });
        if (subFinalInv) {
          logDetails.push(`Subpage redirect reached Discord invite: ${subPage.finalUrl} (Invite: ${subFinalInv})`);
          return { foundInvite: subFinalInv, details: logDetails.join('\n') };
        }
        const subInv = extractDiscordInvite(subPage.html);
        if (subInv) {
          logDetails.push(`Discord invite extracted from subpage ${subUrl} (Invite: ${subInv})`);
          return { foundInvite: subInv, details: logDetails.join('\n') };
        }
      }
    }
  }

  logDetails.push(`Crawled ${scannedCount} external link(s). No Discord invite detected.`);
  return { foundInvite: null, details: logDetails.join('\n') };
}

/**
 * Crawls social profile bios (Twitter/X, Instagram, TikTok).
 */
async function crawlSocialBios(
  socialUrls: string[],
  logDetails: string[] = [],
  debugLog?: any
): Promise<{ foundInvite: string | null;
  foundLocation?: string; details: string }> {
  for (const url of socialUrls) {
    if (!url.startsWith('http')) continue;

    const inv = extractDiscordInvite(url);
    if (inv) {
      logDetails.push(`Direct social link is Discord: ${url} (Invite: ${inv})`);
      return { foundInvite: inv, details: logDetails.join('\n') };
    }

    logDetails.push(`Fetching social profile page: ${url}`);
    const page = await fetchWithTimeout(url, 0);
    if (page) {
      if (debugLog) debugLog.redirectsFollowed.push({ from: url, to: page.finalUrl });
      const invFromHtml = extractDiscordInvite(page.html);
      if (debugLog) debugLog.discordRegexAttempts.push({ source: 'crawlSocialBios_html', url: page.finalUrl, textLength: page.html.length, result: invFromHtml });
      if (invFromHtml) {
        logDetails.push(`Discord link found in social bio page (${url}) -> Invite: ${invFromHtml}`);
        return { foundInvite: invFromHtml, details: logDetails.join('\n') };
      }

      // Also extract external URLs in social bio HTML and crawl them
      const extInBio = extractExternalUrlsFromText(page.html);
      if (extInBio.length > 0) {
        logDetails.push(`Found ${extInBio.length} external link(s) in social bio HTML. Crawling...`);
        const crawlRes = await crawlExternalLinks(extInBio, logDetails, debugLog);
        if (crawlRes.foundInvite) {
          return crawlRes;
        }
      }
    }
  }

  logDetails.push(`Crawled ${socialUrls.length} social profile URL(s). No Discord detected.`);
  return { foundInvite: null, details: logDetails.join('\n') };
}

/**
 * Web Scraping Fallback: Fetches recent video descriptions from a YouTube channel page.
 * Scrapes top 3 to 5 recent videos from the channel videos tab / watch links.
 */
export async function scrapeRecentVideoDescriptions(youtubeUrl: string): Promise<string[]> {
  if (!youtubeUrl || !youtubeUrl.startsWith('http')) return [];

  try {
    const videosPageUrl = youtubeUrl.endsWith('/videos') ? youtubeUrl : `${youtubeUrl.replace(/\/+$/, '')}/videos`;
    const page = await fetchWithTimeout(videosPageUrl, 0);
    
    if (!page) return [];

    const html = page.html;

    const videoIdMatches = html.match(/\/watch\?v=([a-zA-Z0-9\-_]{11})/g) ||
                           html.match(/"videoId":"([a-zA-Z0-9\-_]{11})"/g) || [];

    const videoIds: string[] = [];
    for (const raw of videoIdMatches) {
      const m = raw.match(/([a-zA-Z0-9\-_]{11})/);
      if (m && m[1] && !videoIds.includes(m[1])) {
        videoIds.push(m[1]);
        if (videoIds.length >= 5) break;
      }
    }

    if (videoIds.length === 0) return [];

    const descriptions: string[] = [];
    for (const vId of videoIds.slice(0, 5)) {
      const watchUrl = `https://www.youtube.com/watch?v=${vId}`;
      const vPage = await fetchWithTimeout(watchUrl, 0);
      if (vPage) {
        const metaDesc = vPage.html.match(/<meta\s+name="description"\s+content="([^"]+)"/i) ||
                         vPage.html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i);
        
        let desc = metaDesc ? metaDesc[1] : '';
        const cleanVHtml = vPage.html.replace(/\\\/|\\u002f/gi, '/').replace(/\\u003a/gi, ':');
        
        const extInVid = extractExternalUrlsFromText(cleanVHtml);
        const invInVid = extractDiscordInvite(cleanVHtml);

        if (invInVid) {
          desc += ` https://discord.gg/${invInVid}`;
        }
        if (extInVid.length > 0) {
          desc += ` ${extInVid.join(' ')}`;
        }

        if (desc.trim()) {
          descriptions.push(desc.trim());
        }
      }
    }

    return descriptions;
  } catch (err) {
    console.warn('Failed to scrape recent video descriptions:', err);
    return [];
  }
}

/**
 * Live YouTube Channel Extractor
 * Scraping fallback to extract bio, external links, video descriptions, and thumbnail image directly from YouTube channel page.
 */
async function fetchLiveYouTubeChannelData(youtubeUrl: string, enableDebug?: boolean): Promise<{
  rawHtml?: string;
  fetchLog?: string;
  bio?: string;
  channelLinks?: string[];
  videoDescriptions?: string[];
  thumbnailUrl?: string;
} | null> {
  if (!youtubeUrl || !youtubeUrl.startsWith('http')) return null;

  const page = await fetchWithTimeout(youtubeUrl, 0);
  if (!page) return null;

  const html = page.html;
  const cleanHtml = html.replace(/\\\/|\\u002f/gi, '/').replace(/\\u003a/gi, ':');

  let thumbnailUrl: string | undefined;
  let bio: string | undefined;
  let explicitLinks: string[] = [];

  // Parse ytInitialData
  const match = html.match(/ytInitialData\s*=\s*({.*?});<\/script>/);
  if (match) {
    try {
      const ytData = JSON.parse(match[1]);
      
      // Extract Full Bio
      if (ytData.metadata?.channelMetadataRenderer?.description) {
        bio = ytData.metadata.channelMetadataRenderer.description;
      }
      
      if (ytData.metadata?.channelMetadataRenderer?.avatar?.thumbnails?.[0]?.url) {
        thumbnailUrl = ytData.metadata.channelMetadataRenderer.avatar.thumbnails[0].url;
      }

      // Recursively extract external links
      function extractLinks(obj: any) {
        if (typeof obj !== 'object' || obj === null) return;
        
        if (obj.channelExternalLinkViewModel?.link?.content) {
           explicitLinks.push(obj.channelExternalLinkViewModel.link.content);
        }
        
        if (obj.urlEndpoint?.url) {
           const url = obj.urlEndpoint.url;
           if (typeof url === 'string' && url.startsWith('http') && !url.includes('youtube.com/watch') && !url.includes('youtube.com/channel')) {
              explicitLinks.push(url);
           }
        }
        
        for (const key in obj) {
           extractLinks(obj[key]);
        }
      }
      extractLinks(ytData);
      
    } catch (e) {
      console.warn("Failed to parse ytInitialData", e);
    }
  }

  // Fallbacks
  if (!thumbnailUrl) {
    const ogImg = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i) ||
                   html.match(/<link\s+rel="image_src"\s+href="([^"]+)"/i);
    if (ogImg && ogImg[1]) {
      thumbnailUrl = ogImg[1];
    }
  }

  if (!bio) {
    const ogDesc = html.match(/<meta\s+name="description"\s+content="([^"]+)"/i) ||
                   html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i);
    if (ogDesc && ogDesc[1]) {
      bio = ogDesc[1];
    }
  }

  let extractedUrls = Array.from(new Set([...explicitLinks, ...extractExternalUrlsFromText(cleanHtml)]));

  return {
    bio,
    channelLinks: extractedUrls,
    thumbnailUrl,
    rawHtml: enableDebug ? cleanHtml : undefined,
    fetchLog: enableDebug ? `Fetched ${page.finalUrl} (${page.html.length} bytes)` : undefined
  };
}

/**
 * Runs the full 4-step Channel Inspection Engine with EARLY STOPPING and Detailed Audit Logs.
 */
export async function runChannelInspection(channelData: {
  enableDebug?: boolean;
  channelId: string;
  channelBio: string;
  channelLinks?: string[];
  pinnedComment?: string;
  videoDescriptions?: string[];
  socialLinks?: string[];
  youtubeUrl?: string;
  forceLiveFetch?: boolean;
}): Promise<InspectionResult> {
  const steps: InspectionStep[] = [];
  const now = new Date().toISOString();
  let extractedThumbnailUrl: string | undefined;

  let debugLog: any = channelData.enableDebug ? {
    rawAboutPageHtml: null,
    fetchLog: null,
    extractedUrls: [],
    redirectsFollowed: [],
    discordRegexAttempts: [],
    failureStep: null
  } : undefined;

  let bio = channelData.channelBio || '';
  let links = channelData.channelLinks || [];
  let videoDescs = channelData.videoDescriptions || [];

  // Live YouTube Fetch & Video Descriptions Enrichment (3 to 5 videos)
  if (channelData.youtubeUrl || channelData.channelId) {
    if (channelData.youtubeUrl && (channelData.forceLiveFetch || links.length === 0 || bio.length < 20)) {
      try {
        await incrementQuota(25); // Track YouTube live channel page scrape units
        const liveData = await fetchLiveYouTubeChannelData(channelData.youtubeUrl, channelData.enableDebug);
        if (liveData) {
          if (liveData.bio) bio = `${bio} ${liveData.bio}`.trim();
          if (liveData.channelLinks && liveData.channelLinks.length > 0) {
            links = Array.from(new Set([...links, ...liveData.channelLinks]));
          }
          if (liveData.thumbnailUrl) {
            extractedThumbnailUrl = liveData.thumbnailUrl;
          }
          if (debugLog) {
            debugLog.rawAboutPageHtml = liveData.rawHtml;
            debugLog.fetchLog = liveData.fetchLog;
          }
        }
      } catch (e) {
        console.warn('Live YouTube channel scrape failed:', e);
      }
    }

    // EXPAND SEARCH DEPTH: Fetch 3 to 5 recent video descriptions via API or Web Scraper
    if (videoDescs.length < 5) {
      if (channelData.channelId) {
        try {
          const apiDescs = await fetchRecentVideoDescriptionsFromAPI(channelData.channelId);
          if (apiDescs.length > 0) {
            videoDescs = Array.from(new Set([...videoDescs, ...apiDescs]));
          }
        } catch (e) {
          console.warn('API video descriptions fetch failed:', e);
        }
      }

      if (videoDescs.length < 5 && channelData.youtubeUrl) {
        try {
          const scrapedDescs = await scrapeRecentVideoDescriptions(channelData.youtubeUrl);
          if (scrapedDescs.length > 0) {
            videoDescs = Array.from(new Set([...videoDescs, ...scrapedDescs]));
          }
        } catch (e) {
          console.warn('Scraped video descriptions failed:', e);
        }
      }
    }
  }

  // --- HELPER FUNCTION FOR ADDING STEPS ---
  function addStep(
    stepName: InspectionStep['step'],
    title: string,
    status: InspectionStep['status'],
    detailsArr: string[],
    foundInvite: string | null = null,
    inviteLocation: string | undefined = undefined
  ) {
    steps.push({
      step: stepName,
      title,
      status,
      details: detailsArr.join('\n'),
      detectedInvite: foundInvite || undefined,
      inviteLocation: inviteLocation,
      timestamp: now
    });
    if (debugLog && status === 'NOT_FOUND' && !debugLog.failureStep) {
        debugLog.failureStep = stepName;
    }
  }

  // WE COLLECT ALL EXTERNAL URLS TO CRAWL LATER IN STEP 4 & 6
  let collectedExternalUrls: { url: string; contextMatches: boolean; source: string }[] = [];

  const checkContext = (text: string, url: string): boolean => {
    const contextKeywords = ['discord', 'community', 'join', 'trading floor', 'members', 'server'];
    const lowerText = text.toLowerCase();
    
    // Check if the URL is near these keywords (e.g., within 100 characters before or after)
    const urlIndex = lowerText.indexOf(url.toLowerCase());
    if (urlIndex === -1) return false;
    
    const start = Math.max(0, urlIndex - 100);
    const end = Math.min(lowerText.length, urlIndex + url.length + 100);
    const window = lowerText.substring(start, end);
    
    return contextKeywords.some(kw => window.includes(kw));
  };

  const addExternalUrls = (text: string, source: string) => {
    const urls = extractExternalUrlsFromText(text);
    if (debugLog) {
        debugLog.extractedUrls.push(...urls);
    }
    for (const url of urls) {
      collectedExternalUrls.push({ url, contextMatches: checkContext(text, url), source });
    }
  };

  for (const link of links) {
    if (link && typeof link === 'string') {
      if (debugLog) {
        debugLog.extractedUrls.push(link);
      }
      collectedExternalUrls.push({ url: link, contextMatches: false, source: 'CHANNEL_LINKS' });
    }
  }

  // STEP 1 — Channel Bio & About Section
  const step1Logs: string[] = [];
  step1Logs.push(`Inspecting channel bio text (${bio.length} characters) and embedded links.`);
  const directBioInvite = extractDiscordInvite(bio);
  
  if (debugLog) debugLog.discordRegexAttempts.push({ source: 'CHANNEL_ABOUT', textLength: bio.length, result: directBioInvite });

  addExternalUrls(bio, 'CHANNEL_ABOUT');

  if (directBioInvite) {
    step1Logs.push(`Direct Discord invite detected in Channel Bio: Invite Code "${directBioInvite}"`);
    addStep('BIO', 'Step 1 — Channel Bio & About Panel', 'FOUND', step1Logs, directBioInvite, 'CHANNEL_ABOUT');
    return { foundInvite: directBioInvite, foundLocation: 'CHANNEL_ABOUT', steps, extractedThumbnailUrl, debugLog, observedAboutBio:bio, observedChannelLinks:links };
  } else {
    step1Logs.push('No direct Discord invite found in channel bio.');
    addStep('BIO', 'Step 1 — Channel Bio & About Panel', 'NOT_FOUND', step1Logs);
  }

  // STEP 2 — Channel External Links
  // In the new pipeline, "Channel External Links" are checked for direct invites.
  // The actual crawling happens in step 5 & 6.
  const step2Logs: string[] = [];
  let foundInStep2 = false;
  if (links.length > 0) {
    step2Logs.push(`Scanning ${links.length} channel links.`);
    for (const link of links) {
      const inv = extractDiscordInvite(link);
      if (debugLog) debugLog.discordRegexAttempts.push({ source: 'CHANNEL_LINKS', url: link, result: inv });
      if (inv) {
        step2Logs.push(`Direct Discord invite detected in channel links: ${link}`);
        addStep('EXTERNAL_LINKS', 'Step 2 — Channel External Links', 'FOUND', step2Logs, inv, 'CHANNEL_LINKS');
        return { foundInvite: inv, foundLocation: 'CHANNEL_LINKS', steps, extractedThumbnailUrl, debugLog, observedAboutBio:bio, observedChannelLinks:links };
      }
    }
    step2Logs.push('No direct Discord invite found in channel links.');
    addStep('EXTERNAL_LINKS', 'Step 2 — Channel External Links', 'NOT_FOUND', step2Logs);
  } else {
    addStep('EXTERNAL_LINKS', 'Step 2 — Channel External Links', 'SKIPPED', ['No channel links found.']);
  }

  // STEP 3 — Latest 5 Video Descriptions
  const step3Logs: string[] = [];
  if (videoDescs.length > 0) {
    step3Logs.push(`Scanning ${videoDescs.length} recent video descriptions.`);
    for (let i = 0; i < Math.min(5, videoDescs.length); i++) {
      const d = videoDescs[i];
      const sourceName = `VIDEO_${i + 1}_DESCRIPTION`;
      addExternalUrls(d, sourceName);
      
      const inv = extractDiscordInvite(d);
      if (debugLog) debugLog.discordRegexAttempts.push({ source: sourceName, textLength: d.length, result: inv });
      if (inv) {
        step3Logs.push(`Discord invite detected in ${sourceName}`);
        addStep('VIDEO_DESCRIPTIONS', 'Step 3 — Latest Video Descriptions', 'FOUND', step3Logs, inv, sourceName);
        return { foundInvite: inv, foundLocation: sourceName, steps, extractedThumbnailUrl, debugLog, observedAboutBio:bio, observedChannelLinks:links };
      }
    }
    step3Logs.push('No direct Discord invite found in video descriptions.');
    addStep('VIDEO_DESCRIPTIONS', 'Step 3 — Latest Video Descriptions', 'NOT_FOUND', step3Logs);
  } else {
    addStep('VIDEO_DESCRIPTIONS', 'Step 3 — Latest Video Descriptions', 'SKIPPED', ['No video descriptions available.']);
  }

  // Deduplicate and filter external URLs
  const uniqueUrls = new Map<string, { url: string; contextMatches: boolean; source: string }>();
  for (const item of collectedExternalUrls) {
    // Avoid re-processing the same URL, but keep contextMatches=true if any occurrence had it
    const existing = uniqueUrls.get(item.url);
    if (existing) {
      if (item.contextMatches) existing.contextMatches = true;
    } else {
      uniqueUrls.set(item.url, item);
    }
  }

  const allCollectedUrls = Array.from(uniqueUrls.values());

  const socialDomains = ['twitter.com', 'x.com', 'instagram.com', 'tiktok.com'];
  const isSocial = (u: string) => socialDomains.some(d => u.includes(d));

  let websiteUrls = allCollectedUrls.filter(u => !isSocial(u.url));
  let socialBioUrls = allCollectedUrls.filter(u => isSocial(u.url));

  // Sort website URLs so contextMatches=true comes first
  websiteUrls.sort((a, b) => (a.contextMatches === b.contextMatches ? 0 : a.contextMatches ? -1 : 1));

  // STEP 4 — Linked Websites
  const step5Logs: string[] = [];
  if (websiteUrls.length > 0) {
    step5Logs.push(`Crawling ${websiteUrls.length} website URLs...`);
    for (const item of websiteUrls) {
      step5Logs.push(`[Crawling] ${item.url} (Context Match: ${item.contextMatches}, Source: ${item.source})`);
      
      const locName = item.url.includes('linktr.ee') ? 'LINKTREE' : 'CUSTOM_DOMAIN';

      const crawlRes = await crawlExternalLinks([item.url], [], debugLog);
      if (crawlRes.foundInvite) {
        step5Logs.push(`Discord invite found! ${crawlRes.details}`);
        addStep('CUSTOM_DOMAINS', 'Step 4 — Linked Websites', 'FOUND', step5Logs, crawlRes.foundInvite, locName);
        return { foundInvite: crawlRes.foundInvite, foundLocation: locName, steps, extractedThumbnailUrl, debugLog, observedAboutBio:bio, observedChannelLinks:links };
      }
    }
    step5Logs.push('No Discord invite found in linked websites.');
    addStep('CUSTOM_DOMAINS', 'Step 4 — Linked Websites', 'NOT_FOUND', step5Logs);
  } else {
    addStep('CUSTOM_DOMAINS', 'Step 4 — Linked Websites', 'SKIPPED', ['No website URLs to crawl.']);
  }

  // STEP 5 — Linked Social Profile Bios
  const step6Logs: string[] = [];
  if (socialBioUrls.length > 0) {
    step6Logs.push(`Crawling ${socialBioUrls.length} social profile URLs...`);
    for (const item of socialBioUrls) {
      step6Logs.push(`[Crawling] ${item.url} (Source: ${item.source})`);
      
      let locName = 'SOCIAL_BIO';
      if (item.url.includes('twitter.com') || item.url.includes('x.com')) locName = 'X_BIO';
      if (item.url.includes('instagram.com')) locName = 'INSTAGRAM_BIO';
      if (item.url.includes('tiktok.com')) locName = 'TIKTOK_BIO';

      const crawlRes = await crawlSocialBios([item.url], [], debugLog);
      if (crawlRes.foundInvite) {
        step6Logs.push(`Discord invite found! ${crawlRes.details}`);
        addStep('SOCIAL_BIO', 'Step 5 — Social Profile Bios', 'FOUND', step6Logs, crawlRes.foundInvite, locName);
        return { foundInvite: crawlRes.foundInvite, foundLocation: locName, steps, extractedThumbnailUrl, debugLog, observedAboutBio:bio, observedChannelLinks:links };
      }
    }
    step6Logs.push('No Discord invite found in social profile bios.');
    addStep('SOCIAL_BIO', 'Step 5 — Social Profile Bios', 'NOT_FOUND', step6Logs);
  } else {
    addStep('SOCIAL_BIO', 'Step 5 — Social Profile Bios', 'SKIPPED', ['No social profile URLs to crawl.']);
  }

  if (debugLog && !debugLog.failureStep) {
    debugLog.failureStep = 'ALL_EXHAUSTED';
  }

  return { foundInvite: null, steps, extractedThumbnailUrl, debugLog, observedAboutBio:bio, observedChannelLinks:links };
}
