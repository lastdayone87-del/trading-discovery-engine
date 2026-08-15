import fs from 'node:fs';

const path='server/youtube.ts';
let source=fs.readFileSync(path,'utf8');
const target='      await incrementQuota(1); activeKeyIndex = index;';
if(!source.includes(target)) throw new Error('stale country metadata repin not found');
source=source.replace(target,'      await incrementQuota(1);');
fs.writeFileSync(path,source);

const testPath='server/youtubeRequestScheduler.test.ts';
let tests=fs.readFileSync(testPath,'utf8');
const testName='country metadata does not overwrite validated dispatched provider pin';
if(!tests.includes(testName)){
  const anchor="test('preferred YouTube provider advances only after validated response success', () => {";
  const addition=`test('${testName}', () => {\n  const source = fs.readFileSync(new URL('./youtube.ts', import.meta.url), 'utf8');\n  const start = source.indexOf('export async function fetchYouTubeChannelCountryMetadata');\n  const end = source.indexOf('}', start);\n  const block = source.slice(start, source.indexOf('\\n}', start)+2);\n  assert.doesNotMatch(block, /activeKeyIndex\\s*=\\s*index/);\n});\n\n`;
  if(!tests.includes(anchor)) throw new Error('test insertion anchor not found');
  tests=tests.replace(anchor,addition+anchor);
  fs.writeFileSync(testPath,tests);
}
