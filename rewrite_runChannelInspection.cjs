const fs = require('fs');

let code = fs.readFileSync('server/inspector.ts', 'utf-8');

const startMarker = 'export async function runChannelInspection(channelData: {';
const startIndex = code.indexOf(startMarker);
if (startIndex === -1) {
    console.error("Could not find start marker");
    process.exit(1);
}

const beforeRunChannelInspection = code.slice(0, startIndex);

const newRunChannelInspection = `
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
          if (liveData.bio) bio = \`\${bio} \${liveData.bio}\`.trim();
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
      details: detailsArr.join('\\n'),
      detectedInvite: foundInvite || undefined,
      inviteLocation: inviteLocation,
      timestamp: now
    });
    if (debugLog && status === 'NOT_FOUND' && !debugLog.failureStep) {
        debugLog.failureStep = stepName;
    }
  }

  // WE COLLECT ALL EXTERNAL URLS TO CRAWL LATER IN STEP 5 & 6
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
  step1Logs.push(\`Inspecting channel bio text (\${bio.length} characters) and embedded links.\`);
  const directBioInvite = extractDiscordInvite(bio);
  
  if (debugLog) debugLog.discordRegexAttempts.push({ source: 'CHANNEL_ABOUT', textLength: bio.length, result: directBioInvite });

  addExternalUrls(bio, 'CHANNEL_ABOUT');

  if (directBioInvite) {
    step1Logs.push(\`Direct Discord invite detected in Channel Bio: Invite Code "\${directBioInvite}"\`);
    addStep('BIO', 'Step 1 — Channel Bio & About Panel', 'FOUND', step1Logs, directBioInvite, 'CHANNEL_ABOUT');
    return { foundInvite: directBioInvite, foundLocation: 'CHANNEL_ABOUT', steps, extractedThumbnailUrl, debugLog };
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
    step2Logs.push(\`Scanning \${links.length} channel links.\`);
    for (const link of links) {
      const inv = extractDiscordInvite(link);
      if (debugLog) debugLog.discordRegexAttempts.push({ source: 'CHANNEL_LINKS', url: link, result: inv });
      if (inv) {
        step2Logs.push(\`Direct Discord invite detected in channel links: \${link}\`);
        addStep('EXTERNAL_LINKS', 'Step 2 — Channel External Links', 'FOUND', step2Logs, inv, 'CHANNEL_LINKS');
        return { foundInvite: inv, foundLocation: 'CHANNEL_LINKS', steps, extractedThumbnailUrl, debugLog };
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
    step3Logs.push(\`Scanning \${videoDescs.length} recent video descriptions.\`);
    for (let i = 0; i < Math.min(5, videoDescs.length); i++) {
      const d = videoDescs[i];
      const sourceName = \`VIDEO_\${i + 1}_DESCRIPTION\`;
      addExternalUrls(d, sourceName);
      
      const inv = extractDiscordInvite(d);
      if (debugLog) debugLog.discordRegexAttempts.push({ source: sourceName, textLength: d.length, result: inv });
      if (inv) {
        step3Logs.push(\`Discord invite detected in \${sourceName}\`);
        addStep('VIDEO_DESCRIPTIONS', 'Step 3 — Latest Video Descriptions', 'FOUND', step3Logs, inv, sourceName);
        return { foundInvite: inv, foundLocation: sourceName, steps, extractedThumbnailUrl, debugLog };
      }
    }
    step3Logs.push('No direct Discord invite found in video descriptions.');
    addStep('VIDEO_DESCRIPTIONS', 'Step 3 — Latest Video Descriptions', 'NOT_FOUND', step3Logs);
  } else {
    addStep('VIDEO_DESCRIPTIONS', 'Step 3 — Latest Video Descriptions', 'SKIPPED', ['No video descriptions available.']);
  }

  // STEP 4 — Owner-pinned comments
  const step4Logs: string[] = [];
  if (channelData.pinnedComment) {
    step4Logs.push(\`Inspecting pinned comment.\`);
    addExternalUrls(channelData.pinnedComment, 'PINNED_COMMENT');
    const inv = extractDiscordInvite(channelData.pinnedComment);
    if (debugLog) debugLog.discordRegexAttempts.push({ source: 'PINNED_COMMENT', textLength: channelData.pinnedComment.length, result: inv });
    if (inv) {
      step4Logs.push(\`Discord invite detected in pinned comment.\`);
      addStep('PINNED_COMMENT', 'Step 4 — Owner-Pinned Comments', 'FOUND', step4Logs, inv, 'PINNED_COMMENT');
      return { foundInvite: inv, foundLocation: 'PINNED_COMMENT', steps, extractedThumbnailUrl, debugLog };
    }
    step4Logs.push('No direct Discord invite found in pinned comment.');
    addStep('PINNED_COMMENT', 'Step 4 — Owner-Pinned Comments', 'NOT_FOUND', step4Logs);
  } else {
    addStep('PINNED_COMMENT', 'Step 4 — Owner-Pinned Comments', 'SKIPPED', ['No pinned comment available.']);
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

  // STEP 5 — Linked Websites
  const step5Logs: string[] = [];
  if (websiteUrls.length > 0) {
    step5Logs.push(\`Crawling \${websiteUrls.length} website URLs...\`);
    for (const item of websiteUrls) {
      step5Logs.push(\`[Crawling] \${item.url} (Context Match: \${item.contextMatches}, Source: \${item.source})\`);
      
      const locName = item.url.includes('linktr.ee') ? 'LINKTREE' : 'CUSTOM_DOMAIN';

      const crawlRes = await crawlExternalLinks([item.url], [], debugLog);
      if (crawlRes.foundInvite) {
        step5Logs.push(\`Discord invite found! \${crawlRes.details}\`);
        addStep('CUSTOM_DOMAINS', 'Step 5 — Linked Websites', 'FOUND', step5Logs, crawlRes.foundInvite, locName);
        return { foundInvite: crawlRes.foundInvite, foundLocation: locName, steps, extractedThumbnailUrl, debugLog };
      }
    }
    step5Logs.push('No Discord invite found in linked websites.');
    addStep('CUSTOM_DOMAINS', 'Step 5 — Linked Websites', 'NOT_FOUND', step5Logs);
  } else {
    addStep('CUSTOM_DOMAINS', 'Step 5 — Linked Websites', 'SKIPPED', ['No website URLs to crawl.']);
  }

  // STEP 6 — Linked Social Profile Bios
  const step6Logs: string[] = [];
  if (socialBioUrls.length > 0) {
    step6Logs.push(\`Crawling \${socialBioUrls.length} social profile URLs...\`);
    for (const item of socialBioUrls) {
      step6Logs.push(\`[Crawling] \${item.url} (Source: \${item.source})\`);
      
      let locName = 'SOCIAL_BIO';
      if (item.url.includes('twitter.com') || item.url.includes('x.com')) locName = 'X_BIO';
      if (item.url.includes('instagram.com')) locName = 'INSTAGRAM_BIO';
      if (item.url.includes('tiktok.com')) locName = 'TIKTOK_BIO';

      const crawlRes = await crawlSocialBios([item.url], [], debugLog);
      if (crawlRes.foundInvite) {
        step6Logs.push(\`Discord invite found! \${crawlRes.details}\`);
        addStep('SOCIAL_BIO', 'Step 6 — Social Profile Bios', 'FOUND', step6Logs, crawlRes.foundInvite, locName);
        return { foundInvite: crawlRes.foundInvite, foundLocation: locName, steps, extractedThumbnailUrl, debugLog };
      }
    }
    step6Logs.push('No Discord invite found in social profile bios.');
    addStep('SOCIAL_BIO', 'Step 6 — Social Profile Bios', 'NOT_FOUND', step6Logs);
  } else {
    addStep('SOCIAL_BIO', 'Step 6 — Social Profile Bios', 'SKIPPED', ['No social profile URLs to crawl.']);
  }

  if (debugLog && !debugLog.failureStep) {
    debugLog.failureStep = 'ALL_EXHAUSTED';
  }

  return { foundInvite: null, steps, extractedThumbnailUrl, debugLog };
}
`;

const newCode = beforeRunChannelInspection + newRunChannelInspection;
fs.writeFileSync('server/inspector.ts', newCode, 'utf-8');
console.log("Updated server/inspector.ts");
