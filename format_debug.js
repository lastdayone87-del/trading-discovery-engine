const fs = require('fs');
const data = JSON.parse(fs.readFileSync('debug_output.json', 'utf8'));

if (!data.debugLog) {
  console.log("No debugLog found.");
} else {
  const log = data.debugLog;
  console.log("===== DEBUG LOG =====");
  console.log("Failure Step:", log.failureStep);
  console.log("Extracted URLs:", log.extractedUrls);
  console.log("Redirects Followed:", log.redirectsFollowed);
  
  if (log.rawAboutPageHtml) {
    console.log("Raw HTML Length:", log.rawAboutPageHtml.length);
    if (log.rawAboutPageHtml.includes('discord.gg/DcnFmYR3dY')) {
       console.log("Discord link IS in the raw HTML.");
    } else {
       console.log("Discord link IS NOT in the raw HTML.");
    }
  } else {
    console.log("No raw HTML captured.");
  }
}
