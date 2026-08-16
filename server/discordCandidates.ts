import {createHash} from 'node:crypto';
import type {AcquisitionSurface} from './inspector';

export type DiscordLocatorType='NATIVE_INVITE'|'ALTERNATIVE_REDIRECT'|'DIRECTORY_PAGE'|'OBFUSCATED_NATIVE'|'HEURISTIC_TOKEN';
export type DiscordOwnershipStatus='CREATOR_OWNED'|'THIRD_PARTY'|'UNCERTAIN';
export interface DiscordCandidateObservation {
  sourceSurface:AcquisitionSurface;
  sourceUrl?:string;
  rawLocator:string;
  sourcePageUrl?:string;
  sourceAnchorText?:string;
  sourcePageTitle?:string;
  sourcePageDepth?:number;
  extractionConfidence:'EXPLICIT'|'RESOLVED'|'HEURISTIC';
}
export interface DiscordCandidate {
  candidateId:string;
  canonicalInviteId?:string;
  locatorType:DiscordLocatorType;
  sourceSurface:AcquisitionSurface;
  rawLocator:string;
  normalizedLocator?:string;
  nativeInviteCode?:string;
  sourceUrl?:string;
  wrapperUrl?:string;
  extractionConfidence:'EXPLICIT'|'RESOLVED'|'HEURISTIC';
  ownershipStatus?:DiscordOwnershipStatus;
  ownershipConfidence?:number;
  ownershipReasons?:string[];
  observations?:DiscordCandidateObservation[];
}

const reserved=new Set(['channels','guilds','store','download','nitro','login','register','api','widget','terms','privacy','branding','jobs','before','after','next','prev','index','home','about','contact','faq','support','invite','oauth2','template']);
const id=(value:object)=>createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,32);
export const canonicalDiscordInviteId=(code:string)=>`discord:${String(code||'').trim().toLowerCase()}`;
const candidate=(value:Omit<DiscordCandidate,'candidateId'>):DiscordCandidate=>{
  const canonicalInviteId=value.nativeInviteCode?canonicalDiscordInviteId(value.nativeInviteCode):undefined;
  const observation:DiscordCandidateObservation={sourceSurface:value.sourceSurface,sourceUrl:value.sourceUrl,rawLocator:value.rawLocator,sourcePageUrl:value.sourceUrl,extractionConfidence:value.extractionConfidence};
  return {...value,canonicalInviteId,observations:value.observations?.length?value.observations:[observation],candidateId:id(value)};
};
export const makeDiscordCandidate=candidate;

export function inferDiscordOwnership(candidate:DiscordCandidate,input:{creatorName?:string;creatorWebsiteHosts?:string[]}={}):Pick<DiscordCandidate,'ownershipStatus'|'ownershipConfidence'|'ownershipReasons'>{
  const reasons:string[]=[];
  let score=0;
  if(candidate.sourceSurface==='YOUTUBE_ABOUT'){score+=90;reasons.push('DIRECT_YOUTUBE_ABOUT');}
  if(candidate.sourceSurface==='RECENT_VIDEO_DESCRIPTIONS'){score+=65;reasons.push('DIRECT_CREATOR_VIDEO');}
  if(candidate.sourceSurface==='CHANNEL_EXTERNAL_LINKS'){score+=70;reasons.push('DIRECT_CHANNEL_LINK');}
  if(candidate.sourceSurface==='CREATOR_WEBSITES'){score+=40;reasons.push('LINKED_WEBSITE_SURFACE');}
  if(candidate.sourceSurface==='SOCIAL_PROFILES'){score+=55;reasons.push('CREATOR_SOCIAL_SURFACE');}
  const source=String(candidate.sourceUrl||'').toLowerCase();
  const raw=String(candidate.rawLocator||'').toLowerCase();
  const creatorName=String(input.creatorName||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
  const partnerSignals=/affiliate|referral|sponsor|partner|broker|course|product|parrain|refer\b|promo|discount/;
  if(partnerSignals.test(`${source} ${raw}`)){score-=80;reasons.push('PARTNER_OR_AFFILIATE_SURFACE');}
  try{
    const host=new URL(source).hostname.toLowerCase();
    if(input.creatorWebsiteHosts?.some(candidateHost=>host===candidateHost||host.endsWith(`.${candidateHost}`))){score+=55;reasons.push('CREATOR_CANONICAL_DOMAIN');}
    if(creatorName){const compact=creatorName.replace(/\s+/g,'');const hostCompact=host.replace(/[^a-z0-9]/g,'');if(compact.length>=4&&hostCompact.includes(compact)){score+=30;reasons.push('CREATOR_BRAND_DOMAIN_MATCH');}}
  }catch{}
  const ownershipStatus:DiscordOwnershipStatus=score>=75?'CREATOR_OWNED':score<=0?'THIRD_PARTY':'UNCERTAIN';
  return {ownershipStatus,ownershipConfidence:Math.min(100,Math.max(10,Math.abs(score))),ownershipReasons:reasons.length?reasons:['OWNERSHIP_EVIDENCE_INSUFFICIENT']};
}

export function mergeDiscordCandidates(items:DiscordCandidate[],input:{creatorName?:string;creatorWebsiteHosts?:string[]}={}):DiscordCandidate[]{
  const byCanonical=new Map<string,DiscordCandidate>();
  for(const item of items){
    if(!item.nativeInviteCode)continue;
    const key=item.canonicalInviteId||canonicalDiscordInviteId(item.nativeInviteCode);
    const ownership=inferDiscordOwnership(item,input);
    const enriched={...item,...ownership,canonicalInviteId:key};
    const existing=byCanonical.get(key);
    if(!existing){byCanonical.set(key,enriched);continue;}
    const observations=[...(existing.observations||[]),...(enriched.observations||[])];
    const stronger=(enriched.ownershipConfidence||0)>(existing.ownershipConfidence||0)?enriched:existing;
    byCanonical.set(key,{...stronger,observations:Array.from(new Map(observations.map(obs=>[JSON.stringify([obs.sourceSurface,obs.sourceUrl,obs.rawLocator,obs.sourcePageUrl]),obs])).values())});
  }
  const ownershipRank=(candidate:DiscordCandidate)=>candidate.ownershipStatus==='CREATOR_OWNED'?3:candidate.ownershipStatus==='UNCERTAIN'?2:1;
  return Array.from(byCanonical.values()).sort((a,b)=>ownershipRank(b)-ownershipRank(a)||(b.ownershipConfidence||0)-(a.ownershipConfidence||0));
}

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
