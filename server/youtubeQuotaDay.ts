const YOUTUBE_QUOTA_TIME_ZONE = 'America/Los_Angeles';

function zonedParts(now: Date): Record<string, number> {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: YOUTUBE_QUOTA_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(now);
  return Object.fromEntries(parts
    .filter(part => part.type !== 'literal')
    .map(part => [part.type, Number(part.value)]));
}

function zonedOffsetMs(timestamp: number): number {
  const rounded = Math.floor(timestamp / 1000) * 1000;
  const parts = zonedParts(new Date(rounded));
  const representedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return representedAsUtc - rounded;
}

function localMidnightUtcMs(year: number, month: number, day: number): number {
  const wallClockUtc = Date.UTC(year, month - 1, day, 0, 0, 0);
  let candidate = wallClockUtc - zonedOffsetMs(wallClockUtc);
  candidate = wallClockUtc - zonedOffsetMs(candidate);
  return candidate;
}

export function getYouTubeQuotaDay(now: Date = new Date()): string {
  const parts = zonedParts(now);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

/** Start of the active YouTube quota day (midnight America/Los_Angeles). */
export function getYouTubeQuotaDayStartAt(now: Date = new Date()): number {
  const parts = zonedParts(now);
  return localMidnightUtcMs(parts.year, parts.month, parts.day);
}

/** Start of the next YouTube quota day (the authoritative daily reset instant). */
export function getNextYouTubeQuotaResetAt(now: Date = new Date()): number {
  const parts = zonedParts(now);
  return localMidnightUtcMs(parts.year, parts.month, parts.day + 1);
}

export function minutesSinceYouTubeQuotaDayStart(now: Date = new Date()): number {
  return Math.max(0, Math.floor((now.getTime() - getYouTubeQuotaDayStartAt(now)) / 60_000));
}
