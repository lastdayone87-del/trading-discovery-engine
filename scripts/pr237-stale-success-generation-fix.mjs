import fs from 'node:fs';

const youtubePath='server/youtube.ts';
let source=fs.readFileSync(youtubePath,'utf8');

const contextOld="const youtubeResponseProviderContext = new WeakMap<Response, { providerKey?: string; acquisition?: YouTubePoolAcquisition }>();";
const contextNew="const youtubeResponseProviderContext = new WeakMap<Response, { providerKey?: string; acquisition?: YouTubePoolAcquisition; providerFailureGeneration?: number }>();";
if(source.includes(contextOld)) source=source.replace(contextOld,contextNew);
else if(!source.includes('providerFailureGeneration?: number')) throw new Error('response context anchor not found');

const setOld="        youtubeResponseProviderContext.set(response,{providerKey:dispatchedProviderKey,acquisition});";
const setNew="        const providerFailureGeneration=dispatchedProviderKey?youtubeProviderCooldown.failureGeneration(dispatchedProviderKey):undefined;\n        youtubeResponseProviderContext.set(response,{providerKey:dispatchedProviderKey,acquisition,providerFailureGeneration});";
if(source.includes(setOld)) source=source.replace(setOld,setNew);
else if(!source.includes('providerFailureGeneration=dispatchedProviderKey?youtubeProviderCooldown.failureGeneration')) throw new Error('response context set anchor not found');

const successOld=`    if(context?.providerKey){\n      youtubeProviderCooldown.succeeded(context.providerKey);\n      const validatedPool=getYouTubeKeyPool();\n      const validatedIndex=validatedPool.indexOf(context.providerKey);\n      if(validatedIndex>=0)activeKeyIndex=validatedIndex;\n    }`;
const successNew=`    if(context?.providerKey){\n      const providerSuccessIsCurrent=youtubeProviderCooldown.succeeded(context.providerKey,context.providerFailureGeneration);\n      if(providerSuccessIsCurrent){\n        const validatedPool=getYouTubeKeyPool();\n        const validatedIndex=validatedPool.indexOf(context.providerKey);\n        if(validatedIndex>=0)activeKeyIndex=validatedIndex;\n      }\n    }`;
if(source.includes(successOld)) source=source.replace(successOld,successNew);
else if(!source.includes('providerSuccessIsCurrent=youtubeProviderCooldown.succeeded')) throw new Error('validated success anchor not found');

fs.writeFileSync(youtubePath,source);

const livePath='server/youtubeLiveProviderDispatch.test.ts';
let live=fs.readFileSync(livePath,'utf8');
live=live.replace(
  `  assert.match(reader,/youtubeProviderCooldown\\.succeeded\\(context\\.providerKey\\)/);`,
  `  assert.match(reader,/youtubeProviderCooldown\\.succeeded\\(context\\.providerKey,context\\.providerFailureGeneration\\)/);\n  assert.match(youtubeFetch,/providerFailureGeneration=dispatchedProviderKey\\?youtubeProviderCooldown\\.failureGeneration\\(dispatchedProviderKey\\):undefined/);`
);
fs.writeFileSync(livePath,live);

const schedulerPath='server/youtubeRequestScheduler.test.ts';
let scheduler=fs.readFileSync(schedulerPath,'utf8');
scheduler=scheduler.replace(
  `/youtubeResponseProviderContext\\.set\\(response,\\{providerKey:dispatchedProviderKey,acquisition\\}\\)/`,
  `/providerFailureGeneration=dispatchedProviderKey\\?youtubeProviderCooldown\\.failureGeneration\\(dispatchedProviderKey\\):undefined[\\s\\S]*youtubeResponseProviderContext\\.set\\(response,\\{providerKey:dispatchedProviderKey,acquisition,providerFailureGeneration\\}\\)/`
);
scheduler=scheduler.replace(
  `const failureBranch = youtubeFetch.slice(youtubeFetch.indexOf('if(!response.ok)'), youtubeFetch.indexOf('if(dispatchedProviderKey)youtubeProviderCooldown.succeeded'));`,
  `const failureBranch = youtubeFetch.slice(youtubeFetch.indexOf('if(!response.ok)'), youtubeFetch.indexOf('youtubeResponseProviderContext.set'));`
);
scheduler=scheduler.replaceAll(
  `/youtubeResponseProviderContext\\.set\\(response,\\{providerKey:dispatchedProviderKey,acquisition\\}\\)/`,
  `/youtubeResponseProviderContext\\.set\\(response,\\{providerKey:dispatchedProviderKey,acquisition,providerFailureGeneration\\}\\)/`
);
scheduler=scheduler.replaceAll(
  `/youtubeProviderCooldown\\.succeeded\\(context\\.providerKey\\)/`,
  `/youtubeProviderCooldown\\.succeeded\\(context\\.providerKey,context\\.providerFailureGeneration\\)/`
);
const preferredAnchor=`  assert.match(reader, /const validatedPool=getYouTubeKeyPool\\(\\)/);`;
if(scheduler.includes(preferredAnchor) && !scheduler.includes('providerSuccessIsCurrent')){
  scheduler=scheduler.replace(preferredAnchor,`  assert.match(reader, /providerSuccessIsCurrent=youtubeProviderCooldown\\.succeeded\\(context\\.providerKey,context\\.providerFailureGeneration\\)/);\n  assert.match(reader, /if\\(providerSuccessIsCurrent\\)/);\n${preferredAnchor}`);
}
fs.writeFileSync(schedulerPath,scheduler);

const poolPath='server/youtubePoolBackoff.test.ts';
let pool=fs.readFileSync(poolPath,'utf8');
pool=pool.replace(
  `  assert.match(readerBlock,/youtubeProviderCooldown\\.succeeded\\(context\\.providerKey\\)/);`,
  `  assert.match(readerBlock,/youtubeProviderCooldown\\.succeeded\\(context\\.providerKey,context\\.providerFailureGeneration\\)/);`
);
fs.writeFileSync(poolPath,pool);
