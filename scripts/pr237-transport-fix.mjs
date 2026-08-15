import fs from 'node:fs';
const path = 'server/youtube.ts';
let source = fs.readFileSync(path, 'utf8');
const oldText = `        const response=await fetch(dispatchedUrl,{signal});
        trace(\`after HTTP fetch at server/youtube.ts:131 (status=\${response.status})\`);`;
const newText = `        let response: Response;
        try {
          response=await fetch(dispatchedUrl,{signal});
        } catch (error) {
          if(dispatchedProviderKey){
            failedDispatchProviders(acquisition)?.add(dispatchedProviderKey);
            if(error&&typeof error==='object')Object.assign(error,{providerKey:dispatchedProviderKey});
          }
          throw error;
        }
        trace(\`after HTTP fetch at server/youtube.ts:131 (status=\${response.status})\`);`;
if (!source.includes(oldText)) throw new Error('youtube fetch target not found');
source = source.replace(oldText, newText);
fs.writeFileSync(path, source);
