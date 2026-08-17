from pathlib import Path

p=Path('server/inspector.ts')
s=p.read_text()
old="  function addStep(stepName:InspectionStep['step'],title:string,status:InspectionStep['status'],detailsArr:string[],foundInvite:string|null=null,inviteLocation:string|undefined=undefined){steps.push({step:stepName,title,status,details:detailsArr.join('\\n'),detectedInvite:foundInvite||undefined,inviteLocation,timestamp:now});if(debugLog&&status==='NOT_FOUND'&&!debugLog.failureStep)debugLog.failureStep=stepName;}"
new="  function addStep(stepName:InspectionStep['step'],title:string,status:InspectionStep['status'],detailsArr:string[],foundInvite:string|null=null,inviteLocation:string|undefined=undefined,foundInvites:string[]=[]){steps.push({step:stepName,title,status,details:detailsArr.join('\\n'),detectedInvite:foundInvite||undefined,detectedInvites:foundInvites.length?foundInvites:foundInvite?[foundInvite]:undefined,inviteLocation,timestamp:now});if(debugLog&&status==='NOT_FOUND'&&!debugLog.failureStep)debugLog.failureStep=stepName;}"
assert old in s
s=s.replace(old,new)
old2="  const step2Logs:string[]=[];const linkCandidates=links.flatMap(link=>extractDiscordCandidates(link,'CHANNEL_EXTERNAL_LINKS',link)).filter(c=>c.nativeInviteCode);retainCandidates(linkCandidates);if(links.length){step2Logs.push(`Scanning ${links.length} channel links.`);if(linkCandidates.length){step2Logs.push(`${linkCandidates.length} direct Discord candidate(s) retained from channel links.`);for(const candidate of linkCandidates)acquisitionOutcomes.push({requestedUrl:candidate.sourceUrl||candidate.rawLocator,surface:'CHANNEL_EXTERNAL_LINKS',required:true,outcome:'FOUND',retryable:false,detail:'Discord invite discovered in channel links',observedAt:now});addStep('EXTERNAL_LINKS','Step 2 — Channel External Links','FOUND',step2Logs,linkCandidates[0].nativeInviteCode||null,'CHANNEL_LINKS');}else{step2Logs.push('No direct Discord invite found in channel links.');addStep('EXTERNAL_LINKS','Step 2 — Channel External Links','NOT_FOUND',step2Logs);}}else addStep('EXTERNAL_LINKS','Step 2 — Channel External Links','SKIPPED',['No channel links found.']);"
new2="  const step2Logs:string[]=[];const rawLinkCandidates=links.flatMap(link=>extractDiscordCandidates(link,'CHANNEL_EXTERNAL_LINKS',link)).filter(c=>c.nativeInviteCode);const linkCandidates=mergeDiscordCandidates(rawLinkCandidates,{creatorName});retainCandidates(linkCandidates);if(links.length){step2Logs.push(`Scanning ${links.length} channel links.`);if(linkCandidates.length){const inviteCodes=linkCandidates.map(candidate=>candidate.nativeInviteCode!).filter(Boolean);step2Logs.push(`${linkCandidates.length} distinct direct Discord candidate(s) retained from channel links.`);step2Logs.push(`Retained invite code${inviteCodes.length===1?'':'s'}: ${inviteCodes.join(', ')}`);for(const candidate of linkCandidates)acquisitionOutcomes.push({requestedUrl:candidate.sourceUrl||candidate.rawLocator,surface:'CHANNEL_EXTERNAL_LINKS',required:true,outcome:'FOUND',retryable:false,detail:'Discord invite discovered in channel links',observedAt:now});addStep('EXTERNAL_LINKS','Step 2 — Channel External Links','FOUND',step2Logs,linkCandidates[0].nativeInviteCode||null,'CHANNEL_LINKS',inviteCodes);}else{step2Logs.push('No direct Discord invite found in channel links.');addStep('EXTERNAL_LINKS','Step 2 — Channel External Links','NOT_FOUND',step2Logs);}}else addStep('EXTERNAL_LINKS','Step 2 — Channel External Links','SKIPPED',['No channel links found.']);"
assert old2 in s
p.write_text(s.replace(old2,new2))

p=Path('src/types/index.ts'); s=p.read_text(); old="  detectedInvite?: string;\n  inviteLocation?: string;"; new="  detectedInvite?: string;\n  detectedInvites?: string[];\n  inviteLocation?: string;"; assert old in s; p.write_text(s.replace(old,new))

p=Path('src/components/InspectionModal.tsx'); s=p.read_text()
old='''                    {step.detectedInvite && (\n                      <div className="mt-2 font-mono text-[11px] bg-emerald-100/70 dark:bg-emerald-950/60 text-emerald-900 dark:text-emerald-200 p-2 rounded border border-emerald-200 dark:border-emerald-800 flex items-center justify-between">\n                        <div className="flex flex-col gap-0.5">\n                          <span>Invite Code: <strong>{step.detectedInvite}</strong></span>'''
new='''                    {(step.detectedInvites?.length || step.detectedInvite) && (\n                      <div className="mt-2 font-mono text-[11px] bg-emerald-100/70 dark:bg-emerald-950/60 text-emerald-900 dark:text-emerald-200 p-2 rounded border border-emerald-200 dark:border-emerald-800 flex items-center justify-between">\n                        <div className="flex flex-col gap-0.5">\n                          {(step.detectedInvites?.length ? step.detectedInvites : [step.detectedInvite!]).map((inviteCode, inviteIndex) => (\n                            <span key={`${inviteCode}-${inviteIndex}`}>Invite Code{(step.detectedInvites?.length || 1) > 1 ? ` ${inviteIndex + 1}` : ''}: <strong>{inviteCode}</strong></span>\n                          ))}'''
assert old in s
p.write_text(s.replace(old,new))

p=Path('server/ingestionPipeline.ts'); s=p.read_text()
old="""    // Once creator-level enrichment has run, absence of any independent trading
    // hypothesis is a routing stop, not a reason to buy more evidence. Preserve
    // the auditable channel/nominations internally, withhold it from further
    // enrichment, and do not call Discord. This is deliberately not a terminal
    // NON_TRADING label: later independent evidence or an operator recheck may
    // reopen it.
    if (currentStage > 0 && !independentHypothesis) {
      console.log(`[Unified Ingestion Pipeline - Gate 2] Withholding '${candidate.channelName}' after enrichment: no independent trading hypothesis; no further provider quota will be spent.`);"""
new="""    // Once creator-level enrichment has run, absence of any independent trading
    // hypothesis means machine evidence is exhausted without a safe terminal
    // classification. Do not silently present that state as COMPLETED: route it
    // to operator review so the channel can be explicitly approved or rejected,
    // and never run Discord inspection unless a trading decision is approved.
    if (currentStage > 0 && !independentHypothesis) {
      console.log(`[Unified Ingestion Pipeline - Gate 2] Routing '${candidate.channelName}' to human review after enrichment: no independent trading hypothesis and no safe terminal classifier decision.`);"""
assert old in s
s=s.replace(old,new)
start=s.index("if (currentStage > 0 && !independentHypothesis)")
end=s.index("const legacyAction",start)
block=s[start:end]
block=block.replace("scan_status:'COMPLETED'","scan_status:'NEEDS_REVIEW'")
block=block.replace("trading_status:'UNCERTAIN'","trading_status:'NEEDS_REVIEW'")
block=block.replace("withheldChannel.trading_status='UNCERTAIN'","withheldChannel.trading_status='NEEDS_REVIEW'")
block=block.replace("withheldChannel.scan_status='COMPLETED'","withheldChannel.scan_status='NEEDS_REVIEW'")
block=block.replace("classificationStatus:'UNCERTAIN',investigationState:'COMPLETED'","classificationStatus:'NEEDS_REVIEW',investigationState:'REVIEW_ELIGIBLE'")
block=block.replace("investigationState:'UNRESOLVED'","investigationState:'NEEDS_REVIEW'")
block=block.replace("tradingStatus:'UNCERTAIN',discordStatus:'UNCERTAIN',discordInvite:null,channelRecord:withheldChannel","tradingStatus:'NEEDS_REVIEW',discordStatus:'UNCERTAIN',discordInvite:null,channelRecord:withheldChannel")
s=s[:start]+block+s[end:]
p.write_text(s)

Path('server/inspectionRetentionReviewRouting.test.ts').write_text('''import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport {readFileSync} from 'node:fs';\nimport {runChannelInspection} from './inspector';\n\ntest('channel-link trail counts distinct Discord invites and exposes all retained codes',async()=>{\n  const result=await runChannelInspection({channelId:'c1',channelName:'Creator',channelBio:'bio',channelLinks:['https://discord.gg/same','https://discord.com/invite/same','https://discord.gg/other'],videoDescriptions:[]});\n  const step=result.steps.find(item=>item.step==='EXTERNAL_LINKS');\n  assert.equal(step?.status,'FOUND');\n  assert.match(step?.details||'',/2 distinct direct Discord candidate\\(s\\) retained/);\n  assert.deepEqual(step?.detectedInvites?.sort(),['other','same']);\n});\n\ntest('post-enrichment no-independent-hypothesis path is reviewable, never silently completed',()=>{\n  const source=readFileSync('server/ingestionPipeline.ts','utf8');\n  const start=source.indexOf("if (currentStage > 0 && !independentHypothesis)");\n  const end=source.indexOf('const legacyAction',start);\n  const block=source.slice(start,end);\n  assert.match(block,/trading_status='NEEDS_REVIEW'/);\n  assert.match(block,/scan_status='NEEDS_REVIEW'/);\n  assert.match(block,/tradingStatus:'NEEDS_REVIEW'/);\n});\n''')
