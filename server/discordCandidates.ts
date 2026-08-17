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

const observationKey=(observation:DiscordCandidateObservation)=>JSON.stringify([
  observation.sourceSurface,
  observation.sourceUrl||'',
  observation.rawLocator,
  observation.sourcePageUrl||'',
  observation.sourceAnchorText||'',
  observation.sourcePageTitle||''
]);

function creatorIdentityParts(name:string):string[]{
  const stop=new Set(['the','and','official','channel','trading','trader','trades','trade','finance','financial','markets','market','academy','capital','investing','investor','investments']);
  return name.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().split(/\s+/).filter(part=>part.length>=4&&!stop.has(part));
}

export function inferDiscordOwnership(candidate:DiscordCandidate,input:{creatorName?:string;creatorWebsiteHosts?:string[]}={}):Pick<DiscordCandidate,'ownershipStatus'|'ownershipConfidence'|'ownershipReasons'>{
  const reasons:string[]=[];
  let score=0;
  const observations=candidate.observations?.length?candidate.observations:[{sourceSurface:candidate.sourceSurface,sourceUrl:candidate.sourceUrl,rawLocator:candidate.rawLocator,sourcePageUrl:candidate.sourceUrl,extractionConfidence:candidate.extractionConfidence}];
  const surfaces=new Set(observations.map(observation=>observation.sourceSurface));

  if(surfaces.has('YOUTUBE_ABOUT')){score+=90;reasons.push('DIRECT_YOUTUBE_ABOUT');}
  else if(surfaces.has('CHANNEL_EXTERNAL_LINKS')){score+=70;reasons.push('DIRECT_CHANNEL_LINK');}
  else if(surfaces.has('RECENT_VIDEO_DESCRIPTIONS')){score+=65;reasons.push('DIRECT_CREATOR_VIDEO');}
  else if(surfaces.has('SOCIAL_PROFILES')){score+=55;reasons.push('CREATOR_SOCIAL_SURFACE');}
  else if(surfaces.has('CREATOR_WEBSITES')){score+=40;reasons.push('LINKED_WEBSITE_SURFACE');}

  // A channel external link is a creator-controlled surface. Explicit extraction
  // is enough corroboration to cross the creator-owned gate unless contradictory
  // partner/referral evidence is present below.
  if(surfaces.has('CHANNEL_EXTERNAL_LINKS')&&observations.some(observation=>observation.sourceSurface==='CHANNEL_EXTERNAL_LINKS'&&observation.extractionConfidence==='EXPLICIT')){
    score+=10;reasons.push('EXPLICIT_CHANNEL_CONTROLLED_LINK');
  }

  // A Discord appearing in one video description can be a sponsor/partner link.
  // Repetition across distinct creator video pages is materially stronger evidence
  // that the community belongs to the creator, without globally lowering the gate.
  const creatorVideoPages=new Set(observations
    .filter(observation=>observation.sourceSurface==='RECENT_VIDEO_DESCRIPTIONS')
    .map(observation=>observation.sourcePageUrl||observation.sourceUrl||'')
    .filter(Boolean));
  if(creatorVideoPages.size>=2){score+=15;reasons.push('REPEATED_CREATOR_VIDEO_OBSERVATION');}

  if(surfaces.size>=2&&[...surfaces].some(surface=>surface==='YOUTUBE_ABOUT'||surface==='CHANNEL_EXTERNAL_LINKS'||surface==='RECENT_VIDEO_DESCRIPTIONS')){
    score+=15;reasons.push('CROSS_CREATOR_SURFACE_CORROBORATION');
  }

  const creatorName=String(input.creatorName||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
  const creatorParts=creatorIdentityParts(creatorName);
  const partnerSignals=/affiliate|referral|sponsor|sponsored|partner|broker|course|product|parrain|refer\b|promo|discount/;
  const provenanceText=observations.map(observation=>[
    observation.sourceUrl,
    observation.sourcePageUrl,
    observation.sourceAnchorText,
    observation.sourcePageTitle,
    observation.rawLocator
  ].filter(Boolean).join(' ')).join(' ').toLowerCase();
  if(partnerSignals.test(provenanceText)){score-=80;reasons.push('PARTNER_OR_AFFILIATE_SURFACE');}

  const candidateHosts=new Set(observations.map(observation=>observation.sourcePageUrl||observation.sourceUrl||'').filter(Boolean));
  for(const candidateUrl of candidateHosts){
    try{
      const parsed=new URL(candidateUrl),host=parsed.hostname.toLowerCase();
      if(input.creatorWebsiteHosts?.some(candidateHost=>host===candidateHost||host.endsWith(`.${candidateHost}`))){score+=55;reasons.push('CREATOR_CANONICAL_DOMAIN');break;}
      if(creatorName){
        const compact=creatorName.replace(/\s+/g,''),hostCompact=host.replace(/[^a-z0-9]/g,'');
        // A brand-matching creator website was already intended as strong
        // provenance, but the old +30 left a linked creator website at 70/75.
        // Make that corroboration actually cross the existing gate without
        // lowering the global CREATOR_OWNED threshold.
        if(compact.length>=4&&hostCompact.includes(compact)){score+=35;reasons.push('CREATOR_BRAND_DOMAIN_MATCH');break;}

        // Social profiles are creator-controlled only when the profile identity
        // itself corroborates the creator. Require at least two meaningful name
        // parts (or the complete compact creator name) in the URL path so a
        // generic platform URL cannot promote a partner community.
        if(surfaces.has('SOCIAL_PROFILES')){
          const pathCompact=decodeURIComponent(parsed.pathname).toLowerCase().replace(/[^a-z0-9]/g,'');
          const matchedParts=creatorParts.filter(part=>pathCompact.includes(part));
          if((compact.length>=5&&pathCompact.includes(compact))||matchedParts.length>=2){score+=20;reasons.push('CREATOR_SOCIAL_IDENTITY_MATCH');break;}
        }
      }
    }catch{}
  }

  const ownershipStatus:DiscordOwnershipStatus=score>=75?'CREATOR_OWNED':score<=0?'THIRD_PARTY':'UNCERTAIN';
  return {ownershipStatus,ownershipConfidence:Math.min(100,Math.max(10,Math.abs(score))),ownershipReasons:reasons.length?Array.from(new Set(reasons)):['OWNERSHIP_EVIDENCE_INSUFFICIENT']};
}

export function mergeDiscordCandidates(items:DiscordCandidate[],input:{creatorName?:string;creatorWebsiteHosts?:string[]}={}):DiscordCandidate[]{
  const byCanonical=new Map<string,DiscordCandidate>();
  for(const item of items){
    if(!item.nativeInviteCode)continue;
    const key=item.canonicalInviteId||canonicalDiscordInviteId(item.nativeInviteCode);
    const existing=byCanonical.get(key);
    const observations=Array.from(new Map([...(existing?.observations||[]),...(item.observations||[])].map(observation=>[observationKey(observation),observation])).values());
    const mergedBase:DiscordCandidate={...(existing||item),...item,canonicalInviteId:key,observations};
    const ownership=inferDiscordOwnership(mergedBase,input);
    byCanonical.set(key,{...mergedBase,...ownership});
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