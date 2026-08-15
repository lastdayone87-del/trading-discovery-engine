from pathlib import Path

path = Path('server/youtube.ts')
source = path.read_text()
old = """function recordProviderFailure(key: string, error: unknown): void {
  const dispatchedKey = typeof (error as any)?.providerKey === 'string' ? (error as any).providerKey : key;
  if (isQuotaExceeded(error)) youtubeProviderCooldown.failed(dispatchedKey, 'DAILY_QUOTA_EXHAUSTED');
  else if (isYouTubeRateLimited(error)) youtubeProviderCooldown.failed(dispatchedKey, 'RATE_LIMITED');
}
"""
new = """function recordProviderFailure(key: string, error: unknown): void {
  if ((error as any)?.providerFailureRecorded === true) return;
  const dispatchedKey = typeof (error as any)?.providerKey === 'string' ? (error as any).providerKey : key;
  if (isQuotaExceeded(error)) youtubeProviderCooldown.failed(dispatchedKey, 'DAILY_QUOTA_EXHAUSTED');
  else if (isYouTubeRateLimited(error)) youtubeProviderCooldown.failed(dispatchedKey, 'RATE_LIMITED');
}
"""
if old not in source:
    raise SystemExit('recordProviderFailure block not found')
source = source.replace(old, new, 1)

old = """        if(!response.ok){
          trace('before HTTP-error-body-read at server/youtube.ts:135');
          const error=await youtubeHttpError(response,trace);
          trace('after HTTP-error-body-read at server/youtube.ts:135');
          throw error;
        }
"""
new = """        if(!response.ok){
          trace('before HTTP-error-body-read at server/youtube.ts:135');
          const error=await youtubeHttpError(response,trace);
          trace('after HTTP-error-body-read at server/youtube.ts:135');
          if(dispatchedProviderKey){
            if(isQuotaExceeded(error))youtubeProviderCooldown.failed(dispatchedProviderKey,'DAILY_QUOTA_EXHAUSTED');
            else if(isYouTubeRateLimited(error))youtubeProviderCooldown.failed(dispatchedProviderKey,'RATE_LIMITED');
            if(error&&typeof error==='object')Object.assign(error,{providerKey:dispatchedProviderKey,providerFailureRecorded:true});
          }
          throw error;
        }
"""
if old not in source:
    raise SystemExit('youtubeFetch failure block not found')
source = source.replace(old, new, 1)
path.write_text(source)

test_path = Path('server/youtubeRequestScheduler.test.ts')
tests = test_path.read_text()
anchor = "test('provider-loop requests carry the selected API key into scheduler dispatch', () => {\n"
addition = """test('youtubeFetch records the actual provider failure before scheduler release and prevents duplicate outer accounting', () => {
  const source = fs.readFileSync(new URL('./youtube.ts', import.meta.url), 'utf8');
  const youtubeFetch = source.slice(source.indexOf('async function youtubeFetch'), source.indexOf('export type YouTubeAdditionalQuotaCallback'));
  const failureBranch = youtubeFetch.slice(youtubeFetch.indexOf('if(!response.ok)'), youtubeFetch.indexOf('if(dispatchedProviderKey)youtubeProviderCooldown.succeeded'));
  assert.match(failureBranch, /youtubeProviderCooldown\.failed\(dispatchedProviderKey,'DAILY_QUOTA_EXHAUSTED'\)/);
  assert.match(failureBranch, /youtubeProviderCooldown\.failed\(dispatchedProviderKey,'RATE_LIMITED'\)/);
  assert.match(failureBranch, /providerFailureRecorded:true/);
  assert.ok(failureBranch.indexOf('youtubeProviderCooldown.failed') < failureBranch.indexOf('throw error'));
  const recorder = source.slice(source.indexOf('function recordProviderFailure'), source.indexOf('export function selectYouTubeDispatchProviderIndex'));
  assert.match(recorder, /providerFailureRecorded === true\) return/);
});

"""
if addition not in tests:
    if anchor not in tests:
        raise SystemExit('test insertion anchor not found')
    tests = tests.replace(anchor, addition + anchor, 1)
    test_path.write_text(tests)
