import { DiscordStatus } from '../src/types';
import { executeProviderCall, type ProviderCallError } from './providerResilience';
import { appendProviderCallEvent } from './db';

export interface DiscordValidationResult {
  status: DiscordStatus;
  confidence: number; // 0 to 100
  inviteUrl: string | null; // ONLY non-null if status is ACTIVE or ACTIVE_LOW_VOLUME
  guildName?: string;
  approximateMemberCount?: number;
  approximatePresenceCount?: number;
  relevanceReason?: string;
  candidateInviteUrl: string;
  operationalOutcome: DiscordOperationalOutcome;
  retryable: boolean;
  attempts: DiscordCheckAttempt[];
}

export type DiscordOperationalOutcome = 'SUCCEEDED'|'CONFIRMED_INVALID'|'RATE_LIMITED'|'TIMEOUT'|'NETWORK_FAILURE'|'AUTHENTICATION_FAILURE'|'PROVIDER_FAILURE'|'MALFORMED_RESPONSE'|'INVALID_LOCATOR';
export interface DiscordCheckAttempt {attemptNumber:number;operationalOutcome:DiscordOperationalOutcome;retryable:boolean;httpStatus?:number;providerErrorClass?:string;reason:string;checkedAt:string}

export interface DiscordValidationOptions {
  parentChannelIsTrading?: boolean;
  channelName?: string;
  maxAttempts?: number;
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
  emitProviderEvent?: typeof appendProviderCallEvent;
}

// Keywords required to confirm a Discord community is relevant to trading / finance
const TRADING_RELEVANCE_KEYWORDS = [
  'trading', 'trader', 'trade', 'trades', 'forex', 'futures', 'stock', 'stocks',
  'orderflow', 'order flow', 'crypto', 'bitcoin', 'btc', 'eth', 'solana',
  'analysis', 'signal', 'signals', 'market', 'markets', 'invest', 'investing',
  'chart', 'charts', 'price action', 'smc', 'smart money', 'prop firm',
  'ftmo', 'funding', 'equity', 'equities', 'options', 'option',
  'dax', 'sp500', 'nasdaq', 'ftse', 'cac', 'aex', 'bourse', 'bolsa', 'börse',
  'scalp', 'scalping', 'daytrade', 'daytrader', 'swing', 'liquidity',
  'volume', 'footprint', 'macro', 'finance', 'financial', 'börsenanalyse',
  'technical analysis', 'pnl', 'lot size', 'pip', 'pips'
];

// Explicit negative keywords that signal a non-trading community
const EXPLICIT_NON_TRADING_KEYWORDS = [
  'gaming', 'minecraft', 'roblox', 'fortnite', 'valorant', 'csgo', 'counter strike',
  'league of legends', 'gta', 'anime', 'manga', 'roleplay', 'rp server', 'music',
  'dj lounge', 'meme', 'memes', 'homework', 'study group', 'nsfw', 'dating',
  'chill lounge', 'hangout spot', 'airdrop bot', 'free nitro', 'giveaway bot'
];

/**
 * Validates a Discord invite link for active status AND verifies server trading relevance.
 * Confidence-aware classification supporting context inheritance from YouTube creator parent.
 */
export async function validateDiscordInvite(
  inviteCode: string,
  options?: DiscordValidationOptions
): Promise<DiscordValidationResult> {
  let cleanCode = inviteCode
    .replace(/^[\/]+/, '')
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
    return result({ status: 'UNCERTAIN', confidence: 0, inviteUrl: null, relevanceReason: 'Invalid or reserved invite code',operationalOutcome:'INVALID_LOCATOR',retryable:false });
  }

  const maxAttempts=Math.min(5,Math.max(1,options?.maxAttempts||3)),fetchImpl=options?.fetchImpl||fetch,emit=options?.emitProviderEvent||appendProviderCallEvent;
  for(let attemptNumber=1;attemptNumber<=maxAttempts;attemptNumber++) try {
    const apiUrl = `https://discord.com/api/v9/invites/${encodeURIComponent(cleanCode)}?with_counts=true`;
    const res = await executeProviderCall({context:{provider:'discord',operation:'invite-lookup',attempt:attemptNumber},timeoutMs:Number(process.env.DISCORD_PROVIDER_TIMEOUT_MS||'15000'),enabled:true,emit,call:signal=>fetchImpl(apiUrl, {
      signal, headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    })});

    if (!res.ok) {
      const outcome:DiscordOperationalOutcome=res.status===404?'CONFIRMED_INVALID':res.status===429?'RATE_LIMITED':[401,403].includes(res.status)?'AUTHENTICATION_FAILURE':res.status>=500?'PROVIDER_FAILURE':'PROVIDER_FAILURE';
      const retryable=outcome==='RATE_LIMITED'||(outcome==='PROVIDER_FAILURE'&&res.status>=500);
      const reason=outcome==='CONFIRMED_INVALID'?'Discord confirmed the invite is expired or invalid':`Discord invite lookup returned HTTP ${res.status}`;
      attempts.push({attemptNumber,operationalOutcome:outcome,retryable,httpStatus:res.status,reason,checkedAt:new Date().toISOString()});
      if(outcome==='CONFIRMED_INVALID')return result({ status:'DEAD',confidence:100,inviteUrl:null,relevanceReason:reason,operationalOutcome:outcome,retryable:false });
      if(retryable&&attemptNumber<maxAttempts){await new Promise(resolve=>setTimeout(resolve,(options?.retryDelayMs??250)*2**(attemptNumber-1)));continue;}
      return result({status:'UNCERTAIN',confidence:0,inviteUrl:null,relevanceReason:reason,operationalOutcome:outcome,retryable});
    }

    const data = await res.json();

    if (data && (data.guild || data.code)) {
      attempts.push({attemptNumber,operationalOutcome:'SUCCEEDED',retryable:false,httpStatus:res.status,reason:'Discord invite metadata retrieved',checkedAt:new Date().toISOString()});
      const memberCount = data.approximate_member_count || 0;
      const presenceCount = data.approximate_presence_count || 0;
      const guildName = data.guild?.name || '';
      const guildDescription = data.guild?.description || '';
      const channelName = data.channel?.name || '';
      const welcomeDesc = data.guild?.welcome_screen?.description || '';
      const actualCode = data.code || cleanCode;
      const canonicalInviteUrl = `https://discord.gg/${actualCode}`;

      // Combine all available server metadata into lowercased text string
      const fullText = [guildName, guildDescription, channelName, welcomeDesc, cleanCode, options?.channelName]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      // Check positive trading keyword presence
      const matchedTrading = TRADING_RELEVANCE_KEYWORDS.filter(kw => fullText.includes(kw));

      // Check explicit negative non-trading keyword presence
      const matchedNegative = EXPLICIT_NON_TRADING_KEYWORDS.filter(kw => fullText.includes(kw));

      // Confidence Score Calculation (0 - 100%)
      let confidence = 20;

      // Prior 1: Context inheritance from parent YouTube creator
      if (options?.parentChannelIsTrading) {
        confidence += 35;
      }

      // Prior 2: Positive trading keywords
      if (matchedTrading.length >= 2) {
        confidence += 50;
      } else if (matchedTrading.length === 1) {
        confidence += 35;
      }

      // Prior 3: Active community size signal
      if (memberCount >= 50) {
        confidence += 10;
      }

      // Penalty 1: Explicit non-trading negative signals
      if (matchedNegative.length > 0) {
        confidence -= (matchedNegative.length * 35);
      }

      // Clamp confidence between 0 and 99
      confidence = Math.max(0, Math.min(99, confidence));

      // Status Decision Logic
      if (matchedNegative.length > 0 && matchedTrading.length === 0) {
        console.log(`[Discord Relevance] Server '${guildName}' (${cleanCode}) REJECTED as NON_TRADING due to negative signals [${matchedNegative.join(', ')}]. Confidence: ${confidence}%.`);
        return result({
          status: 'NON_TRADING',
          confidence,
          inviteUrl: null, // DO NOT store invite URL for non-trading servers!
          guildName: guildName || 'Discord Server',
          approximateMemberCount: memberCount,
          approximatePresenceCount: presenceCount,
          relevanceReason: `Non-trading server detected (matched non-finance signals: ${matchedNegative.join(', ')})`,operationalOutcome:'SUCCEEDED',retryable:false
        });
      }

      if (confidence >= 70) {
        const status: DiscordStatus = memberCount >= 50 ? 'ACTIVE' : 'ACTIVE_LOW_VOLUME';
        console.log(`[Discord Relevance] Server '${guildName}' (${cleanCode}) APPROVED as ${status} (Confidence: ${confidence}%). Matched: [${matchedTrading.join(', ') || 'Parent Creator Link'}].`);
        return result({
          status,
          confidence,
          inviteUrl: canonicalInviteUrl, // Store invite URL ONLY for active trading communities!
          guildName: guildName || 'Trading Discord',
          approximateMemberCount: memberCount,
          approximatePresenceCount: presenceCount,
          relevanceReason: `Confirmed trading community (Confidence: ${confidence}%, Matched: ${matchedTrading.slice(0, 3).join(', ') || 'Creator Link'})`,operationalOutcome:'SUCCEEDED',retryable:false
        });
      }

      if (confidence >= 35) {
        console.log(`[Discord Relevance] Server '${guildName}' (${cleanCode}) CLASSIFIED as UNCERTAIN (Confidence: ${confidence}%). Withholding invite URL.`);
        return result({
          status: 'UNCERTAIN',
          confidence,
          inviteUrl: null, // DO NOT store invite URL for uncertain communities!
          guildName: guildName || 'Discord Server',
          approximateMemberCount: memberCount,
          approximatePresenceCount: presenceCount,
          relevanceReason: `Ambiguous community (Confidence: ${confidence}% - Insufficient explicit trading evidence)`,operationalOutcome:'SUCCEEDED',retryable:false
        });
      }

      console.log(`[Discord Relevance] Server '${guildName}' (${cleanCode}) CLASSIFIED as UNCERTAIN (Confidence: ${confidence}%).`);
      return result({
        status: 'UNCERTAIN',
        confidence,
        inviteUrl: null, // DO NOT store invite URL!
        guildName: guildName || 'Discord Server',
        approximateMemberCount: memberCount,
        approximatePresenceCount: presenceCount,
        relevanceReason: `Ambiguous community (${confidence}% - no explicit negative evidence)`,operationalOutcome:'SUCCEEDED',retryable:false
      });

    } else {
      const reason='Discord returned malformed guild data';attempts.push({attemptNumber,operationalOutcome:'MALFORMED_RESPONSE',retryable:true,reason,checkedAt:new Date().toISOString()});
      if(attemptNumber<maxAttempts){await new Promise(resolve=>setTimeout(resolve,(options?.retryDelayMs??250)*2**(attemptNumber-1)));continue;}
      return result({ status:'UNCERTAIN',confidence:0,inviteUrl:null,relevanceReason:reason,operationalOutcome:'MALFORMED_RESPONSE',retryable:true });
    }
  } catch (err: any) {
    const typed=err as ProviderCallError,outcome:DiscordOperationalOutcome=typed.errorClass==='TIMEOUT'?'TIMEOUT':typed.errorClass==='RATE_LIMIT'?'RATE_LIMITED':typed.errorClass==='PERMANENT_INPUT'?'PROVIDER_FAILURE':'NETWORK_FAILURE',retryable=typed.retryable!==false;
    const reason=`Discord check failed: ${typed.message||String(err)}`;attempts.push({attemptNumber,operationalOutcome:outcome,retryable,httpStatus:typed.status,providerErrorClass:typed.errorClass,reason,checkedAt:new Date().toISOString()});
    if(retryable&&attemptNumber<maxAttempts){await new Promise(resolve=>setTimeout(resolve,(options?.retryDelayMs??250)*2**(attemptNumber-1)));continue;}
    return result({status:'UNCERTAIN',confidence:0,inviteUrl:null,relevanceReason:reason,operationalOutcome:outcome,retryable});
  }
  return result({status:'UNCERTAIN',confidence:0,inviteUrl:null,relevanceReason:'Discord check attempts exhausted',operationalOutcome:'PROVIDER_FAILURE',retryable:true});
}
