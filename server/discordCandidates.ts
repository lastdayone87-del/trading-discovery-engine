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

/**
 * Structural exclusions only. These are Discord application routes that are
 * not invite codes; they stay rejected so a route path can never claim a
 * registry row before validation. The previous list also rejected 16 codes
 * that the live Discord API serves as valid invites (`store`, `home`, `about`,
 * `contact`, `support`, `channels`, `download`, `api`, `widget`, `terms`,
 * `privacy`, `before`, `after`, `next`, `index`, `template`); those are now
 * admitted and left to live validation, which remains the final authority.
 */
export const RESERVED_DISCORD_ROUTE_CODES=new Set(['guilds','nitro','login','register','branding','jobs','prev','faq','invite','oauth2']);
const id=(value:object)=>createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,32);
export const canonicalDiscordInviteId=(code:string)=>`discord:${String(code||'').trim().toLowerCase()}`;
/** Canonical invite code shared by every layer that must agree on Discord
 * invite identity (registry claims, choke-point filtering, tests). Accepts a
 * bare code or any Discord URL form (discord.gg, discord.com/invite, dsc.gg,
 * …) in any casing; returns the lowercase code, or null when unparseable
 * (callers fail open and preserve legacy behavior for such inputs). */
/** Legacy compatibility candidate built from a trail-level foundInvite when
 * no structured candidate exists. Shared by the admission decision and the
 * persistence path so both agree on shape. */
export function buildLegacyDiscordCandidate(foundInvite:string,legacyCode:string|null):DiscordCandidate|null{
  if(!foundInvite)return null;
  // Unparseable legacy values are prose/fragments, not invite codes. They must
  // not become candidates: only shapes that canonicalize are admissible.
  if(!legacyCode)return null;
  const rawCode=extractDiscordInviteCodeRaw(foundInvite)||foundInvite;
  return {candidateId:`legacy:${foundInvite}`,locatorType:'NATIVE_INVITE',sourceSurface:'CHANNEL_EXTERNAL_LINKS',rawLocator:foundInvite,nativeInviteCode:rawCode,normalizedLocator:`https://discord.gg/${legacyCode}`,extractionConfidence:'EXPLICIT'};
}
export interface AdmittedDiscordCandidates {
  candidates:DiscordCandidate[];
  discoveredInvite:string|null;
  discardedCount:number;
}
/**
 * A Discord invite code, canonicalized: zero-width/format characters stripped,
 * outer whitespace trimmed, and then validated against the actual invite-code
 * alphabet. Punctuation and arbitrary prose are rejected rather than lowercased
 * into a registry claim (`abc123.` is not code `abc123.`).
 */
export function sanitizeDiscordInviteCode(value:string|null|undefined):string|null{
  const code=String(value??'').replace(/[\u200B-\u200D\uFEFF\u2060]/g,'').trim();
  return /^[A-Za-z0-9_-]{2,128}$/.test(code)?code:null;
}
// Host boundary: the host token must not be embedded inside another domain,
// path, or word. `example.com/discord.gg/x` and `notdiscord.gg/x` are not
// Discord invite references; a query/redirect parameter is likewise not a
// direct invite. The same boundary is used by every URL-form extractor.
// Prose punctuation (including a colon after "Discord") may precede a direct
// invite, but a scheme colon must not let the protocol-relative branch match
// inside `https://` or another redirect URL. The second lookbehind rejects a
// match beginning at `//` directly after a URL scheme; the same invite is
// still matched from its host or `https://` start when the preceding token is
// prose.
const INVITE_HOST_BOUNDARY='(?<![\\w.\\-\\/?&#=])(?<!(?:https?|ftp|file|javascript):)';
const INVITE_PROTOCOL='(?:(?:https?:)?\\/\\/)?(?:www\\.)?';
const NATIVE_INVITE_HOST='(?:discord\\.gg|discord\\.com\\/invite|discordapp\\.com\\/invite|discord\\.app\\/invite)';
const ALTERNATIVE_INVITE_HOST='(?:dsc\\.gg|discord\\.me|discord\\.io)';
// The code capture must end at a real token boundary: a longer
// code-alphabet run is not an invite (`a`×129 must not truncate to `a`×128).
const INVITE_CODE_CAPTURE='([A-Za-z0-9_-]{2,128})(?![A-Za-z0-9_-])';
// Inline/void tags used by "protect link" markup. Block tags are excluded so
// ordinary page structure cannot become an invite. Optional trailing slash
// handles XHTML/self-closing forms such as `<br />`.
const INLINE_TAG_PATTERN='<\\/?(?:span|b|i|strong|em|small|wbr|br|a|u|mark|font)(?:\\s[^>]{0,120})?\\s*\\/?>';
const TAG_FRAGMENT_REJOIN:Array<[RegExp,string]>=[
  [new RegExp(`\\bdisc\\s*${INLINE_TAG_PATTERN}\\s*ord`,'gi'),'discord'],
  [new RegExp(`discord\\s*${INLINE_TAG_PATTERN}\\s*\\.\\s*gg`,'gi'),'discord.gg'],
  // Consume an optional closing inline tag after the slash before the code.
  [new RegExp(`discord\\.gg\\s*${INLINE_TAG_PATTERN}\\s*\\/\\s*(?:${INLINE_TAG_PATTERN}\\s*)?`,'gi'),'discord.gg/'],
];

/** Decode the bounded obfuscation forms that still name a real invite:
 * escaped slashes/colons/percent forms, numeric HTML entities, zero-width
 * format characters, and bracketed dot separators (`discord[.]gg`). Only
 * Discord-shaped tokens are rewritten; arbitrary text is never transformed.
 * `%2D` is decoded because hyphen is part of the invite-code alphabet: without
 * it, a URL such as `discord.gg/abc%2D123` is captured as the truncated code
 * `abc`. Hyphen is not a host/path boundary character, so this cannot create a
 * new host match, and plain string replacement cannot throw on malformed
 * percent sequences (unlike decodeURIComponent). */
export function decodeInviteObfuscation(text:string):string{
  let decoded=String(text||'')
    .replace(/[\u200B-\u200D\uFEFF\u2060]/g,'')
    .replace(/\\\/|\\u002f/gi,'/')
    .replace(/\\u002e/gi,'.')
    .replace(/\\u003a/gi,':')
    .replace(/\\u0026/gi,'&')
    .replace(/&period;/gi,'.')
    .replace(/&#x0*2e;|&#0*46;/gi,'.')
    .replace(/&#x0*3a;|&#0*58;/gi,':')
    .replace(/&#x0*2f;|&#0*47;/gi,'/')
    .replace(/&#x0*26;|&#0*38;/gi,'&');
  // Bounded tag-fragment rejoin: `disc<span>ord</span>.gg/CODE` and
  // `discord<span>.gg</span>/CODE` are common "protect link" patterns. The
  // tag body is capped so a hostile document cannot turn this into an
  // unbounded HTML parser inside extraction.
  for(const [pattern,replacement] of TAG_FRAGMENT_REJOIN)decoded=decoded.replace(pattern,replacement);
  decoded=decoded
    .replace(/discord\s+dot\s+(gg|com|app)/gi,'discord.$1')
    .replace(/discord\s*[\[(]\s*[.·•]\s*[\])]\s*gg/gi,'discord.gg')
    .replace(/discord\s*[\[(]\s*dot\s*[\])]\s*gg/gi,'discord.gg')
    .replace(/discord\s*[\[(]\s*[.·•]\s*[\])]\s*(com|app)/gi,'discord.$1');
  // Two bounded percent passes decode double-encoded forms (`%252F` -> `%2F`
  // -> `/`) without unbounded recursive decoding. `%25` must run first in each
  // pass so the exposed escape is decoded in the same pass.
  for(let pass=0;pass<2;pass++){
    const next=decoded
      .replace(/%25/gi,'%')
      .replace(/%2f/gi,'/')
      .replace(/%3a/gi,':')
      .replace(/%2d/gi,'-')
      .replace(/%2e/gi,'.')
      .replace(/%26/gi,'&');
    if(next===decoded)break;
    decoded=next;
  }
  return decoded;
}
/** Canonical invite code shared by every layer that must agree on Discord
 * invite identity (registry claims, choke-point filtering, tests). Accepts a
 * bare code or any Discord URL form (discord.gg, discord.com/invite, dsc.gg,
 * …) in any casing; returns the raw code, or null when unparseable. */
export function extractDiscordInviteCodeRaw(value:string|null|undefined):string|null{
  const text=decodeInviteObfuscation(String(value||'')).trim();
  if(!text)return null;
  const urlForm=new RegExp(`${INVITE_HOST_BOUNDARY}${INVITE_PROTOCOL}(?:${NATIVE_INVITE_HOST}|${ALTERNATIVE_INVITE_HOST})\\/${INVITE_CODE_CAPTURE}`,'i');
  const match=text.match(urlForm);
  if(match)return sanitizeDiscordInviteCode(match[1]);
  // Bare values are accepted only when the whole token is a valid invite-code
  // shape. Prose, punctuation, and URL fragments fail closed here; legacy
  // production values were URL-derived codes, so this preserves recovery.
  return sanitizeDiscordInviteCode(text);
}
/** Canonical invite code shared by every layer that must agree on Discord
 * invite identity (registry claims, choke-point filtering, tests): the
 * lowercase form of the extracted code, or null when unparseable (callers
 * fail open and preserve legacy behavior for such inputs). */
export function discordInviteCodeOf(value:string|null|undefined):string|null{
  const raw=extractDiscordInviteCodeRaw(value);
  return raw?raw.toLowerCase():null;
}
/**
 * Pure admission decision for the global canonical-discard choke point.
 * Given already-resolved registry claims, partitions structured candidates
 * into admitted ones and computes the discovered invite, suppressing the
 * legacy foundInvite fallback when it names a discarded (globally known)
 * code so it cannot resurrect the duplicate downstream. Unparseable values
 * fail open (admitted) to preserve legacy behavior. No I/O.
 */
export function admitDiscordCandidates(
  structured:DiscordCandidate[],
  foundInvite:string|null|undefined,
  admittedCodes:Set<string>,
):AdmittedDiscordCandidates{
  const admitted=structured.filter(candidate=>{const code=discordInviteCodeOf(candidate.nativeInviteCode);return !code||admittedCodes.has(code);});
  let legacy:DiscordCandidate|null=null;
  if(!admitted.length&&foundInvite){
    const legacyCode=discordInviteCodeOf(foundInvite);
    if(!legacyCode){
      legacy=buildLegacyDiscordCandidate(foundInvite,null);
    }else if(admittedCodes.has(legacyCode)){
      legacy=buildLegacyDiscordCandidate(foundInvite,legacyCode);
    }
  }
  const candidates=legacy?[...admitted,legacy]:admitted;
  const discardedCount=structured.length-admitted.length;
  return {candidates,discoveredInvite:candidates.find(candidate=>candidate.nativeInviteCode)?.nativeInviteCode||null,discardedCount};
}
const candidate=(value:Omit<DiscordCandidate,'candidateId'>):DiscordCandidate=>{
  const canonicalInviteId=value.nativeInviteCode?canonicalDiscordInviteId(value.nativeInviteCode):undefined;
  const observation:DiscordCandidateObservation={sourceSurface:value.sourceSurface,sourceUrl:value.sourceUrl,rawLocator:value.rawLocator,sourcePageUrl:value.sourceUrl,extractionConfidence:value.extractionConfidence};
  // A native invite is one logical candidate regardless of which creator
  // surface emitted it. Provenance belongs in observations, not in identity.
  const candidateId=id(canonicalInviteId?{canonicalInviteId}:{locatorType:value.locatorType,rawLocator:value.rawLocator.toLowerCase()});
  return {...value,canonicalInviteId,observations:value.observations?.length?value.observations:[observation],candidateId};
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
  else if(surfaces.has('PINNED_COMMENT')){score+=70;reasons.push('DIRECT_PINNED_COMMENT');}
  else if(surfaces.has('RECENT_VIDEO_DESCRIPTIONS')){score+=65;reasons.push('DIRECT_CREATOR_VIDEO');}
  else if(surfaces.has('SOCIAL_PROFILES')){score+=55;reasons.push('CREATOR_SOCIAL_SURFACE');}
  else if(surfaces.has('CREATOR_WEBSITES')){score+=40;reasons.push('LINKED_WEBSITE_SURFACE');}
  else if(surfaces.has('YOUTUBE_PLAYLIST_ITEMS')){score+=0;reasons.push('CURATED_PLAYLIST_ITEM');}
  else if(surfaces.has('YOUTUBE_COMMENTS')){score+=0;reasons.push('VIEWER_COMMENT_SURFACE');}

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
      // A canonical-domain match corroborates ownership but can never decide it
      // alone: a channel link proves reference, not ownership (a linked broker,
      // tool, docs or sponsor page is a third-party surface). +30 keeps a
      // 40-base website invite below the 75 gate unless brand (+35) or
      // cross-surface (+15) corroboration is also present. No break here
      // (unlike the branches below): brand/social identity may still corroborate
      // the same host. Awarded at most once.
      if(!reasons.includes('CREATOR_CANONICAL_DOMAIN')&&input.creatorWebsiteHosts?.some(candidateHost=>host===candidateHost||host.endsWith(`.${candidateHost}`))){score+=30;reasons.push('CREATOR_CANONICAL_DOMAIN');}
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

/**
 * Detect distinct raw invite codes that collapse under the lowercase
 * canonical identity. This is telemetry/correctness evidence, not an
 * admission decision: the registry is still keyed by the lowercase canonical
 * code, so a true collision needs a schema-level case-preserving claim.
 * Zero case-variant collisions were observed in the production sample; the
 * detector makes any future occurrence visible instead of silently merging.
 */
export interface DiscordInviteCaseCollision {canonicalCode:string;codes:string[]}
export function detectDiscordInviteCaseCollisions(items:DiscordCandidate[]):DiscordInviteCaseCollision[]{
  const byCanonical=new Map<string,Set<string>>();
  const add=(code:string|null|undefined)=>{
    if(!code)return;
    const canonical=discordInviteCodeOf(code);
    if(!canonical)return;
    if(!byCanonical.has(canonical))byCanonical.set(canonical,new Set());
    byCanonical.get(canonical)!.add(code);
  };
  for(const item of items){
    add(item.nativeInviteCode);
    // A merged candidate keeps observations from both surfaces. Inspect raw
    // locators too, because mergeDiscordCandidates collapses the candidate
    // native code before this detector runs.
    for(const observation of item.observations||[])add(extractDiscordInviteCodeRaw(observation.rawLocator));
  }
  return [...byCanonical.entries()]
    .filter(([,codes])=>codes.size>1)
    .map(([canonicalCode,codes])=>({canonicalCode,codes:[...codes]}));
}

const UNOWNED_SURFACES = new Set<AcquisitionSurface>(['YOUTUBE_COMMENTS', 'YOUTUBE_PLAYLIST_ITEMS']);

/** True when every observation comes from a surface the creator does not
 * control. These candidates may be useful context but must not make an
 * irreversible global registry claim before creator ownership is established. */
export function isUnownedSurfaceDiscordCandidate(candidate: DiscordCandidate): boolean {
  const observations = candidate.observations?.length
    ? candidate.observations
    : [{ sourceSurface: candidate.sourceSurface }];
  return observations.length > 0 && observations.every(observation => UNOWNED_SURFACES.has(observation.sourceSurface));
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

function rot13Text(value:string):string{
  return value.replace(/[a-z]/gi,char=>{
    const code=char.charCodeAt(0);
    const base=code>=97?97:65;
    return String.fromCharCode(base+((code-base+13)%26));
  });
}

/**
 * Bounded Base64 decoding. Only printable decoded payloads that explicitly
 * contain `discord` are retained; arbitrary binary/token noise is discarded.
 * The token cap prevents a hostile page from turning one extraction call into
 * an unbounded decoder.
 */
function boundedBase64Variants(text:string):string[]{
  const out:string[]=[];
  const tokenPattern=/[A-Za-z0-9+/_-]{16,2048}={0,2}/g;
  let match:RegExpExecArray|null;
  let examined=0;
  while((match=tokenPattern.exec(text))!==null&&examined<64){
    examined++;
    const token=match[0].replace(/-/g,'+').replace(/_/g,'/');
    try{
      const decoded=Buffer.from(token,'base64').toString('utf8');
      // Allow UTF-8 letters/punctuation; reject binary/control payloads and
      // replacement-character noise rather than requiring ASCII.
      const hasControl=/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD]/.test(decoded);
      if(/discord/i.test(decoded)&&!hasControl)out.push(decoded);
    }catch{/* malformed base64 is ignored */ }
  }
  return out;
}

export function extractDiscordCandidates(text:string,sourceSurface:AcquisitionSurface='CHANNEL_EXTERNAL_LINKS',sourceUrl?:string):DiscordCandidate[]{
  if(!text)return [];
  const clean=decodeInviteObfuscation(text);
  const found:DiscordCandidate[]=[];
  // Copy regexp captures before they escape extraction: V8 represents slices
  // of a large subject string as SlicedString views that keep the whole
  // subject alive. The rendered crawler scans full page snapshots and drops
  // the HTML immediately, so an un-copied rawLocator would pin every
  // invite-bearing snapshot until the crawl completes.
  const detach=(value:string):string=>Buffer.from(value,'utf8').toString('utf8');
  const push=(rawLocator:string,locatorType:DiscordLocatorType,code:string|undefined,confidence:'EXPLICIT'|'RESOLVED'|'HEURISTIC')=>{
    if(code&&(code.length<2||code.length>128||RESERVED_DISCORD_ROUTE_CODES.has(code.toLowerCase())))return;
    const ownLocator=detach(rawLocator);
    const ownCode=code===undefined?undefined:detach(code);
    const value=candidate({locatorType,sourceSurface,rawLocator:ownLocator,nativeInviteCode:ownCode,normalizedLocator:ownCode?`https://discord.gg/${ownCode}`:undefined,sourceUrl,extractionConfidence:confidence});
    if(!found.some(item=>item.candidateId===value.candidateId))found.push(value);
  };
  const scan=(value:string,locatorType:DiscordLocatorType,confidence:'EXPLICIT'|'RESOLVED'|'HEURISTIC')=>{
    const native=new RegExp(`${INVITE_HOST_BOUNDARY}${INVITE_PROTOCOL}${NATIVE_INVITE_HOST}\\/${INVITE_CODE_CAPTURE}`,'gi');
    for(let match;(match=native.exec(value))!==null;){const code=sanitizeDiscordInviteCode(match[1]);if(code)push(match[0],locatorType,code,confidence);}
    const alternative=new RegExp(`${INVITE_HOST_BOUNDARY}${INVITE_PROTOCOL}${ALTERNATIVE_INVITE_HOST}\\/${INVITE_CODE_CAPTURE}`,'gi');
    for(let match;(match=alternative.exec(value))!==null;)push(match[0],'ALTERNATIVE_REDIRECT',undefined,confidence);
    const directory=new RegExp(`${INVITE_HOST_BOUNDARY}${INVITE_PROTOCOL}disboard\\.org\\/server\\/${INVITE_CODE_CAPTURE}`,'gi');
    for(let match;(match=directory.exec(value))!==null;)push(match[0],'DIRECTORY_PAGE',undefined,confidence);
  };
  scan(clean,'NATIVE_INVITE','EXPLICIT');
  // ROT13 is only worth scanning when the source contains the rotated Discord
  // marker (`qvfpbeq`); this avoids an O(n) transform on ordinary pages.
  if(/qvfpbeq/i.test(clean)){
    const rotated=rot13Text(clean);
    if(/discord/i.test(rotated))scan(rotated,'OBFUSCATED_NATIVE','RESOLVED');
  }
  for(const decoded of boundedBase64Variants(clean))scan(decoded,'OBFUSCATED_NATIVE','RESOLVED');
  return found;
}

export function candidateFromNativeInvite(input:{
  nativeInviteCode:string;
  sourceSurface:AcquisitionSurface;
  sourceUrl?:string;
  rawLocator?:string;
  extractionConfidence?:DiscordCandidate['extractionConfidence'];
}):DiscordCandidate|null{
  const code=sanitizeDiscordInviteCode(input.nativeInviteCode);
  if(!code||RESERVED_DISCORD_ROUTE_CODES.has(code.toLowerCase()))return null;
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
