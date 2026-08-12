from pathlib import Path

db=Path('server/db.ts')
text=db.read_text()
old="""export function isRetryableInfrastructureFailure(error:any):boolean{
  const code=String(error?.code||error?.cause?.code||'').toUpperCase();
  const status=Number(error?.status||error?.statusCode||error?.response?.status);
  const name=String(error?.name||'');
  if(TRANSIENT_PROVIDER_CODES.has(code)||TRANSIENT_HTTP_STATUS.has(status))return true;
  if(name==='TimeoutError')return true;
  return false;
}
"""
new="""export function isRetryableInfrastructureFailure(error:any):boolean{
  const code=String(error?.code||error?.cause?.code||'').toUpperCase();
  const status=Number(error?.status||error?.statusCode||error?.response?.status);
  const name=String(error?.name||'');
  const errorClass=String(error?.errorClass||'').toUpperCase();
  if(TRANSIENT_PROVIDER_CODES.has(code)||TRANSIENT_HTTP_STATUS.has(status))return true;
  if(name==='TimeoutError')return true;
  if(error?.retryable===true&&['TIMEOUT','CANCELLED','RATE_LIMIT','TRANSIENT','CREDENTIALS_EXHAUSTED'].includes(errorClass))return true;
  return false;
}
"""
if old not in text:
    raise SystemExit('db retry predicate anchor not found')
db.write_text(text.replace(old,new,1))

test=Path('server/retryLifecyclePolicy.test.ts')
text=test.read_text()
anchor="""test('common network/provider outages are retryable infrastructure failures',()=>{
  for(const error of [{code:'ETIMEDOUT'},{code:'ECONNRESET'},{code:'EAI_AGAIN'},{status:429},{statusCode:503},{name:'TimeoutError'}]){
    assert.equal(isRetryableInfrastructureFailure(error),true,JSON.stringify(error));
    assert.equal(decideJobFailure(error,3,3,now).disposition,'RETRYING_WITHOUT_ATTEMPT');
  }
});
"""
addition=anchor+"""

test('normalized provider resilience failures stay attempt-free when marked retryable',()=>{
  for(const error of [
    {name:'ProviderCallError',errorClass:'TIMEOUT',retryable:true},
    {name:'ProviderCallError',errorClass:'TRANSIENT',retryable:true},
    {name:'ProviderCallError',errorClass:'RATE_LIMIT',retryable:true,status:429},
    {name:'ProviderCallError',errorClass:'CANCELLED',retryable:true}
  ]){
    assert.equal(isRetryableInfrastructureFailure(error),true,JSON.stringify(error));
    assert.equal(decideJobFailure(error,3,3,now).disposition,'RETRYING_WITHOUT_ATTEMPT');
  }
});

test('normalized permanent provider input failures remain bounded',()=>{
  const error={name:'ProviderCallError',errorClass:'PERMANENT_INPUT',retryable:false,status:400};
  assert.equal(isRetryableInfrastructureFailure(error),false);
  assert.equal(decideJobFailure(error,3,3,now).disposition,'FAILED');
});
"""
if anchor not in text:
    raise SystemExit('retry test anchor not found')
test.write_text(text.replace(anchor,addition,1))
