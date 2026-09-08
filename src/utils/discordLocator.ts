// Pure, dependency-free Discord candidate display resolution.
// Discord invite codes are case-sensitive, but `normalized_locator` is stored
// lowercased as a dedupe/comparison key. This helper resolves the URL that must
// be displayed/copied, preferring case-preserved sources and falling back to
// the normalized key only when nothing better exists. It never feeds
// validation or persistence — those paths use the native invite code.
export interface RetainedCandidateLocators {
  display_locator?: string | null;
  raw_locator?: string | null;
  normalized_locator?: string | null;
}

const CODE_PATTERNS = [
  /discord\.gg\/([A-Za-z0-9_-]+)/,
  /discord(?:app)?\.com\/invite\/([A-Za-z0-9_-]+)/,
  /discord\.app\/invite\/([A-Za-z0-9_-]+)/,
];

export function extractDiscordInviteCode(value: string | null | undefined): string | null {
  if (!value) return null;
  for (const pattern of CODE_PATTERNS) {
    const match = pattern.exec(value);
    if (match?.[1]) return match[1];
  }
  return null;
}

export function discordCandidateDisplayUrl(candidate: RetainedCandidateLocators): string | null {
  // 1. Latest-attempt casing supplied by the listing API (exact validated form).
  const fromDisplay = extractDiscordInviteCode(candidate.display_locator);
  if (fromDisplay) return `https://discord.gg/${fromDisplay}`;
  // 2. Original-case code embedded in the stored raw locator.
  const fromRaw = extractDiscordInviteCode(candidate.raw_locator);
  if (fromRaw) return `https://discord.gg/${fromRaw}`;
  // 3. Normalized key (lowercased): usable for identity, may 404 for mixed-case codes.
  return candidate.normalized_locator || null;
}
