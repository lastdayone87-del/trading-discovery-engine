import fs from 'node:fs';

const authPath='server/operatorAuth.ts';
let auth=fs.readFileSync(authPath,'utf8');

const importNeedle="import type { NextFunction, Request, RequestHandler, Response } from 'express';\n";
const importLine="import { getEnrichmentBacklogDiagnostics } from './enrichmentBacklogDiagnostics';\n";
if(!auth.includes(importLine)){
  if(!auth.includes(importNeedle)) throw new Error('operatorAuth import anchor missing');
  auth=auth.replace(importNeedle,importNeedle+importLine);
}

const policyNeedle="  { method:'GET', pattern:/^\\/api\\/provider-metrics$/, policy:'operator', action:'providers.metrics.read' },\n";
const policyLine="  { method:'GET', pattern:/^\\/api\\/diagnostics\\/enrichment-backlog$/, policy:'operator', action:'diagnostics.enrichment-backlog.read' },\n";
if(!auth.includes(policyLine)){
  if(!auth.includes(policyNeedle)) throw new Error('operatorAuth policy anchor missing');
  auth=auth.replace(policyNeedle,policyNeedle+policyLine);
}

const bypassNeedle="      const actorId='local-development'; req.operator={actorId,actorHash:hashActor(actorId),role:'admin'}; return next();\n";
const bypassReplacement="      const actorId='local-development'; req.operator={actorId,actorHash:hashActor(actorId),role:'admin'};\n      if (policyPath(req)==='/api/diagnostics/enrichment-backlog') {\n        try { return res.json(await getEnrichmentBacklogDiagnostics(Number(req.query.limit??10))); }\n        catch (error:any) { return res.status(500).json({error:error?.message||'Diagnostic query failed.',code:'ENRICHMENT_BACKLOG_DIAGNOSTIC_FAILED',requestId:req.requestId}); }\n      }\n      return next();\n";
if(auth.includes(bypassNeedle)) auth=auth.replace(bypassNeedle,bypassReplacement);

const finalNeedle="    res.once('finish',()=>void writeAudit({actorId:principal.actorId,actorHash:principal.actorHash,role:principal.role,action:route.action,target:req.path,requestId:req.requestId,outcome:'ALLOWED',metadata:{...safeMetadata(req),statusCode:res.statusCode}}).catch(err=>console.error('[Operator Audit Write Failed]',{requestId:req.requestId,error:err instanceof Error?err.message:'unknown'})));\n    next();\n";
const finalReplacement="    res.once('finish',()=>void writeAudit({actorId:principal.actorId,actorHash:principal.actorHash,role:principal.role,action:route.action,target:req.path,requestId:req.requestId,outcome:'ALLOWED',metadata:{...safeMetadata(req),statusCode:res.statusCode}}).catch(err=>console.error('[Operator Audit Write Failed]',{requestId:req.requestId,error:err instanceof Error?err.message:'unknown'})));\n    if (policyPath(req)==='/api/diagnostics/enrichment-backlog') {\n      try { return res.json(await getEnrichmentBacklogDiagnostics(Number(req.query.limit??10))); }\n      catch (error:any) { return res.status(500).json({error:error?.message||'Diagnostic query failed.',code:'ENRICHMENT_BACKLOG_DIAGNOSTIC_FAILED',requestId:req.requestId}); }\n    }\n    next();\n";
if(!auth.includes("policyPath(req)==='/api/diagnostics/enrichment-backlog'")){
  if(!auth.includes(finalNeedle)) throw new Error('operatorAuth final anchor missing');
  auth=auth.replace(finalNeedle,finalReplacement);
}else if(auth.includes(finalNeedle)){
  auth=auth.replace(finalNeedle,finalReplacement);
}
fs.writeFileSync(authPath,auth);

const test=`import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { diagnoseEnrichmentBacklog } from './enrichmentBacklogDiagnosis';\nimport { ENRICHMENT_DIAGNOSTIC_QUERIES } from './enrichmentBacklogDiagnostics';\nimport { routePolicyInventory } from './operatorAuth';\n\ntest('diagnostic SQL is SELECT-only',()=>{\n  for(const sql of Object.values(ENRICHMENT_DIAGNOSTIC_QUERIES)){\n    const normalized=sql.trim().toUpperCase();\n    assert.ok(normalized.startsWith('SELECT')||normalized.startsWith('WITH'));\n    assert.equal(/\\b(UPDATE|INSERT|DELETE|ALTER|DROP|TRUNCATE|CREATE)\\b/.test(normalized),false);\n  }\n});\n\ntest('diagnostic route is operator authenticated',()=>{\n  const route=routePolicyInventory.find(r=>r.action==='diagnostics.enrichment-backlog.read');\n  assert.ok(route);\n  assert.equal(route?.method,'GET');\n  assert.equal(route?.policy,'operator');\n});\n\ntest('persisted states classify runnable, backoff, lease, and operational retry',()=>{\n  const now=Date.parse('2026-08-13T12:00:00Z');\n  assert.equal(diagnoseEnrichmentBacklog({status:'PENDING',runAfter:'2026-08-13T11:59:00Z',runnable:true},now),'RUNNABLE_WAITING');\n  assert.equal(diagnoseEnrichmentBacklog({status:'PENDING',runAfter:'2026-08-13T12:30:00Z',runnable:false},now),'PROVIDER_BACKOFF');\n  assert.equal(diagnoseEnrichmentBacklog({status:'RUNNING',runAfter:'2026-08-13T11:00:00Z',runnable:false,lockedBy:'worker',lockedAt:'2026-08-13T11:55:00Z'},now),'ACTIVE_LEASE');\n  assert.equal(diagnoseEnrichmentBacklog({status:'PENDING',runAfter:'2026-08-13T11:59:00Z',runnable:true,stepState:'RETRYING',failureClass:'PROVIDER_TIMEOUT'},now),'OPERATIONAL_RETRY');\n});\n`;
fs.writeFileSync('server/enrichmentBacklogDiagnostics.test.ts',test);

for(const p of ['scripts/applyEnrichmentBacklogDiagnostic.mjs','.github/workflows/apply-enrichment-backlog-diagnostic.yml']){
  if(fs.existsSync(p)) fs.rmSync(p);
}
