import fs from 'node:fs';

const youtubePath = 'server/youtube.ts';
let source = fs.readFileSync(youtubePath, 'utf8');

if (!source.includes('youtubeResponseProviderContext = new WeakMap<Response')) {
  const anchor = "const failedDispatchProvidersByAcquisition = new WeakMap<object, Set<string>>();";
  if (!source.includes(anchor)) throw new Error('failed-provider weakmap anchor not found');
  source = source.replace(anchor, `${anchor}\nconst youtubeResponseProviderContext = new WeakMap<Response, { providerKey?: string; acquisition?: YouTubePoolAcquisition }>();`);
}

const oldSuccess = `        if(dispatchedProviderKey)youtubeProviderCooldown.succeeded(dispatchedProviderKey);\n        acquisition?.providerSucceeded();return response;`;
const newSuccess = `        youtubeResponseProviderContext.set(response,{providerKey:dispatchedProviderKey,acquisition});\n        return response;`;
if (source.includes(oldSuccess)) source = source.replace(oldSuccess, newSuccess);
else if (!source.includes(newSuccess)) throw new Error('youtubeFetch success handoff target not found');

const oldReader = `export async function readYouTubeJsonObject<T extends Record<string, any> = Record<string, any>>(response: Response, operation: string): Promise<T> {\n  if (!response.ok) throw await youtubeHttpError(response);\n  const status = response.status;\n  const contentType = (response.headers.get('content-type') || '').toLowerCase();\n  const body = (await response.text()).trim();\n  if (!body) throw new ProviderCallError(\`YouTube \${operation} returned an empty response (HTTP \${status}).\`, 'TRANSIENT', true, { status });\n  if (!contentType.includes('json')) throw new ProviderCallError(\`YouTube \${operation} returned a non-JSON response (HTTP \${status}).\`, 'TRANSIENT', true, { status });\n  let parsed: unknown;\n  try {\n    parsed = JSON.parse(body);\n  } catch (cause) {\n    throw new ProviderCallError(\`YouTube \${operation} returned invalid JSON (HTTP \${status}).\`, 'TRANSIENT', true, { status, cause });\n  }\n  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {\n    throw new ProviderCallError(\`YouTube \${operation} returned an invalid JSON object (HTTP \${status}).\`, 'TRANSIENT', true, { status });\n  }\n  const object = parsed as Record<string, any>;\n  if (object.error) {\n    throw new ProviderCallError(\`YouTube \${operation} returned a provider error payload (HTTP \${status}).\`, 'TRANSIENT', true, { status });\n  }\n  if (!Array.isArray(object.items)) {\n    throw new ProviderCallError(\`YouTube \${operation} returned a JSON body without an items array (HTTP \${status}).\`, 'TRANSIENT', true, { status });\n  }\n  return object as T;\n}`;

const newReader = `export async function readYouTubeJsonObject<T extends Record<string, any> = Record<string, any>>(response: Response, operation: string): Promise<T> {\n  const context = youtubeResponseProviderContext.get(response);\n  try {\n    if (!response.ok) throw await youtubeHttpError(response);\n    const status = response.status;\n    const contentType = (response.headers.get('content-type') || '').toLowerCase();\n    const body = (await response.text()).trim();\n    if (!body) throw new ProviderCallError(\`YouTube \${operation} returned an empty response (HTTP \${status}).\`, 'TRANSIENT', true, { status });\n    if (!contentType.includes('json')) throw new ProviderCallError(\`YouTube \${operation} returned a non-JSON response (HTTP \${status}).\`, 'TRANSIENT', true, { status });\n    let parsed: unknown;\n    try {\n      parsed = JSON.parse(body);\n    } catch (cause) {\n      throw new ProviderCallError(\`YouTube \${operation} returned invalid JSON (HTTP \${status}).\`, 'TRANSIENT', true, { status, cause });\n    }\n    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {\n      throw new ProviderCallError(\`YouTube \${operation} returned an invalid JSON object (HTTP \${status}).\`, 'TRANSIENT', true, { status });\n    }\n    const object = parsed as Record<string, any>;\n    if (object.error) {\n      throw new ProviderCallError(\`YouTube \${operation} returned a provider error payload (HTTP \${status}).\`, 'TRANSIENT', true, { status });\n    }\n    if (!Array.isArray(object.items)) {\n      throw new ProviderCallError(\`YouTube \${operation} returned a JSON body without an items array (HTTP \${status}).\`, 'TRANSIENT', true, { status });\n    }\n    if(context?.providerKey)youtubeProviderCooldown.succeeded(context.providerKey);\n    context?.acquisition?.providerSucceeded();\n    return object as T;\n  } catch (error) {\n    if(context?.providerKey){\n      failedDispatchProviders(context.acquisition)?.add(context.providerKey);\n      if(error&&typeof error==='object')Object.assign(error,{providerKey:context.providerKey});\n    }\n    throw error;\n  }\n}`;

if (source.includes(oldReader)) source = source.replace(oldReader, newReader);
else if (!source.includes('const context = youtubeResponseProviderContext.get(response);')) throw new Error('readYouTubeJsonObject target not found');

fs.writeFileSync(youtubePath, source);

const testPath = 'server/youtubeRequestScheduler.test.ts';
let tests = fs.readFileSync(testPath, 'utf8');
const testName = "post-response validation failures preserve the actual dispatched provider identity";
if (!tests.includes(testName)) {
  const anchor = `test('provider-loop requests carry the selected API key into scheduler dispatch', () => {`;
  const addition = `test('${testName}', () => {\n  const source = fs.readFileSync(new URL('./youtube.ts', import.meta.url), 'utf8');\n  const youtubeFetch = source.slice(source.indexOf('async function youtubeFetch'), source.indexOf('export type YouTubeAdditionalQuotaCallback'));\n  const reader = source.slice(source.indexOf('export async function readYouTubeJsonObject'), source.indexOf('/** A request-rate limit'));\n  assert.match(source, /youtubeResponseProviderContext = new WeakMap<Response/);\n  assert.match(youtubeFetch, /youtubeResponseProviderContext\\.set\\(response,\\{providerKey:dispatchedProviderKey,acquisition\\}\\)/);\n  assert.doesNotMatch(youtubeFetch, /youtubeProviderCooldown\\.succeeded\\(dispatchedProviderKey\\)/);\n  assert.match(reader, /const context = youtubeResponseProviderContext\\.get\\(response\\)/);\n  assert.match(reader, /failedDispatchProviders\\(context\\.acquisition\\)\\?\\.add\\(context\\.providerKey\\)/);\n  assert.match(reader, /Object\\.assign\\(error,\\{providerKey:context\\.providerKey\\}\\)/);\n  assert.match(reader, /youtubeProviderCooldown\\.succeeded\\(context\\.providerKey\\)/);\n  assert.match(reader, /context\\?\\.acquisition\\?\\.providerSucceeded\\(\\)/);\n});\n\n`;
  if (!tests.includes(anchor)) throw new Error('test insertion anchor not found');
  tests = tests.replace(anchor, addition + anchor);
  fs.writeFileSync(testPath, tests);
}
