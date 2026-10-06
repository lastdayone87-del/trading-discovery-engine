import assert from 'node:assert/strict'; import test from 'node:test';
import { authenticate, operatorAuthorization, routePolicyInventory, validateOperatorConfiguration } from './operatorAuth';

test('Phase 12 diagnostics and materialization routes are governed',()=>{
 assert.ok(routePolicyInventory.some(r=>r.method==='GET'&&r.pattern.includes('discovery\\/evaluation')));
 assert.ok(routePolicyInventory.some(r=>r.method==='POST'&&r.pattern.includes('evaluation\\/snapshots')));
});

test('maps admin, operator, and transitional reviewer credentials without exposing tokens',()=>{
 const env={ADMIN_API_TOKEN:'a',ADMIN_IDENTITY:'root',OPERATOR_API_TOKEN:'o',OPERATOR_IDENTITY:'ops',REVIEW_API_TOKEN:'r',DEFAULT_REVIEWER_IDENTITY:'review'};
 assert.deepEqual(authenticate('a',env),{actorId:'root',actorHash:authenticate('a',env)?.actorHash,role:'admin'});
 assert.equal(authenticate('o',env)?.role,'operator'); assert.equal(authenticate('r',env)?.actorId,'review'); assert.equal(authenticate('bad',env),undefined);
 assert.ok(!JSON.stringify(authenticate('a',env)).includes('"a"'));
});
test('production fails closed and can never enable the development bypass',()=>{
 assert.throws(()=>validateOperatorConfiguration({NODE_ENV:'production'}),/required/);
 assert.throws(()=>validateOperatorConfiguration({NODE_ENV:'production',OPERATOR_AUTH_BYPASS:'true',OPERATOR_API_TOKEN:'o',ADMIN_API_TOKEN:'a'}),/forbidden/);
 assert.doesNotThrow(()=>validateOperatorConfiguration({NODE_ENV:'production',OPERATOR_API_TOKEN:'o',ADMIN_API_TOKEN:'a'}));
});
test('route inventory is explicit and public surface contains only health',()=>{
 assert.deepEqual(routePolicyInventory.filter(x=>x.policy==='public').map(x=>x.pattern),['^\\/api\\/health$']);
 const browserRoute=routePolicyInventory.find(x=>x.method==='GET'&&x.pattern==='^\\/api\\/browser-capability$');
 assert.deepEqual(browserRoute?.policy,'operator');
});
test('governed review reason catalog is authorized for authenticated operators',()=>{
 const matchingRoutes=routePolicyInventory.filter(item=>item.method==='GET'&&new RegExp(item.pattern).test('/api/review-reasons'));
 assert.equal(matchingRoutes.length,1,'/api/review-reasons must resolve to exactly one explicit route policy');
 const route=matchingRoutes[0];
 assert.equal(route.policy,'operator');
 assert.equal(route.action,'administration.read');
});

test('crawler reliability telemetry is an explicit operator-only read route',()=>{
 const route=routePolicyInventory.find(x=>x.method==='GET'&&x.pattern==='^\\/api\\/diagnostics\\/crawler-reliability$');
 assert.deepEqual(route?.policy,'operator');
 assert.deepEqual(route?.action,'diagnostics.crawler-reliability.read');
});

test('frontier benchmark surfaces are explicit operator-only read routes (never public)',()=>{
 for (const path of ['/api/discovery/frontier/diagnostics','/api/discovery/frontier/comparison']) {
  const matching=routePolicyInventory.filter(item=>item.method==='GET'&&new RegExp(item.pattern).test(path));
  assert.equal(matching.length,1,`${path} must resolve to exactly one explicit route policy`);
  assert.equal(matching[0].policy,'operator');
 }
 const frontier=routePolicyInventory.filter(item=>new RegExp(item.pattern).test('/api/discovery/frontier/comparison'));
 assert.deepEqual(frontier[0].action,'discovery.frontier.read');
 assert.ok(!routePolicyInventory.some(x=>x.policy==='public'&&/frontier/.test(x.pattern)));
});

test('version diagnostics is an explicit operator-only read route',()=>{
 const matching=routePolicyInventory.filter(item=>item.method==='GET'&&new RegExp(item.pattern).test('/api/version'));
 assert.equal(matching.length,1,'/api/version must resolve to exactly one explicit route policy');
 assert.equal(matching[0].policy,'operator');
 assert.equal(matching[0].action,'diagnostics.version.read');
});

test('bootstrap lifecycle routes are explicit and least-privileged (never public)',()=>{
  const cases=[
    { method:'GET', path:'/api/persistent-research/bootstrap-runs', policy:'operator', action:'research.bootstrap.read' },
    { method:'POST', path:'/api/persistent-research/bootstrap-runs', policy:'admin', action:'research.bootstrap.start' },
    { method:'POST', path:'/api/persistent-research/bootstrap-runs/00000000-0000-4000-8000-000000000000/abort', policy:'admin', action:'research.bootstrap.abort' },
  ] as const;
  for (const expected of cases) {
    const matching=routePolicyInventory.filter(item=>item.method===expected.method&&new RegExp(item.pattern).test(expected.path));
    assert.equal(matching.length,1,`${expected.method} ${expected.path} must resolve to exactly one explicit route policy`);
    assert.equal(matching[0].policy,expected.policy);
    assert.equal(matching[0].action,expected.action);
  }
  assert.ok(!routePolicyInventory.some(x=>x.policy==='public'&&/bootstrap-runs/.test(x.pattern)));
});

test('bootstrap lifecycle routes enforce authentication at the middleware layer',async ()=>{
  const run=(role:'admin'|'operator'|undefined,path='/api/persistent-research/bootstrap-runs',method='POST'):Promise<{next:boolean;status?:number;code?:string}>=>new Promise(resolve=>{
    const handler=operatorAuthorization(async ()=>{},{ NODE_ENV:'test', ADMIN_API_TOKEN:'admin-token', OPERATOR_API_TOKEN:'operator-token' } as NodeJS.ProcessEnv);
    const token=role==='admin'?'admin-token':role==='operator'?'operator-token':undefined;
    const req={ method, path, baseUrl:'', query:{}, header:(name:string)=>(name.toLowerCase()==='authorization'&&token?`Bearer ${token}`:undefined) };
    let status=0; let code='';
    const res={ status:(code_:number)=>{ status=code_; return res; }, json:(body:Record<string,unknown>)=>{ code=String(body.code||''); resolve({next:false,status,code}); }, setHeader:()=>{}, once:()=>{} };
    handler(req as never,res as never,()=>resolve({next:true}));
  });
  // Read path: operators pass, anonymous callers are rejected before any handler runs.
  assert.deepEqual(await run('operator','/api/persistent-research/bootstrap-runs','GET'),{next:true});
  assert.deepEqual(await run('admin','/api/persistent-research/bootstrap-runs','GET'),{next:true});
  const anonymousRead=await run(undefined,'/api/persistent-research/bootstrap-runs','GET');
  assert.equal(anonymousRead.next,false); assert.equal(anonymousRead.status,401);
  // State-changing paths: admin passes, operator role is insufficient, anonymous is rejected.
  assert.deepEqual(await run('admin'),{next:true});
  const operatorStart=await run('operator');
  assert.equal(operatorStart.next,false); assert.equal(operatorStart.status,403);
  const anonymousStart=await run(undefined);
  assert.equal(anonymousStart.next,false); assert.equal(anonymousStart.status,401);
  assert.deepEqual(await run('admin','/api/persistent-research/bootstrap-runs/00000000-0000-4000-8000-000000000000/abort'),{next:true});
  const operatorAbort=await run('operator','/api/persistent-research/bootstrap-runs/00000000-0000-4000-8000-000000000000/abort');
  assert.equal(operatorAbort.next,false); assert.equal(operatorAbort.status,403);
  // Unknown bootstrap-shaped paths still fail closed at the policy layer.
  const missing=await run('admin','/api/persistent-research/bootstrap-runs/extra/segments','GET');
  assert.equal(missing.next,false); assert.equal(missing.status,404); assert.equal(missing.code,'ROUTE_POLICY_MISSING');
});

test('denied bootstrap requests still answer when the audit writer fails',async ()=>{
  // The denial path awaits the audit write with a catch: a rejecting writer
  // must never swallow the 401/403 response or escape as an unhandled rejection.
  const failingWriter=async ()=>{ throw new Error('audit database unavailable'); };
  const runDenied=(role:'operator'|undefined,path:string):Promise<{next:boolean;status?:number;code?:string}>=>new Promise((resolve,reject)=>{
    const handler=operatorAuthorization(failingWriter,{ NODE_ENV:'test', ADMIN_API_TOKEN:'admin-token', OPERATOR_API_TOKEN:'operator-token' } as NodeJS.ProcessEnv);
    const token=role==='operator'?'operator-token':undefined;
    const req={ method:'POST', path, baseUrl:'', query:{}, header:(name:string)=>(name.toLowerCase()==='authorization'&&token?`Bearer ${token}`:undefined) };
    let status=0; let code='';
    const res={ status:(code_:number)=>{ status=code_; return res; }, json:(body:Record<string,unknown>)=>{ code=String(body.code||''); resolve({next:false,status,code}); }, setHeader:()=>{}, once:()=>{} };
    try {
      const out=(handler as unknown as (req:never,res:never,next:()=>void)=>unknown)(req as never,res as never,()=>resolve({next:true}));
      if (out instanceof Promise) out.catch(reject);
    } catch (error) { reject(error); }
  });
  const anonymous=await runDenied(undefined,'/api/persistent-research/bootstrap-runs');
  assert.equal(anonymous.next,false); assert.equal(anonymous.status,401);
  const forbidden=await runDenied('operator','/api/persistent-research/bootstrap-runs');
  assert.equal(forbidden.next,false); assert.equal(forbidden.status,403);
});

test('bootstrap arm/disarm routes are explicit admin-only routes',()=>{
  const arm=routePolicyInventory.filter(item=>item.method==='POST'&&new RegExp(item.pattern).test('/api/persistent-research/bootstrap-runs/00000000-0000-4000-8000-000000000000/arm'));
  assert.equal(arm.length,1); assert.equal(arm[0].policy,'admin'); assert.equal(arm[0].action,'research.bootstrap.arm');
  const disarm=routePolicyInventory.filter(item=>item.method==='POST'&&new RegExp(item.pattern).test('/api/persistent-research/bootstrap-runs/disarm'));
  assert.equal(disarm.length,1); assert.equal(disarm[0].policy,'admin'); assert.equal(disarm[0].action,'research.bootstrap.disarm');
});

test('domain weight batch and approval routes are explicit admin-only routes',()=>{
  const batch=routePolicyInventory.filter(item=>item.method==='POST'&&new RegExp(item.pattern).test('/api/domain-weights/batch'));
  assert.equal(batch.length,1); assert.equal(batch[0].policy,'admin'); assert.equal(batch[0].action,'research.domain-weights.batch');
  const approve=routePolicyInventory.filter(item=>item.method==='POST'&&new RegExp(item.pattern).test('/api/domain-weights/snapshots/abc123/approve'));
  assert.equal(approve.length,1); assert.equal(approve[0].policy,'admin'); assert.equal(approve[0].action,'research.domain-weights.approve');
test('operator-triggered research cycles are an explicit admin-only route',()=>{
  const matching=routePolicyInventory.filter(item=>item.method==='POST'&&new RegExp(item.pattern).test('/api/persistent-research/cycles'));
  assert.equal(matching.length,1,'POST /api/persistent-research/cycles must resolve to exactly one explicit route policy');
  assert.equal(matching[0].policy,'admin');
  assert.equal(matching[0].action,'research.cycle.trigger');
});

test('research cycle trigger enforces admin authentication at the middleware layer',async ()=>{
  const run=(role:'admin'|'operator'|undefined):Promise<{next:boolean;status?:number}>=>new Promise(resolve=>{
    const handler=operatorAuthorization(async ()=>{},{ NODE_ENV:'test', ADMIN_API_TOKEN:'admin-token', OPERATOR_API_TOKEN:'operator-token' } as NodeJS.ProcessEnv);
    const token=role==='admin'?'admin-token':role==='operator'?'operator-token':undefined;
    const req={ method:'POST', path:'/api/persistent-research/cycles', baseUrl:'', query:{}, header:(name:string)=>(name.toLowerCase()==='authorization'&&token?`Bearer ${token}`:undefined) };
    let status=0;
    const res={ status:(code_:number)=>{ status=code_; return res; }, json:()=>{ resolve({next:false,status}); }, setHeader:()=>{}, once:()=>{} };
    handler(req as never,res as never,()=>resolve({next:true}));
  });
  assert.deepEqual(await run('admin'),{next:true});
  assert.deepEqual(await run('operator'),{next:false,status:403});
  assert.deepEqual(await run(undefined),{next:false,status:401});
});
