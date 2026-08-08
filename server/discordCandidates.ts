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
  const deobfuscated=clean.replace(/discord\s*(?:\[|\()?dot(?:\]|\))?\s*gg\s*[\/\\]\s*/gi,'discord.gg/').replace(/discord\s*\[?\.\]?\s*gg\s*[\/\\]\s*/gi,'discord.gg/');
  if(deobfuscated!==clean)for(let match;(match=native.exec(deobfuscated))!==null;)push(match[0],'OBFUSCATED_NATIVE',match[2],'RESOLVED');
  const heuristic=/discord(?:\.gg)?\s*[:=\-]\s*([a-zA-Z0-9_-]{4,128})(?![a-zA-Z0-9_-])/gi;
  for(let match;(match=heuristic.exec(clean))!==null;){const code=match[1];if(!['http','https','com','org','net','join','server','link'].includes(code.toLowerCase()))push(match[0],'HEURISTIC_TOKEN',code,'HEURISTIC');}
  return found.slice(0,10);
}
