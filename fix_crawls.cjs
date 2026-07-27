const fs = require('fs');
let code = fs.readFileSync('server/inspector.ts', 'utf-8');

code = code.replace(
  'export async function crawlExternalLinks(\n  links: string[],\n  logDetails: string[] = []\n): Promise<{ foundInvite: string | null;  foundLocation?: string; details: string }> {',
  'export async function crawlExternalLinks(\n  links: string[],\n  logDetails: string[] = [],\n  debugLog?: any\n): Promise<{ foundInvite: string | null;  foundLocation?: string; details: string }> {'
);

code = code.replace(
  'const directInvite = extractDiscordInvite(url);',
  'const directInvite = extractDiscordInvite(url);\n    if (debugLog) debugLog.discordRegexAttempts.push({ source: \'crawlExternalLinks_direct\', url, result: directInvite });'
);

code = code.replace(
  'const page = await fetchWithTimeout(url, 0);',
  'const page = await fetchWithTimeout(url, 0);\n    if (debugLog && page) {\n      debugLog.redirectsFollowed.push({ from: url, to: page.finalUrl });\n    }'
);

code = code.replace(
  'const finalUrlInvite = extractDiscordInvite(page.finalUrl);',
  'const finalUrlInvite = extractDiscordInvite(page.finalUrl);\n    if (debugLog) debugLog.discordRegexAttempts.push({ source: \'crawlExternalLinks_finalUrl\', url: page.finalUrl, result: finalUrlInvite });'
);

code = code.replace(
  'const inviteFromHtml = extractDiscordInvite(page.html);',
  'const inviteFromHtml = extractDiscordInvite(page.html);\n    if (debugLog) debugLog.discordRegexAttempts.push({ source: \'crawlExternalLinks_html\', url: page.finalUrl, textLength: page.html.length, result: inviteFromHtml });'
);

code = code.replace(
  'const inv = extractDiscordInvite(href);',
  'const inv = extractDiscordInvite(href);\n      if (debugLog) debugLog.discordRegexAttempts.push({ source: \'crawlExternalLinks_anchorHref\', url: href, result: inv });'
);

code = code.replace(
  'export async function crawlSocialBios(\n  socialUrls: string[],\n  logDetails: string[] = []\n): Promise<{ foundInvite: string | null; details: string }> {',
  'export async function crawlSocialBios(\n  socialUrls: string[],\n  logDetails: string[] = [],\n  debugLog?: any\n): Promise<{ foundInvite: string | null; details: string }> {'
);

// social bios replacements
code = code.replace(
  'const directInv = extractDiscordInvite(url);',
  'const directInv = extractDiscordInvite(url);\n    if (debugLog) debugLog.discordRegexAttempts.push({ source: \'crawlSocialBios_direct\', url, result: directInv });'
);

code = code.replace(
  'const page = await fetchWithTimeout(url, 0);\n    if (page) {\n      const invFromHtml = extractDiscordInvite(page.html);',
  'const page = await fetchWithTimeout(url, 0);\n    if (page) {\n      if (debugLog) debugLog.redirectsFollowed.push({ from: url, to: page.finalUrl });\n      const invFromHtml = extractDiscordInvite(page.html);\n      if (debugLog) debugLog.discordRegexAttempts.push({ source: \'crawlSocialBios_html\', url: page.finalUrl, textLength: page.html.length, result: invFromHtml });'
);

code = code.replace(
  'const crawlRes = await crawlExternalLinks(extInBio, logDetails);',
  'const crawlRes = await crawlExternalLinks(extInBio, logDetails, debugLog);'
);

// Level 2
code = code.replace(
  'const subPage = await fetchWithTimeout(subUrl, 1);\n      if (subPage) {\n        const subFinalInv = extractDiscordInvite(subPage.finalUrl);',
  'const subPage = await fetchWithTimeout(subUrl, 1);\n      if (subPage) {\n        if (debugLog) debugLog.redirectsFollowed.push({ from: subUrl, to: subPage.finalUrl });\n        const subFinalInv = extractDiscordInvite(subPage.finalUrl);\n        if (debugLog) debugLog.discordRegexAttempts.push({ source: \'crawlExternalLinks_subPage_finalUrl\', url: subPage.finalUrl, result: subFinalInv });'
);

code = code.replace(
  'const subHtmlInv = extractDiscordInvite(subPage.html);',
  'const subHtmlInv = extractDiscordInvite(subPage.html);\n        if (debugLog) debugLog.discordRegexAttempts.push({ source: \'crawlExternalLinks_subPage_html\', url: subPage.finalUrl, textLength: subPage.html.length, result: subHtmlInv });'
);


fs.writeFileSync('server/inspector.ts', code, 'utf-8');
console.log("Updated server/inspector.ts");
