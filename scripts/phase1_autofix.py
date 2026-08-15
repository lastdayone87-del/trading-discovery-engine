from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    s = p.read_text()
    count = s.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one target, got {count}")
    p.write_text(s.replace(old, new, 1))


# Production ingestion evaluates authoritative review eligibility synchronously.
p = Path("server/ingestionPipeline.ts")
s = p.read_text()
old_import = "import { recordReviewEligibilityShadow } from './reviewEligibility/store';\n"
new_import = old_import + "import { evaluateReviewEligibilityV2 } from './reviewEligibility/policy';\n"
if "import { evaluateReviewEligibilityV2 } from './reviewEligibility/policy';" not in s:
    if s.count(old_import) != 1:
        raise SystemExit("ingestion import mismatch")
    s = s.replace(old_import, new_import, 1)

old_block = """    const appliedAction=evidencePlan?.appliedAction||legacyAction,shouldReview=appliedAction==='HUMAN_REVIEW';
    const lifecycle = resolveUncertainLifecycle(shouldReview);
    const finalUncertainStatus = lifecycle.tradingStatus;
    const finalScanStatus = lifecycle.scanStatus;
    const corroboration=productionClassification.decision.stagedClassification?.stages.find(stage=>stage.stage==='CORROBORATION');
    void recordReviewEligibilityShadow({channelId:candidate.channelId,classificationDiagnosticId,classificationStatus:'UNCERTAIN',investigationState:shouldReview?'UNRESOLVED':'ACTIVE',plausibleTradingHypothesis:independentHypothesis,evidenceSufficient:productionClassification.decision.evidenceCollection.sufficiency==='SUFFICIENT',independentEvidence:corroboration?.disposition==='PASS',countryAllowed:true,operationalFailure:false,providerDegraded:productionClassification.decision.evidenceCollection.degraded,unsupportedLanguage:productionClassification.decision.evidenceCollection.providers.some(provider=>provider.outcome==='ABSTAINED_UNSUPPORTED_LANGUAGE'),terminalDecision:false}).catch(error=>console.warn(`[ReviewEligibility] shadow write failed for ${candidate.channelId}:`,error instanceof Error?error.message:error));
"""
new_block = """    const appliedAction=evidencePlan?.appliedAction||legacyAction,shouldReview=appliedAction==='HUMAN_REVIEW';
    const corroboration=productionClassification.decision.stagedClassification?.stages.find(stage=>stage.stage==='CORROBORATION');
    const reviewEligibilityInput={classificationStatus:'UNCERTAIN',investigationState:shouldReview?'UNRESOLVED':'ACTIVE',plausibleTradingHypothesis:independentHypothesis,evidenceSufficient:productionClassification.decision.evidenceCollection.sufficiency==='SUFFICIENT',independentEvidence:corroboration?.disposition==='PASS',countryAllowed:true,operationalFailure:false,providerDegraded:productionClassification.decision.evidenceCollection.degraded,unsupportedLanguage:productionClassification.decision.evidenceCollection.providers.some(provider=>provider.outcome==='ABSTAINED_UNSUPPORTED_LANGUAGE'),terminalDecision:false};
    const reviewEligibility=evaluateReviewEligibilityV2(reviewEligibilityInput);
    const lifecycle = resolveUncertainLifecycle(shouldReview,reviewEligibility);
    const finalUncertainStatus = lifecycle.tradingStatus==='NEEDS_REVIEW'?'UNCERTAIN':lifecycle.tradingStatus;
    const finalScanStatus = lifecycle.scanStatus==='NEEDS_REVIEW'?'COMPLETED':lifecycle.scanStatus;
"""
if old_block not in s:
    raise SystemExit("ingestion lifecycle mismatch")
s = s.replace(old_block, new_block, 1)

old_after = """    await upsertChannel(uncertainChannel);

    if (lifecycle.shouldEnqueue) {
"""
new_after = """    await upsertChannel(uncertainChannel);
    await recordReviewEligibilityShadow({channelId:candidate.channelId,classificationDiagnosticId,...reviewEligibilityInput})
      .catch(error=>console.warn(`[ReviewEligibility] authoritative write failed for ${candidate.channelId}:`,error instanceof Error?error.message:error));
    const authoritativeChannel=(await getChannelById(candidate.channelId))||uncertainChannel;

    if (lifecycle.shouldEnqueue) {
"""
if old_after not in s:
    raise SystemExit("ingestion persistence mismatch")
s = s.replace(old_after, new_after, 1)

old_return = """      tradingStatus: finalUncertainStatus,
      discordStatus: 'UNCERTAIN',
      discordInvite: null,
      channelRecord: uncertainChannel
"""
new_return = """      tradingStatus: authoritativeChannel.trading_status || finalUncertainStatus,
      discordStatus: 'UNCERTAIN',
      discordInvite: null,
      channelRecord: authoritativeChannel
"""
if old_return not in s:
    raise SystemExit("ingestion return mismatch")
p.write_text(s.replace(old_return, new_return, 1))

# Terminal enrichment exhaustion stays machine-owned.
replace_once(
    "server/queueManager.ts",
    "        channel.scan_status = 'NEEDS_REVIEW';\n        channel.trading_status = 'NEEDS_REVIEW';",
    "        channel.scan_status = 'FAILED';\n        channel.trading_status = 'UNCERTAIN';",
)

# Investigation projections distinguish operational blockage from human review.
replace_once(
    "server/investigationWorkflow.ts",
    "if(event.type==='FAIL'&&event.terminal)return {...projection,state:'NEEDS_REVIEW',version:projection.version+1,hasPendingSuccessor:false};",
    "if(event.type==='FAIL'&&event.terminal)return {...projection,state:'OPERATIONALLY_BLOCKED',version:projection.version+1,hasPendingSuccessor:false};",
)
replace_once(
    "server/investigationWorkflow.ts",
    "if(input.terminal)await client.query(`UPDATE investigations SET state='NEEDS_REVIEW',version=version+1,completed_at=now(),updated_at=now() WHERE id=$1 AND state='ACTIVE'`,[input.investigationId]);",
    "if(input.terminal)await client.query(`UPDATE investigations SET state='OPERATIONALLY_BLOCKED',version=version+1,completed_at=now(),updated_at=now() WHERE id=$1 AND state='ACTIVE'`,[input.investigationId]);",
)
replace_once(
    "server/investigationWorkflow.ts",
    "event.resultingStatus==='NEEDS_REVIEW'?'NEEDS_REVIEW':projection.hasPendingSuccessor?'ACTIVE':'NEEDS_REVIEW'",
    "event.resultingStatus==='NEEDS_REVIEW'?'NEEDS_REVIEW':projection.hasPendingSuccessor?'ACTIVE':'UNRESOLVED'",
)
replace_once(
    "server/investigationWorkflow.ts",
    "input.resultingStatus==='NEEDS_REVIEW'?'NEEDS_REVIEW':successor.rowCount?'ACTIVE':'NEEDS_REVIEW'",
    "input.resultingStatus==='NEEDS_REVIEW'?'NEEDS_REVIEW':successor.rowCount?'ACTIVE':'UNRESOLVED'",
)
