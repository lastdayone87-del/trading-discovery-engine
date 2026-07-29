import { DiscordStatus } from '../src/types';
import { executeProviderCall } from './providerResilience';
import { appendProviderCallEvent } from './db';

export interface DiscordValidationResult {
  status: DiscordStatus;
  confidence: number; // 0 to 100
  inviteUrl: string | null; // ONLY non-null if status is ACTIVE or ACTIVE_LOW_VOLUME
  guildName?: string;
  approximateMemberCount?: number;
  approximatePresenceCount?: number;
  relevanceReason?: string;
}

export interface DiscordValidationOptions {
  parentChannelIsTrading?: boolean;
  channelName?: string;
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

  if (!cleanCode || cleanCode.length < 2 || RESERVED_WORDS.includes(cleanCode.toLowerCase())) {
    return { status: 'DEAD', confidence: 0, inviteUrl: null, relevanceReason: 'Invalid or reserved invite code' };
  }

  try {
    const apiUrl = `https://discord.com/api/v9/invites/${encodeURIComponent(cleanCode)}?with_counts=true`;
    const res = await executeProviderCall({context:{provider:'discord',operation:'invite-lookup'},timeoutMs:Number(process.env.DISCORD_PROVIDER_TIMEOUT_MS||'15000'),enabled:process.env.PROVIDER_DEADLINES_ENABLED==='true',emit:appendProviderCallEvent,call:signal=>fetch(apiUrl, {
      signal, headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    })});

    if (!res.ok) {
      // 404 or expired invite
      return { status: 'DEAD', confidence: 0, inviteUrl: null, relevanceReason: 'Expired or invalid Discord invite link' };
    }

    const data = await res.json();

    if (data && (data.guild || data.code)) {
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
        return {
          status: 'NON_TRADING',
          confidence,
          inviteUrl: null, // DO NOT store invite URL for non-trading servers!
          guildName: guildName || 'Discord Server',
          approximateMemberCount: memberCount,
          approximatePresenceCount: presenceCount,
          relevanceReason: `Non-trading server detected (matched non-finance signals: ${matchedNegative.join(', ')})`
        };
      }

      if (confidence >= 70) {
        const status: DiscordStatus = memberCount >= 50 ? 'ACTIVE' : 'ACTIVE_LOW_VOLUME';
        console.log(`[Discord Relevance] Server '${guildName}' (${cleanCode}) APPROVED as ${status} (Confidence: ${confidence}%). Matched: [${matchedTrading.join(', ') || 'Parent Creator Link'}].`);
        return {
          status,
          confidence,
          inviteUrl: canonicalInviteUrl, // Store invite URL ONLY for active trading communities!
          guildName: guildName || 'Trading Discord',
          approximateMemberCount: memberCount,
          approximatePresenceCount: presenceCount,
          relevanceReason: `Confirmed trading community (Confidence: ${confidence}%, Matched: ${matchedTrading.slice(0, 3).join(', ') || 'Creator Link'})`
        };
      }

      if (confidence >= 35) {
        console.log(`[Discord Relevance] Server '${guildName}' (${cleanCode}) CLASSIFIED as UNCERTAIN (Confidence: ${confidence}%). Withholding invite URL.`);
        return {
          status: 'UNCERTAIN',
          confidence,
          inviteUrl: null, // DO NOT store invite URL for uncertain communities!
          guildName: guildName || 'Discord Server',
          approximateMemberCount: memberCount,
          approximatePresenceCount: presenceCount,
          relevanceReason: `Ambiguous community (Confidence: ${confidence}% - Insufficient explicit trading evidence)`
        };
      }

      console.log(`[Discord Relevance] Server '${guildName}' (${cleanCode}) REJECTED as NON_TRADING (Confidence: ${confidence}%).`);
      return {
        status: 'NON_TRADING',
        confidence,
        inviteUrl: null, // DO NOT store invite URL!
        guildName: guildName || 'Discord Server',
        approximateMemberCount: memberCount,
        approximatePresenceCount: presenceCount,
        relevanceReason: `Low confidence trading relevance (${confidence}%)`
      };

    } else {
      return { status: 'DEAD', confidence: 0, inviteUrl: null, relevanceReason: 'Invalid Discord guild data' };
    }
  } catch (err: any) {
    return { status: 'DEAD', confidence: 0, inviteUrl: null, relevanceReason: `Network or API error: ${err.message}` };
  }
}
