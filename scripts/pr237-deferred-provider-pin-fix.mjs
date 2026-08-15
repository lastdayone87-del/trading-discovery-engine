import fs from 'node:fs';

const youtubePath='server/youtube.ts';
let source=fs.readFileSync(youtubePath,'utf8');

const dispatchPin='        activeKeyIndex=dispatchIndex;\n';
if(source.includes(dispatchPin)) source=source.replace(dispatchPin,'');

const successAnchor='    if(context?.providerKey)youtubeProviderCooldown.succeeded(context.providerKey);\n    context?.acquisition?.providerSucceeded();';
const successReplacement=`    if(context?.providerKey){\n      youtubeProviderCooldown.succeeded(context.providerKey);\n      const validatedPool=getYouTubeKeyPool();\n      const validatedIndex=validatedPool.indexOf(context.providerKey);\n      if(validatedIndex>=0)activeKeyIndex=validatedIndex;\n    }\n    context?.acquisition?.providerSucceeded();`;
if(source.includes(successAnchor)) source=source.replace(successAnchor,successReplacement);
else if(!source.includes('const validatedIndex=validatedPool.indexOf(context.providerKey);')) throw new Error('validated-success anchor not found');

fs.writeFileSync(youtubePath,source);

const livePath='server/youtubeLiveProviderDispatch.test.ts';
let live=fs.readFileSync(livePath,'utf8');
const stale=`  assert.match(source,/youtubeProviderCooldown\\.succeeded\\(dispatchedProviderKey\\)/);`;
const fresh=`  const readerStart=source.indexOf('export async function readYouTubeJsonObject');\n  const reader=source.slice(readerStart,source.indexOf('/** A request-rate limit',readerStart));\n  const youtubeFetch=source.slice(source.indexOf('async function youtubeFetch'),source.indexOf('export type YouTubeAdditionalQuotaCallback'));\n  assert.doesNotMatch(youtubeFetch,/activeKeyIndex=dispatchIndex/);\n  assert.doesNotMatch(youtubeFetch,/youtubeProviderCooldown\\.succeeded\\(dispatchedProviderKey\\)/);\n  assert.match(reader,/youtubeProviderCooldown\\.succeeded\\(context\\.providerKey\\)/);\n  assert.match(reader,/validatedIndex=validatedPool\\.indexOf\\(context\\.providerKey\\)/);\n  assert.match(reader,/if\\(validatedIndex>=0\\)activeKeyIndex=validatedIndex/);`;
if(live.includes(stale)) live=live.replace(stale,fresh);
else if(!live.includes('validatedIndex=validatedPool')) throw new Error('stale live dispatch expectation not found');
fs.writeFileSync(livePath,live);

const schedulerPath='server/youtubeRequestScheduler.test.ts';
let scheduler=fs.readFileSync(schedulerPath,'utf8');
const testName='preferred YouTube provider advances only after validated response success';
if(!scheduler.includes(testName)){
  const anchor="test('provider-loop requests carry the selected API key into scheduler dispatch', () => {";
  const addition=`test('${testName}', () => {\n  const source = fs.readFileSync(new URL('./youtube.ts', import.meta.url), 'utf8');\n  const youtubeFetch = source.slice(source.indexOf('async function youtubeFetch'), source.indexOf('export type YouTubeAdditionalQuotaCallback'));\n  const reader = source.slice(source.indexOf('export async function readYouTubeJsonObject'), source.indexOf('/** A request-rate limit'));\n  assert.doesNotMatch(youtubeFetch, /activeKeyIndex=dispatchIndex/);\n  assert.match(reader, /const validatedPool=getYouTubeKeyPool\\(\\)/);\n  assert.match(reader, /const validatedIndex=validatedPool\\.indexOf\\(context\\.providerKey\\)/);\n  assert.match(reader, /if\\(validatedIndex>=0\\)activeKeyIndex=validatedIndex/);\n});\n\n`;
  if(!scheduler.includes(anchor)) throw new Error('scheduler test insertion anchor not found');
  scheduler=scheduler.replace(anchor,addition+anchor);
  fs.writeFileSync(schedulerPath,scheduler);
}
