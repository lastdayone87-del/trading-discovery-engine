/**
 * H1 — Discord public server-directory and widget surfaces.
 *
 * Discord invite extraction from text is terminal: a `discord.gg` code is a
 * candidate without a network hop. Two public Discord URL shapes carry no
 * invite code in the URL itself:
 *
 *   https://discord.com/servers/<slug>-<guildId>
 *   https://discord.com/widget?id=<guildId>
 *
 * The crawler previously dropped both hosts before admission, so a creator
 * that linked only one of them produced a clean negative. This module parses
 * the guild identity, performs a bounded public fetch, and returns any native
 * invite candidates with source attribution.
 *
 * Server pages are server-rendered and expose the server's vanity invite
 * (verified against the live directory: a server page contains its
 * `discord.gg/<code>` link). Widget pages are a JavaScript shell; the public
 * widget JSON is the authoritative surface and may expose `instant_invite`.
 *
 * Everything here is public-only: no login, token, or guild membership. The
 * callers keep the existing candidate admission, ownership, and validation
 * pipeline; this module never validates an invite.
 */
import { extractDiscordCandidates, type DiscordCandidate } from './discordCandidates';
import type { AcquisitionSurface } from './inspector';

export type DiscordPublicSurfaceKind = 'SERVER_PAGE' | 'WIDGET';

export interface DiscordPublicSurfaceRef {
  kind: DiscordPublicSurfaceKind;
  guildId: string;
  /** Stable fetch/dedupe URL. Discord-owned host aliases collapse to
   * `discord.com` so `discordapp.com` variants share one inspection. */
  canonicalUrl: string;
}

export type DiscordPublicSurfaceOutcome = 'FOUND' | 'INSPECTED_NO_MATCH' | 'ACQUISITION_FAILED';

export interface DiscordPublicSurfaceAcquisition {
  surface: DiscordPublicSurfaceRef;
  outcome: DiscordPublicSurfaceOutcome;
  retryable: boolean;
  failureClass?: string;
  detail: string;
  candidates: DiscordCandidate[];
  /** Bounded public requests actually started. */
  requestsStarted: number;
  /** HTML pages fully parsed (server pages only). */
  pagesInspected: number;
}

const DISCORD_PUBLIC_HOSTS = new Set([
  'discord.com',
  'www.discord.com',
  'discordapp.com',
  'www.discordapp.com',
]);
const GUILD_ID = /^\d{15,25}$/;
const GUILD_ID_IN_PATH = /(\d{15,25})/;
const DEFAULT_TIMEOUT_MS = 8_000;
const PUBLIC_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
};

/**
 * Parse a Discord server-directory or widget URL. Returns null for every
 * other Discord path (invites, channels, the directory root, category pages,
 * and malformed guild ids) so callers keep the existing terminal-invite
 * behavior for those shapes.
 */
export function discordPublicSurfaceFor(raw: string): DiscordPublicSurfaceRef | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!DISCORD_PUBLIC_HOSTS.has(host)) return null;

  const path = parsed.pathname.replace(/\/+$/, '');
  const serverPath = /^\/servers\/(.+)$/i.exec(path);
  if (serverPath) {
    const tail = serverPath[1];
    const match = GUILD_ID_IN_PATH.exec(tail);
    if (!match) return null;
    return {
      kind: 'SERVER_PAGE',
      guildId: match[1],
      canonicalUrl: `https://discord.com/servers/${tail}`,
    };
  }

  if (/^\/widget$/i.test(path)) {
    const id = parsed.searchParams.get('id')
      || parsed.searchParams.get('server_id')
      || parsed.searchParams.get('serverId')
      || '';
    if (!GUILD_ID.test(id)) return null;
    return {
      kind: 'WIDGET',
      guildId: id,
      canonicalUrl: `https://discord.com/widget?id=${id}`,
    };
  }

  return null;
}

export function widgetJsonUrl(guildId: string): string {
  return `https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}/widget.json`;
}

interface FetchResult {
  response?: Response;
  failureClass?: string;
  detail?: string;
}

async function fetchBounded(
  fetchImpl: typeof fetch,
  url: string,
  accept: string,
  timeoutMs: number,
): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { ...PUBLIC_HEADERS, Accept: accept },
    });
    return { response };
  } catch (error: any) {
    const timedOut = error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
    return {
      failureClass: timedOut ? 'TIMEOUT' : 'NETWORK_FAILURE',
      detail: timedOut ? 'public fetch timed out' : `public fetch failed: ${String(error?.message || error)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

function statusFailure(status: number): { failureClass: string; retryable: boolean; detail: string } {
  if (status === 429) return { failureClass: 'RATE_LIMIT', retryable: true, detail: `HTTP ${status} rate limited` };
  if (status >= 500) return { failureClass: 'TRANSIENT_HTTP', retryable: true, detail: `HTTP ${status} transient upstream failure` };
  if (status === 401 || status === 403) {
    return { failureClass: 'HTTP_ERROR', retryable: true, detail: `HTTP ${status} blocked public inspection` };
  }
  return { failureClass: 'HTTP_ERROR', retryable: false, detail: `HTTP ${status}` };
}

function widgetUnavailable(status: number): boolean {
  return status === 401 || status === 403 || status === 404;
}

interface WidgetResult {
  state: 'OK' | 'UNAVAILABLE' | 'FAILED';
  candidates: DiscordCandidate[];
  detail: string;
  failureClass?: string;
  retryable?: boolean;
}

async function readWidget(
  fetchImpl: typeof fetch,
  guildId: string,
  sourceSurface: AcquisitionSurface,
  surfaceUrl: string,
  timeoutMs: number,
): Promise<WidgetResult> {
  const fetched = await fetchBounded(fetchImpl, widgetJsonUrl(guildId), 'application/json', timeoutMs);
  if (!fetched.response) {
    return {
      state: 'FAILED',
      candidates: [],
      failureClass: fetched.failureClass,
      retryable: true,
      detail: fetched.detail || 'widget fetch failed',
    };
  }
  const response = fetched.response;
  if (!response.ok) {
    if (widgetUnavailable(response.status)) {
      return { state: 'UNAVAILABLE', candidates: [], detail: `widget unavailable (HTTP ${response.status})` };
    }
    const failure = statusFailure(response.status);
    return {
      state: 'FAILED',
      candidates: [],
      failureClass: failure.failureClass,
      retryable: failure.retryable,
      detail: failure.detail,
    };
  }
  let body: any;
  try {
    body = await response.json();
  } catch {
    return {
      state: 'FAILED',
      candidates: [],
      failureClass: 'MALFORMED_RESPONSE',
      retryable: true,
      detail: 'widget JSON could not be parsed',
    };
  }
  const invite = typeof body?.instant_invite === 'string' ? body.instant_invite : '';
  const candidates = invite
    ? extractDiscordCandidates(invite, sourceSurface, surfaceUrl).filter(candidate => candidate.nativeInviteCode)
    : [];
  const name = typeof body?.name === 'string' && body.name ? ` (${body.name})` : '';
  return {
    state: 'OK',
    candidates,
    detail: candidates.length
      ? `widget exposed ${candidates.length} native invite candidate(s)${name}`
      : `widget inspected with no instant invite${name}`,
  };
}

/**
 * Bounded public acquisition for one parsed Discord surface.
 *
 * Server pages: fetch the page and scan the rendered HTML for native invite
 * links; if the page proves no invite, fall back to the public widget JSON
 * (the page may be a client shell or the server may expose only the widget).
 * Widget URLs: fetch the public widget JSON directly.
 */
export async function acquireDiscordPublicSurface(input: {
  surface: DiscordPublicSurfaceRef;
  sourceSurface: AcquisitionSurface;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<DiscordPublicSurfaceAcquisition> {
  const fetchImpl = input.fetchImpl || fetch;
  const timeoutMs = Math.max(1, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const surface = input.surface;
  let requestsStarted = 0;
  let pagesInspected = 0;

  if (surface.kind === 'WIDGET') {
    requestsStarted += 1;
    const widget = await readWidget(fetchImpl, surface.guildId, input.sourceSurface, surface.canonicalUrl, timeoutMs);
    if (widget.candidates.length) {
      return {
        surface,
        outcome: 'FOUND',
        retryable: false,
        detail: widget.detail,
        candidates: widget.candidates,
        requestsStarted,
        pagesInspected,
      };
    }
    if (widget.state === 'FAILED') {
      return {
        surface,
        outcome: 'ACQUISITION_FAILED',
        retryable: widget.retryable !== false,
        failureClass: widget.failureClass,
        detail: widget.detail,
        candidates: [],
        requestsStarted,
        pagesInspected,
      };
    }
    return {
      surface,
      outcome: 'INSPECTED_NO_MATCH',
      retryable: false,
      detail: widget.detail,
      candidates: [],
      requestsStarted,
      pagesInspected,
    };
  }

  requestsStarted += 1;
  const page = await fetchBounded(
    fetchImpl,
    surface.canonicalUrl,
    'text/html,application/xhtml+xml',
    timeoutMs,
  );
  if (!page.response) {
    return {
      surface,
      outcome: 'ACQUISITION_FAILED',
      retryable: true,
      failureClass: page.failureClass,
      detail: page.detail || 'server page fetch failed',
      candidates: [],
      requestsStarted,
      pagesInspected,
    };
  }
  if (!page.response.ok) {
    const failure = statusFailure(page.response.status);
    return {
      surface,
      outcome: 'ACQUISITION_FAILED',
      retryable: failure.retryable,
      failureClass: failure.failureClass,
      detail: `server page ${failure.detail}`,
      candidates: [],
      requestsStarted,
      pagesInspected,
    };
  }

  let html = '';
  try {
    html = await page.response.text();
    pagesInspected = 1;
  } catch {
    return {
      surface,
      outcome: 'ACQUISITION_FAILED',
      retryable: true,
      failureClass: 'MALFORMED_RESPONSE',
      detail: 'server page body could not be read',
      candidates: [],
      requestsStarted,
      pagesInspected,
    };
  }

  const candidates = extractDiscordCandidates(html, input.sourceSurface, surface.canonicalUrl)
    .filter(candidate => candidate.nativeInviteCode);
  if (candidates.length) {
    return {
      surface,
      outcome: 'FOUND',
      retryable: false,
      detail: `server page exposed ${candidates.length} native invite candidate(s)`,
      candidates,
      requestsStarted,
      pagesInspected,
    };
  }

  // A server page can be a client shell. The public widget is the fallback
  // public surface for the same guild; a disabled widget is a confirmed
  // negative, not a failure.
  requestsStarted += 1;
  const widget = await readWidget(fetchImpl, surface.guildId, input.sourceSurface, surface.canonicalUrl, timeoutMs);
  if (widget.candidates.length) {
    return {
      surface,
      outcome: 'FOUND',
      retryable: false,
      detail: `server page had no static invite; ${widget.detail}`,
      candidates: widget.candidates,
      requestsStarted,
      pagesInspected,
    };
  }
  if (widget.state === 'FAILED') {
    return {
      surface,
      outcome: 'ACQUISITION_FAILED',
      retryable: widget.retryable !== false,
      failureClass: widget.failureClass,
      detail: `server page had no static invite; ${widget.detail}`,
      candidates: [],
      requestsStarted,
      pagesInspected,
    };
  }
  return {
    surface,
    outcome: 'INSPECTED_NO_MATCH',
    retryable: false,
    detail: `server page and public widget inspected with no invite (${widget.detail})`,
    candidates: [],
    requestsStarted,
    pagesInspected,
  };
}
