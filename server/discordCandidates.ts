import {createHash} from 'node:crypto';
import type {AcquisitionSurface} from './inspector';

export type DiscordLocatorType='NATIVE_INVITE'|'ALTERNATIVE_REDIRECT'|'DIRECTORY_PAGE'|'OBFUSCATED_NATIVE'|'HEURISTIC_TOKEN';
export interface DiscordCandidate {candidateId:string;locatorType:DiscordLocatorType;sourceSurface:AcquisitionSurface;rawLocator:string;normalizedLocator?:string;nativeInviteCode?:string;sourceUrl?:string;wrapperUrl?:string;extractionConfidence:'EXPLICIT'|'RESOLVED'|'HEURISTIC'}

const reserved=new Set(['channels','guilds','store','download','nitro','login','register','api','widget','terms','privacy','branding','jobs','before','after','next','prev','index','home','about','contact','faq','support','invite','oauth2','template']);
const id=(value:object)=>createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,32);
const candidate=(value:Omit<DiscordCandidate,'candidateId'>):DiscordCandidate=>({...value,candidateId:id(value)});
export const makeDiscordCandidate=candidate;

export function extractDiscordCandidates(text:string,sourceSurface:AcquisitionSurface='CHANNEL_EXTERNAL_LINKS',sourceUrl?:string):DiscordCandidate[]{
  if(!text)return [];
  const clean=text.replace(/\\\/|\\u002f/gi,'/').replace(/\\u003a/gi,':').replace(/\\u0026/gi,'&').replace(/%2f/gi,'/').replace(/%3a/gi,':');
  const found:DiscordCandidate[]=[];
  const push=(rawLocator:string,locatorType:DiscordLocatorType,code:string|undefined,confidence:'EXPLICIT'|'RESOLVED'|'HEURISTIC')=>{
    if(code&&(code.length<2||code.length>128||reserved.has(code.toLowerCase())))return;
    const value=candidate({locatorType,sourceSurface,rawLocator,nativeInviteCode:code,normalizedLocator:code?`https://discord.gg/${code}`:undefined,sourceUrl,extractionConfidence:confidence});
    if(!found.some(item=>item.candidateId===value.candidateId))found.push(value);
  };
  const native=/(?:https?:\/\/)?(?:www\.)?(discord\.gg|discord\.com\/invite|discordapp\.com\/invite|discord\.app\/invite)\/([^\s"'<>\)\\/?#&]+)/gi;
  for(let match;(match=native.exec(clean))!==null;)push(match[0],'NATIVE_INVITE',match[2],'EXPLICIT');
  const alternative=/(?:https?:\/\/)?(?:www\.)?(dsc\.gg|discord\.me|discord\.io)\/([^\s"'<>\)\\/?#&]+)/gi;
  for(let match;(match=alternative.exec(clean))!==null;)push(match[0],'ALTERNATIVE_REDIRECT',undefined,'EXPLICIT');
  const directory=/(?:https?:\/\/)?(?:www\.)?disboard\.org\/server\/([^\s"'<>\)\\/?#&]+)/gi;
  for(let match;(match=directory.exec(clean))!==null;)push(match[0],'DIRECTORY_PAGE',undefined,'EXPLICIT');
  return found;
}

/** Build a retained native-invite candidate from a structured invite code (not from log prose). */
export function candidateFromNativeInvite(input:{
  nativeInviteCode:string;
  sourceSurface:AcquisitionSurface;
  sourceUrl?:string;
  rawLocator?:string;
  extractionConfidence?:DiscordCandidate['extractionConfidence'];
}):DiscordCandidate|null{
  const code=String(input.nativeInviteCode||'').trim();
  if(!code||code.length<2||code.length>128||reserved.has(code.toLowerCase()))return null;
  const raw=input.rawLocator||`https://discord.gg/${code}`;
  return candidate({
    locatorType:'NATIVE_INVITE',
    sourceSurface:input.sourceSurface,
    rawLocator:raw,
    nativeInviteCode:code,
    normalizedLocator:`https://discord.gg/${code}`,
    sourceUrl:input.sourceUrl,
    extractionConfidence:input.extractionConfidence||'EXPLICIT'
  });
}
