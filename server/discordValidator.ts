import { DiscordStatus, type TradingStatus } from '../src/types';
import { executeProviderCall, type ProviderCallError } from './providerResilience';
import { appendProviderCallEvent } from './db';
import type {DiscordOwnershipStatus} from './discordCandidates';

export interface DiscordEvidenceCoverage {
  inviteMetadata:'COMPLETED'|'FAILED';
  inviteWelcomeScreen:'PRESENT'|'ABSENT';
  publicWelcomeScreen:'NOT_ATTEMPTED'|'COMPLETED'|'UNAVAILABLE'|'FAILED';
  publicWidget:'NOT_ATTEMPTED'|'COMPLETED'|'UNAVAILABLE'|'FAILED';
  publicEvidenceRequests:number;
}

export interface DiscordValidationResult {
  status: DiscordStatus;
  confidence: number;
  inviteUrl: string | null;
  guildName?: string;
  approximateMemberCount?: number;
  approximatePresenceCount?: number;
  relevanceReason?: string;
  evidenceCoverage?:DiscordEvidenceCoverage;
  candidateInviteUrl: string;
  operationalOutcome: DiscordOperationalOutcome;
  retryable: boolean;
  attempts: DiscordCheckAttempt[];
  livenessStatus:'ACTIVE'|'INVALID_OBSERVED'|'DEAD'|'UNCERTAIN';
  relevanceStatus:'TRADING_RELEVANT'|'NON_TRADING'|'UNCERTAIN'|'NOT_CHECKED';
  resolutionStatus:'RESOLVED'|'UNRESOLVED';
  validationStatus:'RETRY_PENDING'|'SUCCEEDED'|'FAILED_OPERATIONAL'|'COMPLETED';
}

export type DiscordOperationalOutcome = 'SUCCEEDED'|'INVALID_OBSERVED'|'CONFIRMED_INVALID'|'RATE_LIMITED'|'TIMEOUT'|'NETWORK_FAILURE'|'AUTHENTICATION_FAILURE'|'PROVIDER_FAILURE'|'MALFORMED_RESPONSE'|'INVALID_LOCATOR';
export interface DiscordCheckAttempt {attemptNumber:number;operationalOutcome:DiscordOperationalOutcome;retryable:boolean;httpStatus?:number;providerErrorClass?:string;providerErrorCode?:number;responseContentType?:string;reason:string;checkedAt:string}

export interface DiscordParentContext {
  tradingStatus?: TradingStatus;
  tradingConfidence?: number;
  tradingCategory?: string;
  creatorName?: string;
  country?: string;
  sourceSurface?: string;
  ownershipStatus?: DiscordOwnershipStatus;
  ownershipConfidence?: number;
}

export interface DiscordValidationOptions {
  parentChannelIsTrading?: boolean;
  channelName?: string;
  parentContext?: DiscordParentContext;
  maxAttempts?: number;
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
  emitProviderEvent?: typeof appendProviderCallEvent;
  priorInvalidObservations?: number;
  /** Maximum additional public Discord requests after a successful invite lookup. */
  publicEvidenceMaxRequests?:number;
}

const TRADING_RELEVANCE_KEYWORDS = [
  'trading','trader','trade','trades','forex','futures','stock','stocks','orderflow','order flow','crypto','bitcoin','btc','eth','solana',
  'analysis','signal','signals','market','markets','invest','investing','chart','charts','price action','smc','smart money','prop firm','ftmo','funding',
  'equity','equities','options','option','dax','sp500','nasdaq','ftse','cac','aex','bourse','bolsa','börse','scalp','scalping','daytrade','daytrader',
  'swing','liquidity','volume','footprint','macro','finance','financial','börsenanalyse','technical analysis','pnl','lot size','pip','pips','market structure',
  'risk management','trade review','live execution','vwap','dom','market profile','tpo','wyckoff','imbalance','fvg','fair value gap','liquidity sweep',
  'liquidity grab','funded account','funded trader'
];

const EXPLICIT_NON_TRADING_KEYWORDS = [
  'gaming','minecraft','roblox','fortnite','valorant','csgo','counter strike','league of legends','gta','anime','manga','roleplay','rp server','music',
  'dj lounge','meme','memes','homework','study group','nsfw','dating','chill lounge','hangout spot','airdrop bot','free nitro','giveaway bot'
];

const matchedTerms=(text:string,terms:string[])=>terms.filter(term=>text.includes(term));
const coverageSummary=(coverage:DiscordEvidenceCoverage)=>`coverage(invite=${coverage.inviteMetadata}, welcome=${coverage.inviteWelcomeScreen}/${coverage.publicWelcomeScreen}, widget=${coverage.publicWidget})`;

function creatorAssociationContext(options?:DiscordValidationOptions){
  const ctx=options?.parentContext;
  const parentConfirmed=ctx?.tradingStatus==='TRADING_CONFIRMED'||options?.parentChannelIsTrading===true;
  const tradingConfidence=Number(ctx?.tradingConfidence ?? (parentConfirmed ? 80 : 0));
  const ownershipStatus=ctx?.ownershipStatus;
  const ownershipConfidence=Number(ctx?.ownershipConfidence||0);
  const creatorOwned=ownershipStatus==='CREATOR_OWNED'&&ownershipConfidence>=70;
  const creatorText=[ctx?.creatorName||options?.channelName||'',ctx?.tradingCategory||''].filter(Boolean).join(' ').toLowerCase();
  const parentTerms=matchedTerms(creatorText,TRADING_RELEVANCE_KEYWORDS);
  const strongParent=parentConfirmed&&tradingConfidence>=80;
  return {parentConfirmed,tradingConfidence,ownershipStatus,ownershipConfidence,creatorOwned,parentTerms,strongParent};
}

function welcomeScreenText(welcome:any):string{
  if(!welcome)return '';
  const channelDescriptions=Array.isArray(welcome.welcome_channels)?welcome.welcome_channels.map((item:any)=>item?.description||''):[];
  return [welcome.description||'',...channelDescriptions].filter(Boolean).join(' ');
}

async function fetchPublicEvidence(input:{
  guildId?:string;
  existingWelcome:any;
  fetchImpl:typeof fetch;
  emit:typeof appendProviderCallEvent;
  maxRequests:number;
}):Promise<{text:string;coverage:Pick<DiscordEvidenceCoverage,'publicWelcomeScreen'|'publicWidget'|'publicEvidenceRequests'>}>{
  const coverage:{publicWelcomeScreen:DiscordEvidenceCoverage['publicWelcomeScreen'];publicWidget:DiscordEvidenceCoverage['publicWidget'];publicEvidenceRequests:number}={publicWelcomeScreen:'NOT_ATTEMPTED',publicWidget:'NOT_ATTEMPTED',publicEvidenceRequests:0};
  if(!input.guildId||input.maxRequests<=0)return {text:'',coverage};
  const pieces:string[]=[];
  const call=async(operation:string,url:string)=>executeProviderCall({
    context:{provider:'discord',operation,attempt:1},
    timeoutMs:Number(process.env.DISCORD_PROVIDER_TIMEOUT_MS||'15000'),
    enabled:process.env.PROVIDER_DEADLINES_ENABLED==='true',
    emit:input.emit,
    call:signal=>input.fetchImpl(url,{signal,headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}})
  });

  if(!input.existingWelcome&&coverage.publicEvidenceRequests<input.maxRequests){
    coverage.publicEvidenceRequests++;
    try{
      const res=await call('welcome-screen',`https://discord.com/api/v10/guilds/${encodeURIComponent(input.guildId)}/welcome-screen`);
      if(res.ok){const body=await res.json();pieces.push(welcomeScreenText(body));coverage.publicWelcomeScreen='COMPLETED';}
      else coverage.publicWelcomeScreen=[401,403,404].includes(res.status)?'UNAVAILABLE':'FAILED';
    }catch{coverage.publicWelcomeScreen='FAILED';}
  }

  if(coverage.publicEvidenceRequests<input.maxRequests){
    coverage.publicEvidenceRequests++;
    try{
      const res=await call('public-widget',`https://discord.com/api/v10/guilds/${encodeURIComponent(input.guildId)}/widget.json`);
      if(res.ok){
        const body=await res.json();
        const channelNames=Array.isArray(body?.channels)?body.channels.map((item:any)=>item?.name||''):[];
        pieces.push(body?.name||'',...channelNames);
        coverage.publicWidget='COMPLETED';
      }else coverage.publicWidget=[401,403,404].includes(res.status)?'UNAVAILABLE':'FAILED';
    }catch{coverage.publicWidget='FAILED';}
  }
  return {text:pieces.filter(Boolean).join(' '),coverage};
}

export async function validateDiscordInvite(inviteCode:string, options?:DiscordValidationOptions):Promise<DiscordValidationResult> {
  const cleanCode=inviteCode.replace(/^[\\/]+/,'').replace(/.*(?:discord\.gg|discord\.com\/invite|discordapp\.com\/invite|discord\.app\/invite)\//i,'').split(/[\?\#\/]/)[0].trim();
  const RESERVED_WORDS=['channels','guilds','store','download','nitro','login','register','api','widget','terms','privacy','branding','jobs','before','after','next','prev','index','home','about','contact','faq','support','invite','oauth2','template'];
  const candidateInviteUrl=cleanCode?`https://discord.gg/${cleanCode}`:inviteCode;
  const attempts:DiscordCheckAttempt[]=[];
  const result=(value:Omit<DiscordValidationResult,'candidateInviteUrl'|'attempts'>):DiscordValidationResult=>({...value,candidateInviteUrl,attempts});
  if(!cleanCode||cleanCode.length<2||RESERVED_WORDS.includes(cleanCode.toLowerCase())){
    attempts.push({attemptNumber:1,operationalOutcome:'INVALID_LOCATOR',retryable:false,reason:'Invalid or reserved invite code',checkedAt:new Date().toISOString()});
    return result({status:'UNCERTAIN',confidence:0,inviteUrl:null,relevanceReason:'Invalid or reserved invite code',operationalOutcome:'INVALID_LOCATOR',retryable:false,livenessStatus:'UNCERTAIN',relevanceStatus:'NOT_CHECKED',resolutionStatus:'UNRESOLVED',validationStatus:'COMPLETED'});
  }

  const maxAttempts=Math.min(5,Math.max(1,options?.maxAttempts||3));
  const fetchImpl=options?.fetchImpl||fetch;
  const emit=options?.emitProviderEvent||appendProviderCallEvent;
  for(let attemptNumber=1;attemptNumber<=maxAttempts;attemptNumber++)try{
    const apiUrl=`https://discord.com/api/v9/invites/${encodeURIComponent(cleanCode)}?with_counts=true`;
    const res=await executeProviderCall({context:{provider:'discord',operation:'invite-lookup',attempt:attemptNumber},timeoutMs:Number(process.env.DISCORD_PROVIDER_TIMEOUT_MS||'15000'),enabled:process.env.PROVIDER_DEADLINES_ENABLED==='true',emit,call:signal=>fetchImpl(apiUrl,{signal,headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}})});
    if(!res.ok){
      let discordErrorCode:number|undefined;try{const body=await res.clone().json();discordErrorCode=Number(body?.code)||undefined;}catch{}
      const expectedInvalid=res.status===404&&discordErrorCode===10006;
      const prior=Math.max(0,options?.priorInvalidObservations||0);
      const outcome:DiscordOperationalOutcome=expectedInvalid?(prior>=1?'CONFIRMED_INVALID':'INVALID_OBSERVED'):res.status===429?'RATE_LIMITED':[401,403].includes(res.status)?'AUTHENTICATION_FAILURE':res.status>=500?'PROVIDER_FAILURE':'PROVIDER_FAILURE';
      const retryable=outcome==='RATE_LIMITED'||(outcome==='PROVIDER_FAILURE'&&(res.status>=500||res.status===404));
      const reason=outcome==='CONFIRMED_INVALID'?'Discord invalid-invite response was confirmed by a separate durable observation':outcome==='INVALID_OBSERVED'?'Discord reported an invalid invite; terminal confirmation is pending':`Discord invite lookup returned HTTP ${res.status}`;
      const effectiveRetryable=outcome==='INVALID_OBSERVED'||retryable;
      attempts.push({attemptNumber,operationalOutcome:outcome,retryable:effectiveRetryable,httpStatus:res.status,providerErrorCode:discordErrorCode,responseContentType:res.headers.get('content-type')||undefined,reason,checkedAt:new Date().toISOString()});
      if(outcome==='CONFIRMED_INVALID')return result({status:'DEAD',confidence:100,inviteUrl:null,relevanceReason:reason,operationalOutcome:outcome,retryable:false,livenessStatus:'DEAD',relevanceStatus:'NOT_CHECKED',resolutionStatus:'RESOLVED',validationStatus:'COMPLETED'});
      if(outcome==='INVALID_OBSERVED')return result({status:'UNCERTAIN',confidence:0,inviteUrl:null,relevanceReason:reason,operationalOutcome:outcome,retryable:true,livenessStatus:'INVALID_OBSERVED',relevanceStatus:'NOT_CHECKED',resolutionStatus:'RESOLVED',validationStatus:'RETRY_PENDING'});
      if(retryable&&attemptNumber<maxAttempts){await new Promise(resolve=>setTimeout(resolve,(options?.retryDelayMs??250)*2**(attemptNumber-1)));continue;}
      return result({status:'UNCERTAIN',confidence:0,inviteUrl:null,relevanceReason:reason,operationalOutcome:outcome,retryable,livenessStatus:'UNCERTAIN',relevanceStatus:'NOT_CHECKED',resolutionStatus:'RESOLVED',validationStatus:retryable?'RETRY_PENDING':'FAILED_OPERATIONAL'});
    }

    const data=await res.json();
    if(data&&(data.guild||data.code)){
      attempts.push({attemptNumber,operationalOutcome:'SUCCEEDED',retryable:false,httpStatus:res.status,responseContentType:res.headers.get('content-type')||undefined,reason:'Discord invite metadata retrieved',checkedAt:new Date().toISOString()});
      const memberCount=data.approximate_member_count||0;
      const presenceCount=data.approximate_presence_count||0;
      const guildName=data.guild?.name||'';
      const guildDescription=data.guild?.description||'';
      const inviteChannelName=data.channel?.name||'';
      const inviteWelcome=data.guild?.welcome_screen;
      const inviteWelcomeText=welcomeScreenText(inviteWelcome);
      const actualCode=data.code||cleanCode;
      const canonicalInviteUrl=`https://discord.gg/${actualCode}`;
      const coverage:DiscordEvidenceCoverage={inviteMetadata:'COMPLETED',inviteWelcomeScreen:inviteWelcomeText?'PRESENT':'ABSENT',publicWelcomeScreen:'NOT_ATTEMPTED',publicWidget:'NOT_ATTEMPTED',publicEvidenceRequests:0};
      const association=creatorAssociationContext(options);

      let discordNativeText=[guildName,guildDescription,inviteChannelName,inviteWelcomeText].filter(Boolean).join(' ').toLowerCase();
      let matchedTrading=matchedTerms(discordNativeText,TRADING_RELEVANCE_KEYWORDS);
      let matchedNegative=matchedTerms(discordNativeText,EXPLICIT_NON_TRADING_KEYWORDS);

      // Explicit unrelated Discord-native evidence is authoritative. Do not spend
      // more public requests trying to overturn a clear unrelated server.
      if(!(matchedNegative.length>0&&matchedTrading.length===0)&&matchedTrading.length===0){
        const enrichment=await fetchPublicEvidence({guildId:String(data.guild?.id||''),existingWelcome:inviteWelcome,fetchImpl,emit,maxRequests:Math.min(2,Math.max(0,options?.publicEvidenceMaxRequests??2))});
        coverage.publicWelcomeScreen=enrichment.coverage.publicWelcomeScreen;
        coverage.publicWidget=enrichment.coverage.publicWidget;
        coverage.publicEvidenceRequests=enrichment.coverage.publicEvidenceRequests;
        if(enrichment.text){
          discordNativeText=`${discordNativeText} ${enrichment.text}`.toLowerCase();
          matchedTrading=matchedTerms(discordNativeText,TRADING_RELEVANCE_KEYWORDS);
          matchedNegative=matchedTerms(discordNativeText,EXPLICIT_NON_TRADING_KEYWORDS);
        }
      }

      let confidence=20;
      if(association.parentConfirmed)confidence+=20;
      if(association.tradingConfidence>=90)confidence+=10;else if(association.tradingConfidence>=80)confidence+=5;
      if(matchedTrading.length>=2)confidence+=50;else if(matchedTrading.length===1)confidence+=35;
      if(memberCount>=50)confidence+=5;
      if(association.creatorOwned)confidence+=20;
      if(association.creatorOwned&&association.parentTerms.length>0)confidence+=10;
      if(matchedNegative.length>0)confidence-=matchedNegative.length*35;
      confidence=Math.max(0,Math.min(99,confidence));

      if(matchedNegative.length>0&&matchedTrading.length===0){
        return result({status:'NON_TRADING',confidence,inviteUrl:null,guildName:guildName||'Discord Server',approximateMemberCount:memberCount,approximatePresenceCount:presenceCount,evidenceCoverage:coverage,relevanceReason:`Non-trading server detected from Discord-native/public metadata (matched: ${matchedNegative.join(', ')}; ${coverageSummary(coverage)})`,operationalOutcome:'SUCCEEDED',retryable:false,livenessStatus:'ACTIVE',relevanceStatus:'NON_TRADING',resolutionStatus:'RESOLVED',validationStatus:'SUCCEEDED'});
      }

      const strongCreatorAssociation=association.strongParent&&association.creatorOwned&&matchedNegative.length===0;
      const discordNativeConfirmation=matchedTrading.length>0&&confidence>=70;
      if(discordNativeConfirmation||strongCreatorAssociation){
        const status:DiscordStatus=memberCount>=50?'ACTIVE':'ACTIVE_LOW_VOLUME';
        const reason=discordNativeConfirmation
          ?`Confirmed trading community from Discord-native/public evidence (Confidence: ${confidence}%, Matched: ${matchedTrading.slice(0,4).join(', ')}; ${coverageSummary(coverage)})`
          :`Live community strongly associated with a ${association.tradingConfidence}% trading-confirmed creator via creator-owned source; public Discord evidence remained sparse and contained no contradictory signal; ${coverageSummary(coverage)}`;
        return result({status,confidence:Math.max(70,confidence),inviteUrl:canonicalInviteUrl,guildName:guildName||'Trading Discord',approximateMemberCount:memberCount,approximatePresenceCount:presenceCount,evidenceCoverage:coverage,relevanceReason:reason,operationalOutcome:'SUCCEEDED',retryable:false,livenessStatus:'ACTIVE',relevanceStatus:'TRADING_RELEVANT',resolutionStatus:'RESOLVED',validationStatus:'SUCCEEDED'});
      }

      return result({status:'UNCERTAIN',confidence,inviteUrl:null,guildName:guildName||'Discord Server',approximateMemberCount:memberCount,approximatePresenceCount:presenceCount,evidenceCoverage:coverage,relevanceReason:`Active community; relevance evidence remains insufficient (Confidence: ${confidence}%, ownership=${association.ownershipStatus||'unknown'}, Discord trading matches=${matchedTrading.length}; ${coverageSummary(coverage)})`,operationalOutcome:'SUCCEEDED',retryable:false,livenessStatus:'ACTIVE',relevanceStatus:'UNCERTAIN',resolutionStatus:'RESOLVED',validationStatus:'SUCCEEDED'});
    }

    const reason='Discord returned malformed guild data';attempts.push({attemptNumber,operationalOutcome:'MALFORMED_RESPONSE',retryable:true,reason,checkedAt:new Date().toISOString()});
    if(attemptNumber<maxAttempts){await new Promise(resolve=>setTimeout(resolve,(options?.retryDelayMs??250)*2**(attemptNumber-1)));continue;}
    return result({status:'UNCERTAIN',confidence:0,inviteUrl:null,relevanceReason:reason,operationalOutcome:'MALFORMED_RESPONSE',retryable:true,livenessStatus:'UNCERTAIN',relevanceStatus:'NOT_CHECKED',resolutionStatus:'RESOLVED',validationStatus:'RETRY_PENDING'});
  }catch(err:any){
    const typed=err as ProviderCallError;
    const outcome:DiscordOperationalOutcome=typed.errorClass==='TIMEOUT'?'TIMEOUT':typed.errorClass==='RATE_LIMIT'?'RATE_LIMITED':typed.errorClass==='PERMANENT_INPUT'?'PROVIDER_FAILURE':'NETWORK_FAILURE';
    const retryable=typed.retryable!==false;
    const reason=`Discord check failed: ${typed.message||String(err)}`;
    attempts.push({attemptNumber,operationalOutcome:outcome,retryable,httpStatus:typed.status,providerErrorClass:typed.errorClass,reason,checkedAt:new Date().toISOString()});
    if(retryable&&attemptNumber<maxAttempts){await new Promise(resolve=>setTimeout(resolve,(options?.retryDelayMs??250)*2**(attemptNumber-1)));continue;}
    return result({status:'UNCERTAIN',confidence:0,inviteUrl:null,relevanceReason:reason,operationalOutcome:outcome,retryable,livenessStatus:'UNCERTAIN',relevanceStatus:'NOT_CHECKED',resolutionStatus:'RESOLVED',validationStatus:retryable?'RETRY_PENDING':'FAILED_OPERATIONAL'});
  }
  return result({status:'UNCERTAIN',confidence:0,inviteUrl:null,relevanceReason:'Discord check attempts exhausted',operationalOutcome:'PROVIDER_FAILURE',retryable:true,livenessStatus:'UNCERTAIN',relevanceStatus:'NOT_CHECKED',resolutionStatus:'RESOLVED',validationStatus:'RETRY_PENDING'});
}
