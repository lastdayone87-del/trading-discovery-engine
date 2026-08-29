export type YouTubeProviderFailureKind = 'RATE_LIMITED' | 'DAILY_QUOTA_EXHAUSTED' | 'CONSUMER_SUSPENDED';
export type YouTubeProviderOperationalStatus = 'Active' | 'Cooling Down' | 'Daily Quota Exhausted' | 'Suspended';
export interface YouTubeProviderCooldownOptions { initialRateLimitCooldownMs:number; maxRateLimitCooldownMs:number; suspendedProviderCooldownMs?:number; runtimeRateLimitPauseMs?:number; now?:()=>number; }
const YOUTUBE_QUOTA_TIME_ZONE='America/Los_Angeles';
function zonedParts(timestamp:number,timeZone:string):Record<string,number>{const parts=new Intl.DateTimeFormat('en-US',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(timestamp));return Object.fromEntries(parts.filter(part=>part.type!=='literal').map(part=>[part.type,Number(part.value)]));}
function zonedOffsetMs(timestamp:number,timeZone:string):number{const rounded=Math.floor(timestamp/1000)*1000;const parts=zonedParts(rounded,timeZone);const representedAsUtc=Date.UTC(parts.year,parts.month-1,parts.day,parts.hour,parts.minute,parts.second);return representedAsUtc-rounded;}
export function youtubeQuotaDateKey(now:number=Date.now()):string{const parts=zonedParts(now,YOUTUBE_QUOTA_TIME_ZONE);return `${parts.year}-${String(parts.month).padStart(2,'0')}-${String(parts.day).padStart(2,'0')}`;}
export function nextYouTubeDailyQuotaResetAt(now:number):number{const pacific=zonedParts(now,YOUTUBE_QUOTA_TIME_ZONE);const nextLocalMidnight=Date.UTC(pacific.year,pacific.month-1,pacific.day+1,0,0,0);let candidate=nextLocalMidnight-zonedOffsetMs(nextLocalMidnight,YOUTUBE_QUOTA_TIME_ZONE);candidate=nextLocalMidnight-zonedOffsetMs(candidate,YOUTUBE_QUOTA_TIME_ZONE);return candidate;}
export class YouTubeProviderCooldown{
 private readonly dailyProviders=new Map<string,{retryAt:number}>();
 private readonly localRateLimitedProviders=new Map<string,{retryAt:number;observedAt:number}>();
 private readonly suspendedProviders=new Map<string,{retryAt:number;observedAt:number}>();
 private readonly failureGenerations=new Map<string,number>();
 private runtimeRateLimitRetryAt=0;
 constructor(private readonly options:YouTubeProviderCooldownOptions){}
 private now():number{return(this.options.now??Date.now)();}
 private localConfirmationWindowMs():number{return Math.max(1,Math.min(this.options.initialRateLimitCooldownMs,Math.max(1,this.options.maxRateLimitCooldownMs)));}
 private providerQuarantineMs():number{return Math.max(this.localConfirmationWindowMs(),Math.max(1,this.options.maxRateLimitCooldownMs));}
 private suspendedQuarantineMs():number{return Math.max(1,this.options.suspendedProviderCooldownMs??24*60*60_000);}
 private activeRuntimeRateLimitRetryAt():number{const now=this.now();if(this.runtimeRateLimitRetryAt<=now){this.runtimeRateLimitRetryAt=0;return 0;}return this.runtimeRateLimitRetryAt;}
 private activeDailyState(key:string):{retryAt:number}|undefined{const state=this.dailyProviders.get(key);if(!state)return undefined;if(this.now()>=state.retryAt){this.dailyProviders.delete(key);return undefined;}return state;}
 private activeLocalRateLimitState(key:string):{retryAt:number;observedAt:number}|undefined{const state=this.localRateLimitedProviders.get(key);if(!state)return undefined;if(this.now()>=state.retryAt){this.localRateLimitedProviders.delete(key);return undefined;}return state;}
 private activeSuspendedState(key:string):{retryAt:number;observedAt:number}|undefined{const state=this.suspendedProviders.get(key);if(!state)return undefined;if(this.now()>=state.retryAt){this.suspendedProviders.delete(key);return undefined;}return state;}
 private recentDistinctLocalRateLimitProvider(excludeKey:string):string|undefined{const now=this.now();const cutoff=now-this.localConfirmationWindowMs();for(const[providerKey,state]of this.localRateLimitedProviders){if(providerKey!==excludeKey&&state.observedAt>=cutoff)return providerKey;}return undefined;}
 eligible(key:string):boolean{if(this.activeRuntimeRateLimitRetryAt()>0)return false;return!this.activeDailyState(key)&&!this.activeLocalRateLimitState(key)&&!this.activeSuspendedState(key);}
 failed(key:string,kind:YouTubeProviderFailureKind):number{const now=this.now();this.failureGenerations.set(key,this.failureGeneration(key)+1);if(kind==='CONSUMER_SUSPENDED'){const retryAt=now+this.suspendedQuarantineMs();this.suspendedProviders.set(key,{retryAt,observedAt:now});this.dailyProviders.delete(key);this.localRateLimitedProviders.delete(key);return retryAt;}if(kind==='DAILY_QUOTA_EXHAUSTED'){const retryAt=nextYouTubeDailyQuotaResetAt(now);this.dailyProviders.set(key,{retryAt});this.localRateLimitedProviders.delete(key);return retryAt;}const corroboratingProvider=this.recentDistinctLocalRateLimitProvider(key);const providerRetryAt=now+this.providerQuarantineMs();this.localRateLimitedProviders.set(key,{retryAt:providerRetryAt,observedAt:now});if(corroboratingProvider){const configuredPause=this.options.runtimeRateLimitPauseMs??this.options.initialRateLimitCooldownMs;const pauseMs=Math.max(1,Math.min(configuredPause,Math.max(1,this.options.maxRateLimitCooldownMs)));this.runtimeRateLimitRetryAt=Math.max(this.runtimeRateLimitRetryAt,now+pauseMs);return this.runtimeRateLimitRetryAt;}return providerRetryAt;}
 failureGeneration(key:string):number{return this.failureGenerations.get(key)??0;}
 succeeded(key:string,expectedFailureGeneration?:number):boolean{if(expectedFailureGeneration!==undefined&&this.failureGeneration(key)!==expectedFailureGeneration)return false;this.dailyProviders.delete(key);this.localRateLimitedProviders.delete(key);this.suspendedProviders.delete(key);return true;}
 retryAt(key:string):number{return Math.max(this.activeRuntimeRateLimitRetryAt(),this.activeDailyState(key)?.retryAt??0,this.activeLocalRateLimitState(key)?.retryAt??0,this.activeSuspendedState(key)?.retryAt??0);}
 status(key:string):{status:YouTubeProviderOperationalStatus;retryAt:number|null}{const suspendedState=this.activeSuspendedState(key);if(suspendedState)return{status:'Suspended',retryAt:suspendedState.retryAt};const dailyState=this.activeDailyState(key);if(dailyState)return{status:'Daily Quota Exhausted',retryAt:dailyState.retryAt};const runtimeRetryAt=this.activeRuntimeRateLimitRetryAt();if(runtimeRetryAt>0)return{status:'Cooling Down',retryAt:runtimeRetryAt};const localRateLimitState=this.activeLocalRateLimitState(key);if(localRateLimitState)return{status:'Cooling Down',retryAt:localRateLimitState.retryAt};return{status:'Active',retryAt:null};}
 earliestRetryAtIfAllCooling(keys:string[]):number|null{if(!keys.length)return null;const now=this.now();const runtimeRetryAt=this.activeRuntimeRateLimitRetryAt();const effectiveRetryTimes=keys.map(key=>Math.max(runtimeRetryAt,this.activeDailyState(key)?.retryAt??0,this.activeLocalRateLimitState(key)?.retryAt??0,this.activeSuspendedState(key)?.retryAt??0));if(effectiveRetryTimes.some(retryAt=>retryAt<=now))return null;return Math.min(...effectiveRetryTimes);}
}
export class YouTubeProvidersCoolingDownError extends Error{readonly code='YOUTUBE_PROVIDERS_COOLING_DOWN';readonly retryable=true;readonly errorClass='RATE_LIMIT';readonly retryAfterMs:number;constructor(public readonly retryAt:number){super(`Every configured YouTube provider is cooling down; retry is scheduled for ${new Date(retryAt).toISOString()}.`);this.name='YouTubeProvidersCoolingDownError';this.retryAfterMs=Math.max(0,retryAt-Date.now());}}
const nonNegativeNumber=(value:string|undefined,fallback:number):number=>{const parsed=Number(value);return Number.isFinite(parsed)&&parsed>=0?parsed:fallback;};
export const youtubeProviderCooldown=new YouTubeProviderCooldown({initialRateLimitCooldownMs:nonNegativeNumber(process.env.YOUTUBE_RATE_LIMIT_BACKOFF_MS,5_000),maxRateLimitCooldownMs:nonNegativeNumber(process.env.YOUTUBE_RATE_LIMIT_MAX_BACKOFF_MS,5*60_000),suspendedProviderCooldownMs:nonNegativeNumber(process.env.YOUTUBE_SUSPENDED_PROVIDER_COOLDOWN_MS,24*60*60_000),runtimeRateLimitPauseMs:nonNegativeNumber(process.env.YOUTUBE_RUNTIME_RATE_LIMIT_PAUSE_MS,1_000)});

export function isQuotaExceeded(error: unknown): boolean {
  let current: any = error;
  for (let depth = 0; current && depth < 5; depth++, current = current.cause) {
    if (current.quotaExceeded === true || /quotaExceeded|dailyLimitExceeded|CONSUMER_SUSPENDED/i.test(String(current.message ?? ''))) return true;
    if (current.providerReasons?.some((reason: unknown) => /consumer[_-]?suspended/i.test(String(reason)))) return true;
  }
  return false;
}