import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { getEnrichmentBacklogDiagnostics } from './enrichmentBacklogDiagnostics';

export type OperatorRole = 'operator' | 'admin';
export type RoutePolicy = 'public' | OperatorRole;

export interface OperatorPrincipal { actorId: string; actorHash: string; role: OperatorRole }
export interface AuditEvent { actorId?: string; actorHash?: string; role?: string; action: string; target: string; requestId: string; outcome: 'ALLOWED'|'DENIED'; metadata?: Record<string, unknown> }

declare global { namespace Express { interface Request { requestId: string; operator?: OperatorPrincipal; routePolicy?: RoutePolicy } } }

const ROUTES: Array<{ method: string; pattern: RegExp; policy: RoutePolicy; action: string }> = [
  { method:'GET', pattern:/^\/api\/health$/, policy:'public', action:'health.read' },
  { method:'GET', pattern:/^\/api\/browser-capability$/, policy:'operator', action:'runtime.browser-capability.read' },
  { method:'GET', pattern:/^\/api\/provider-metrics$/, policy:'operator', action:'providers.metrics.read' },
  { method:'GET', pattern:/^\/api\/discovery\/evaluation$/, policy:'operator', action:'discovery.evaluation.read' },
  { method:'POST', pattern:/^\/api\/discovery\/evaluation\/snapshots$/, policy:'operator', action:'discovery.evaluation.materialize' },
  { method:'GET', pattern:/^\/api\/diagnostics\/enrichment-backlog$/, policy:'operator', action:'diagnostics.enrichment-backlog.read' },
  { method:'GET', pattern:/^\/api\/validation-status$/, policy:'operator', action:'validation.read' },
  { method:'GET', pattern:/^\/api\/measurement\/replay$/, policy:'operator', action:'measurement.replay.read' },
  { method:'GET', pattern:/^\/api\/research-programs(?:\/price-action-trading(?:\/coverage)?)?$/, policy:'operator', action:'research.read' },
  { method:'GET', pattern:/^\/api\/evidence-graph$/, policy:'operator', action:'evidence.read' },
  { method:'POST', pattern:/^\/api\/acquisition-adapters\/playlist\/proposals$/, policy:'operator', action:'acquisition.propose' },
  { method:'POST', pattern:/^\/api\/acquisition-adapters\/playlist\/(control|actions\/[^/]+\/enqueue)$/, policy:'admin', action:'acquisition.control' },
  { method:'GET', pattern:/^\/api\/corpus(?:\/documents\/[^/]+)?$/, policy:'operator', action:'corpus.read' },
  { method:'GET', pattern:/^\/api\/candidate-assertions$/, policy:'operator', action:'candidate.assertions.read' },
  { method:'GET', pattern:/^\/api\/(discovery-nominations(?:\/[^/]+)?|channels\/[^/]+\/nominations|discovery-attribution\/(queries|paths)|candidate-admission\/baseline|admission\/(decisions|channels\/[^/]+|metrics)|evidence-(documents|assertions|coverage)|creator-focus\/shadow|investigations\/gap-plans|dashboard\/corpora|review-eligibility\/v2|release5\/rollout)$/, policy:'operator', action:'decision-plane.read' },
  { method:'POST', pattern:/^\/api\/(admission\/(replay|projection\/verify)|dashboard\/corpora\/verify|review-eligibility\/v2\/verify|release5\/rollout\/verify)$/, policy:'operator', action:'decision-plane.verify' },
  { method:'POST', pattern:/^\/api\/(admission\/projection\/repair|dashboard\/corpora\/repair|review-eligibility\/v2\/repair|release5\/rollout\/(activate|revoke|repair|control))$/, policy:'admin', action:'decision-plane.control' },
  { method:'GET', pattern:/^\/api\/operator-audit-events$/, policy:'admin', action:'audit.read' },
  { method:'POST', pattern:/^\/api\/(database\/backup|db\/stress-test|db\/clean-stress-tests)$/, policy:'admin', action:'administration.execute' },
  { method:'POST', pattern:/^\/api\/(queues\/pause|query-intelligence\/(pause|resume|scope|run-cycle)|regression\/run)$/, policy:'operator', action:'operation.execute' },
  { method:'POST', pattern:/^\/api\/research-programs\/price-action-trading\/(pause|resume|budget|kill-switch)$/, policy:'admin', action:'research.control' },
  { method:'POST', pattern:/^\/api\/research-programs\/price-action-trading\/lifecycle\/(pause|reactivate)$/, policy:'admin', action:'research.lifecycle.control' },
  { method:'POST', pattern:/^\/api\/(country-vocabularies|excluded-countries)$/, policy:'admin', action:'configuration.write' },
  { method:'DELETE', pattern:/^\/api\/excluded-countries\/[^/]+$/, policy:'admin', action:'configuration.write' },
  { method:'POST', pattern:/^\/api\/(reviews\/[^/]+\/(approve|reject|force-rescan)|relevance\/(verify|report)|search\/manual|search\/manual\/sessions\/[^/]+\/cancel|search\/automated|channels\/[^/]+\/recheck|query-intelligence\/(generate-candidates|queries\/[^/]+\/collection))$/, policy:'operator', action:'operation.execute' },
  { method:'GET', pattern:/^\/api\/(reviewer-credentials|review-reasons|reviews|reviews\/[^/]+|channels|channels-revision|channels\/diagnostics\/rejected|channels\/[^/]+|channels\/[^/]+\/report|dashboard\/summary|search\/manual\/sessions|search\/manual\/sessions\/[^/]+|execution-traces\/[^/]+|country-vocabularies|excluded-countries|queues\/status|database\/schema-info|reconciliation\/legacy-community-retries|query-intelligence\/(library|vocabulary|terminology|logs|status|scope)|regression\/(runs|latest))$/, policy:'operator', action:'administration.read' }
];

export const routePolicyInventory = ROUTES.map(({method, pattern, policy, action}) => ({method, pattern:pattern.source, policy, action}));

const clean = (v: string|undefined) => v?.trim() || undefined;
const equal = (a: string, b: string) => { const x=Buffer.from(a); const y=Buffer.from(b); return x.length===y.length && timingSafeEqual(x,y); };
const hashActor = (id:string) => createHash('sha256').update(id).digest('hex');

export function validateOperatorConfiguration(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== 'production') return;
  if (env.OPERATOR_AUTH_BYPASS === 'true') throw new Error('OPERATOR_AUTH_BYPASS is forbidden in production.');
  if (!clean(env.OPERATOR_API_TOKEN) && !clean(env.REVIEW_API_TOKEN)) throw new Error('OPERATOR_API_TOKEN (or transitional REVIEW_API_TOKEN) is required in production.');
  if (!clean(env.ADMIN_API_TOKEN)) throw new Error('ADMIN_API_TOKEN is required in production.');
}

export function authenticate(token: string|undefined, env: NodeJS.ProcessEnv = process.env): OperatorPrincipal|undefined {
  const supplied=clean(token); if (!supplied) return undefined;
  const admin=clean(env.ADMIN_API_TOKEN);
  if (admin && equal(supplied,admin)) { const actorId=clean(env.ADMIN_IDENTITY)||'admin'; return {actorId,actorHash:hashActor(actorId),role:'admin'}; }
  const operator=clean(env.OPERATOR_API_TOKEN);
  if (operator && equal(supplied,operator)) { const actorId=clean(env.OPERATOR_IDENTITY)||'operator'; return {actorId,actorHash:hashActor(actorId),role:'operator'}; }
  const legacy=clean(env.REVIEW_API_TOKEN);
  if (legacy && equal(supplied,legacy)) { const actorId=clean(env.DEFAULT_REVIEWER_IDENTITY)||'legacy-reviewer'; return {actorId,actorHash:hashActor(actorId),role:'operator'}; }
  return undefined;
}

function policyPath(req:Request): string { return `${req.baseUrl || ''}${req.path}`; }
function matchPolicy(req:Request) { return ROUTES.find(r => r.method===req.method && r.pattern.test(policyPath(req))); }
const bearer=(req:Request) => req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
const safeMetadata=(req:Request) => ({ method:req.method, queryKeys:Object.keys(req.query).sort() });

export function operatorAuthorization(writeAudit:(event:AuditEvent)=>Promise<void>, env:NodeJS.ProcessEnv=process.env):RequestHandler {
  return async (req:Request,res:Response,next:NextFunction) => {
    req.requestId=clean(req.header('x-request-id')) || randomUUID(); res.setHeader('X-Request-Id',req.requestId);
    const route=matchPolicy(req);
    if (!route) return res.status(404).json({error:'API route is not authorized by policy.',code:'ROUTE_POLICY_MISSING',requestId:req.requestId});
    req.routePolicy=route.policy;
    if (route.policy==='public') return next();
    if (env.NODE_ENV!=='production' && env.OPERATOR_AUTH_BYPASS==='true') {
      const actorId='local-development'; req.operator={actorId,actorHash:hashActor(actorId),role:'admin'};
      if (policyPath(req)==='/api/diagnostics/enrichment-backlog') {
        try { return res.json(await getEnrichmentBacklogDiagnostics(Number(req.query.limit??10))); }
        catch (error:any) { return res.status(500).json({error:error?.message||'Diagnostic query failed.',code:'ENRICHMENT_BACKLOG_DIAGNOSTIC_FAILED',requestId:req.requestId}); }
      }
      return next();
    }
    const principal=authenticate(bearer(req),env); req.operator=principal;
    const allowed=principal && (route.policy==='operator' || principal.role==='admin');
    if (!allowed) {
      await writeAudit({actorId:principal?.actorId,actorHash:principal?.actorHash,role:principal?.role,action:route.action,target:req.path,requestId:req.requestId,outcome:'DENIED',metadata:safeMetadata(req)}).catch(()=>undefined);
      const status=principal?403:401; return res.status(status).json({error:status===401?'Bearer authentication required.':'Administrator role required.',code:status===401?'UNAUTHENTICATED':'FORBIDDEN',requestId:req.requestId});
    }
    res.once('finish',()=>void writeAudit({actorId:principal.actorId,actorHash:principal.actorHash,role:principal.role,action:route.action,target:req.path,requestId:req.requestId,outcome:'ALLOWED',metadata:{...safeMetadata(req),statusCode:res.statusCode}}).catch(err=>console.error('[Operator Audit Write Failed]',{requestId:req.requestId,error:err instanceof Error?err.message:'unknown'})));
    if (policyPath(req)==='/api/diagnostics/enrichment-backlog') {
      try { return res.json(await getEnrichmentBacklogDiagnostics(Number(req.query.limit??10))); }
      catch (error:any) { return res.status(500).json({error:error?.message||'Diagnostic query failed.',code:'ENRICHMENT_BACKLOG_DIAGNOSTIC_FAILED',requestId:req.requestId}); }
    }
    next();
  };
}
