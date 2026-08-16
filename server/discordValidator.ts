import { DiscordStatus, type TradingStatus } from '../src/types';
import { executeProviderCall, type ProviderCallError } from './providerResilience';
import { appendProviderCallEvent } from './db';
import type {DiscordOwnershipStatus} from './discordCandidates';

export interface DiscordValidationResult {
  status: DiscordStatus;
  confidence: number;
  inviteUrl: string | null;
  guildName?: string;
  approximateMemberCount?: number;
  approximatePresenceCount?: number;
  relevanceReason?: string;
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

/** Structured creator context is intentionally separate from Discord-native
 * metadata. It may support association/relevance, but is never injected into
 * the guild text as if Discord itself said it. */
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
  /** Backward-compatible prior. New callers should send parentContext. */
  parentChannelIsTrading?: boolean;
  channelName?: string;
  parentContext?: DiscordParentContext;
  maxAttempts?: number;
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
  emitProviderEvent?: typeof appendProviderCallEvent;
  priorInvalidObservations?: number;
}

const TRADING_RELEVANCE_KEYWORDS = [
  'trading', 'trader', 'trade', 'trades', 'forex', 'futures', 'stock', 'stocks',
  'orderflow', 'order flow', 'crypto', 'bitcoin', 'btc', 'eth', 'solana',
  'analysis', 'signal', 'signals', 'market', 'markets', 'invest', 'investing',
  'chart', 'charts', 'price action', 'smc', 'smart money', 'prop firm',
  'ftmo', 'funding', 'equity', 'equities', 'options', 'option',
  'dax', 'sp500', 'nasdaq', 'ftse', 'cac', 'aex', 'bourse', 'bolsa', 'börse',
  'scalp', 'scalping', 'daytrade', 'daytrader', 'swing', 'liquidity',
  'volume', 'footprint', 'macro', 'finance', 'financial', 'börsenanalyse',
  'technical analysis', 'pnl', 'lot size', 'pip', 'pips', 'market structure',
  'risk management', 'trade review', 'live execution', 'vwap', 'dom',
  'market profile', 'tpo', 'wyckoff', 'imbalance', 'fvg', 'fair value gap',
  'liquidity sweep', 'liquidity grab', 'funded account', 'funded trader'
];

const EXPLICIT_NON_TRADING_KEYWORDS = [
  'gaming', 'minecraft', 'roblox', 'fortnite', 'valorant', 'csgo', 'counter strike',
  'league of legends', 'gta', 'anime', 'manga', 'roleplay', 'rp server', 'music',
  'dj lounge', 'meme', 'memes', 'homework', 'study group', 'nsfw', 'dating',
  'chill lounge', 'hangout spot', 'airdrop bot', 'free nitro', 'giveaway bot'
];

const matchedTerms=(text:string,terms:string[])=>terms.filter(term=>text.includes(term));

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
  return {ctx,parentConfirmed,tradingConfidence,ownershipStatus,ownershipConfidence,creatorOwned,parentTerms,strongParent};
}

export async function validateDiscordInvite(inviteCode:string, options?:DiscordValidationOptions):Promise<DiscordValidationResult> {
  let cleanCode = inviteCode
    .replace(/^[\\/]+/, '')
    .replace(/.*(?:discord\.gg|discord\.com\/invite|discordapp\.com\/invite|discord\.app\/invite)\//i, '')
    .split(/[\?\#\/]/)[0]
    .trim();

  const RESERVED_WORDS = [
    'channels', 'guilds', 'store', 'download', 'nitro', 'login', 'register',
    'api', 'widget', 'terms', 'privacy', 'branding', 'jobs', 'before', 'after',
    'next', 'prev', 'index', 'home', 'about', 'contact', 'faq', 'support',
    'invite', 'oauth2', 'template'
  ];

  const candidateInviteUrl = cleanCode ? `https://discord.gg/${cleanCode}` : inviteCode;
  const attempts:DiscordCheckAttempt[]=[];
  const result=(value:Omit<DiscordValidationResult,'candidateInviteUrl'|'attempts'>):DiscordValidationResult=>({...value,candidateInviteUrl,attempts});
  if (!cleanCode || cleanCode.length < 2 || RESERVED_WORDS.includes(cleanCode.toLowerCase())) {
    attempts.push({attemptNumber:1,operationalOutcome:'INVALID_LOCATOR',retryable:false,reason:'Invalid or reserved invite code',checkedAt:new Date().toISOString()});
    return result({ status: 'UNCERTAIN', confidence: 0, inviteUrl: null, relevanceReason: 'Invalid or reserved invite code',operationalOutcome:'INVALID_LOCATOR',retryable:false,livenessStatus:'UNCERTAIN',relevanceStatus:'NOT_CHECKED',resolutionStatus:'UNRESOLVED',validationStatus:'COMPLETED' });
  }

  const maxAttempts=Math.min(5,Math.max(1,options?.maxAttempts||3)),fetchImpl=options?.fetchImpl||fetch,emit=options?.emitProviderEvent||appendProviderCallEvent;
  for(let attemptNumber=1;attemptNumber<=maxAttempts;attemptNumber++) try {
    const apiUrl = `https://discord.com/api/v9/invites/${encodeURIComponent(cleanCode)}?with_counts=true`;
    const res = await executeProviderCall({context:{provider:'discord',operation:'invite-lookup',attempt:attemptNumber},timeoutMs:Number(process.env.DISCORD_PROVIDER_TIMEOUT_MS||'15000'),enabled:process.env.PROVIDER_DEADLINES_ENABLED==='true',emit,call:signal=>fetchImpl(apiUrl, {signal,headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}})});

    if (!res.ok) {
      let discordErrorCode:number|undefined;try{const body=await res.clone().json();discordErrorCode=Number(body?.code)||undefined;}catch{}
      const expectedInvalid=res.status===404&&discordErrorCode===10006;
      const prior=Math.max(0,options?.priorInvalidObservations||0);
      const outcome:DiscordOperationalOutcome=expectedInvalid?(prior>=1?'CONFIRMED_INVALID':'INVALID_OBSERVED'):res.status===429?'RATE_LIMITED':[401,403].includes(res.status)?'AUTHENTICATION_FAILURE':res.status>=500?'PROVIDER_FAILURE':'PROVIDER_FAILURE';
      const retryable=outcome==='RATE_LIMITED'||(outcome==='PROVIDER_FAILURE'&&(res.status>=500||res.status===404));
      const reason=outcome==='CONFIRMED_INVALID'?'Discord invalid-invite response was confirmed by a separate durable observation':outcome==='INVALID_OBSERVED'?'Discord reported an invalid invite; terminal confirmation is pending':`Discord invite lookup returned HTTP ${res.status}`;
      const effectiveRetryable=outcome==='INVALID_OBSERVED'||retryable;
      attempts.push({attemptNumber,operationalOutcome:outcome,retryable:effectiveRetryable,httpStatus:res.status,providerErrorCode:discordErrorCode,responseContentType:res.headers.get('content-type')||undefined,reason,checkedAt:new Date().toISOString()});
      if(outcome==='CONFIRMED_INVALID')return result({ status:'DEAD',confidence:100,inviteUrl:null,relevanceReason:reason,operationalOutcome:outcome,retryable:false,livenessStatus:'DEAD',relevanceStatus:'NOT_CHECKED',resolutionStatus:'RESOLVED',validationStatus:'COMPLETED' });
      if(outcome==='INVALID_OBSERVED')return result({status:'UNCERTAIN',confidence:0,inviteUrl:null,relevanceReason:reason,operationalOutcome:outcome,retryable:true,livenessStatus:'INVALID_OBSERVED',relevanceStatus:'NOT_CHECKED',resolutionStatus:'RESOLVED',validationStatus:'RETRY_PENDING'});
      if(retryable&&attemptNumber<maxAttempts){await new Promise(resolve=>setTimeout(resolve,(options?.retryDelayMs??250)*2**(attemptNumber-1)));continue;}
      return result({status:'UNCERTAIN',confidence:0,inviteUrl:null,relevanceReason:reason,operationalOutcome:outcome,retryable,livenessStatus:'UNCERTAIN',relevanceStatus:'NOT_CHECKED',resolutionStatus:'RESOLVED',validationStatus:retryable?'RETRY_PENDING':'FAILED_OPERATIONAL'});
    }

    const data = await res.json();
    if (data && (data.guild || data.code)) {
      attempts.push({attemptNumber,operationalOutcome:'SUCCEEDED',retryable:false,httpStatus:res.status,responseContentType:res.headers.get('content-type')||undefined,reason:'Discord invite metadata retrieved',checkedAt:new Date().toISOString()});
      const memberCount = data.approximate_member_count || 0;
      const presenceCount = data.approximate_presence_count || 0;
      const guildName = data.guild?.name || '';
      const guildDescription = data.guild?.description || '';
      const inviteChannelName = data.channel?.name || '';
      const welcomeDesc = data.guild?.welcome_screen?.description || '';
      const actualCode = data.code || cleanCode;
      const canonicalInviteUrl = `https://discord.gg/${actualCode}`;

      // Only Discord-native metadata is semantic server evidence. Invite codes
      // and creator names are identifiers/context and must never masquerade as
      // statements made by the Discord community itself.
      const discordNativeText = [guildName, guildDescription, inviteChannelName, welcomeDesc].filter(Boolean).join(' ').toLowerCase();
      const matchedTrading = matchedTerms(discordNativeText,TRADING_RELEVANCE_KEYWORDS);
      const matchedNegative = matchedTerms(discordNativeText,EXPLICIT_NON_TRADING_KEYWORDS);
      const association=creatorAssociationContext(options);

      let confidence = 20;
      if (association.parentConfirmed) confidence += 20;
      if (association.tradingConfidence >= 90) confidence += 10;
      else if (association.tradingConfidence >= 80) confidence += 5;
      if (matchedTrading.length >= 2) confidence += 50;
      else if (matchedTrading.length === 1) confidence += 35;
      // Size is only a weak evidence-quality signal, never proof of trading.
      if (memberCount >= 50) confidence += 5;
      if (association.creatorOwned) confidence += 20;
      if (association.creatorOwned && association.parentTerms.length > 0) confidence += 10;
      if (matchedNegative.length > 0) confidence -= (matchedNegative.length * 35);
      confidence = Math.max(0, Math.min(99, confidence));

      if (matchedNegative.length > 0 && matchedTrading.length === 0) {
        console.log(`[Discord Relevance] Server '${guildName}' (${cleanCode}) REJECTED as NON_TRADING due to native negative signals [${matchedNegative.join(', ')}]. Confidence: ${confidence}%.`);
        return result({status:'NON_TRADING',confidence,inviteUrl:null,guildName:guildName||'Discord Server',approximateMemberCount:memberCount,approximatePresenceCount:presenceCount,relevanceReason:`Non-trading server detected from Discord-native metadata (matched: ${matchedNegative.join(', ')})`,operationalOutcome:'SUCCEEDED',retryable:false,livenessStatus:'ACTIVE',relevanceStatus:'NON_TRADING',resolutionStatus:'RESOLVED',validationStatus:'SUCCEEDED'});
      }

      const strongCreatorAssociation = association.strongParent && association.creatorOwned && matchedNegative.length===0;
      const discordNativeConfirmation = matchedTrading.length>0 && confidence>=70;
      if (discordNativeConfirmation || strongCreatorAssociation) {
        const status: DiscordStatus = memberCount >= 50 ? 'ACTIVE' : 'ACTIVE_LOW_VOLUME';
        const reason=discordNativeConfirmation
          ? `Confirmed trading community from Discord-native evidence (Confidence: ${confidence}%, Matched: ${matchedTrading.slice(0,3).join(', ')})`
          : `Live community is strongly associated with a ${association.tradingConfidence}% trading-confirmed creator via creator-owned source; Discord metadata is sparse and contains no contradictory signal`;
        console.log(`[Discord Relevance] Server '${guildName}' (${cleanCode}) APPROVED as ${status} (Confidence: ${confidence}%). Native=[${matchedTrading.join(', ')||'none'}], ownership=${association.ownershipStatus||'unknown'}.`);
        return result({status,confidence:Math.max(70,confidence),inviteUrl:canonicalInviteUrl,guildName:guildName||'Trading Discord',approximateMemberCount:memberCount,approximatePresenceCount:presenceCount,relevanceReason:reason,operationalOutcome:'SUCCEEDED',retryable:false,livenessStatus:'ACTIVE',relevanceStatus:'TRADING_RELEVANT',resolutionStatus:'RESOLVED',validationStatus:'SUCCEEDED'});
      }

      if (confidence >= 35) {
        return result({status:'UNCERTAIN',confidence,inviteUrl:null,guildName:guildName||'Discord Server',approximateMemberCount:memberCount,approximatePresenceCount:presenceCount,relevanceReason:`Active community; relevance evidence remains insufficient (Confidence: ${confidence}%, ownership=${association.ownershipStatus||'unknown'}, Discord-native trading matches=${matchedTrading.length})`,operationalOutcome:'SUCCEEDED',retryable:false,livenessStatus:'ACTIVE',relevanceStatus:'UNCERTAIN',resolutionStatus:'RESOLVED',validationStatus:'SUCCEEDED'});
      }

      return result({status:'UNCERTAIN',confidence,inviteUrl:null,guildName:guildName||'Discord Server',approximateMemberCount:memberCount,approximatePresenceCount:presenceCount,relevanceReason:`Active community with insufficient trading relevance evidence (${confidence}% - no explicit negative evidence)`,operationalOutcome:'SUCCEEDED',retryable:false,livenessStatus:'ACTIVE',relevanceStatus:'UNCERTAIN',resolutionStatus:'RESOLVED',validationStatus:'SUCCEEDED'});
    }

    const reason='Discord returned malformed guild data';attempts.push({attemptNumber,operationalOutcome:'MALFORMED_RESPONSE',retryable:true,reason,checkedAt:new Date().toISOString()});
    if(attemptNumber<maxAttempts){await new Promise(resolve=>setTimeout(resolve,(options?.retryDelayMs??250)*2**(attemptNumber-1)));continue;}
    return result({ status:'UNCERTAIN',confidence:0,inviteUrl:null,relevanceReason:reason,operationalOutcome:'MALFORMED_RESPONSE',retryable:true,livenessStatus:'UNCERTAIN',relevanceStatus:'NOT_CHECKED',resolutionStatus:'RESOLVED',validationStatus:'RETRY_PENDING' });
  } catch (err: any) {
    const typed=err as ProviderCallError,outcome:DiscordOperationalOutcome=typed.errorClass==='TIMEOUT'?'TIMEOUT':typed.errorClass==='RATE_LIMIT'?'RATE_LIMITED':typed.errorClass==='PERMANENT_INPUT'?'PROVIDER_FAILURE':'NETWORK_FAILURE',retryable=typed.retryable!==false;
    const reason=`Discord check failed: ${typed.message||String(err)}`;attempts.push({attemptNumber,operationalOutcome:outcome,retryable,httpStatus:typed.status,providerErrorClass:typed.errorClass,reason,checkedAt:new Date().toISOString()});
    if(retryable&&attemptNumber<maxAttempts){await new Promise(resolve=>setTimeout(resolve,(options?.retryDelayMs??250)*2**(attemptNumber-1)));continue;}
    return result({status:'UNCERTAIN',confidence:0,inviteUrl:null,relevanceReason:reason,operationalOutcome:outcome,retryable,livenessStatus:'UNCERTAIN',relevanceStatus:'NOT_CHECKED',resolutionStatus:'RESOLVED',validationStatus:retryable?'RETRY_PENDING':'FAILED_OPERATIONAL'});
  }
  return result({status:'UNCERTAIN',confidence:0,inviteUrl:null,relevanceReason:'Discord check attempts exhausted',operationalOutcome:'PROVIDER_FAILURE',retryable:true,livenessStatus:'UNCERTAIN',relevanceStatus:'NOT_CHECKED',resolutionStatus:'RESOLVED',validationStatus:'RETRY_PENDING'});
}
