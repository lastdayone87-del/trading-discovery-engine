import fs from 'node:fs';

function replaceOnce(path, before, after) {
  const source = fs.readFileSync(path, 'utf8');
  if (source.includes(after)) return;
  if (!source.includes(before)) throw new Error(`Expected block not found in ${path}`);
  // Use a function replacement so JavaScript does not interpret `$&`, `$'`,
  // `$`` or `$n` sequences inside source-code text as replacement tokens.
  fs.writeFileSync(path, source.replace(before, () => after));
}

replaceOnce(
  'server/db.ts',
  "  const clauses=[serving.predicate]; const values:string[]=[];\n  const add=(column:string,value:string|undefined)=>{if(value&&value!=='ALL'){values.push(value);clauses.push(`${column}=$${values.length}`);}};",
  "  const clauses=[serving.predicate]; const values:string[]=[];\n  // Low-audience rows are retained for auditability, but the normal operator\n  // corpus should not be diluted by channels intentionally skipped for budget.\n  // An explicit scan-status filter opts into this corpus.\n  const explicitlyViewingLowAudience=args.scanStatus==='SKIPPED_LOW_AUDIENCE';\n  if(!args.includeRejected&&!args.diagnosticsOnly&&!explicitlyViewingLowAudience)clauses.push(`scan_status <> 'SKIPPED_LOW_AUDIENCE'`);\n  const add=(column:string,value:string|undefined)=>{if(value&&value!=='ALL'){values.push(value);clauses.push(`${column}=$${values.length}`);}};"
);

replaceOnce(
  'src/components/ResultsTable.tsx',
  "    const matchesScanStatus = selectedScanStatus === 'ALL' || c.scan_status === selectedScanStatus;\n    const matchesReviewView = !pendingReviewOnly || (c.scan_status === 'NEEDS_REVIEW' && !decidedChannelIds.has(c.channel_id));\n\n    return matchesSearch && matchesCountry && matchesCountryStatus && matchesTradingStatus && matchesDiscordStatus && matchesScanStatus && matchesReviewView;",
  "    const matchesScanStatus = selectedScanStatus === 'ALL' || c.scan_status === selectedScanStatus;\n    const matchesLowAudienceVisibility = selectedScanStatus === 'SKIPPED_LOW_AUDIENCE'\n      ? c.scan_status === 'SKIPPED_LOW_AUDIENCE'\n      : c.scan_status !== 'SKIPPED_LOW_AUDIENCE';\n    const matchesReviewView = !pendingReviewOnly || (c.scan_status === 'NEEDS_REVIEW' && !decidedChannelIds.has(c.channel_id));\n\n    return matchesSearch && matchesCountry && matchesCountryStatus && matchesTradingStatus && matchesDiscordStatus && matchesScanStatus && matchesLowAudienceVisibility && matchesReviewView;"
);

replaceOnce(
  'src/components/ResultsTable.tsx',
  "              <option value=\"SKIPPED_NON_TRADING\">SKIPPED (Non-Trading)</option>\n              <option value=\"PENDING\">PENDING</option>",
  "              <option value=\"SKIPPED_NON_TRADING\">SKIPPED (Non-Trading)</option>\n              <option value=\"SKIPPED_LOW_AUDIENCE\">LOW AUDIENCE (Skipped &lt;30)</option>\n              <option value=\"PENDING\">PENDING</option>"
);

console.log('Applied low-audience dashboard visibility patch.');
