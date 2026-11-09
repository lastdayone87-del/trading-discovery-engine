/**
 * M2a — deterministic static non-semantic control targets.
 *
 * The static crawler already follows semantic `<a href>` links, embedded
 * URLs, and generic `data-href`/`data-url`/`data-link` attributes. Some
 * creator pages expose their community destination only through a
 * non-semantic control:
 *
 *   - `<meta http-equiv="refresh" content="0; url=...">`
 *   - `<button formaction="...">` / `<input formaction="...">`
 *   - `onclick="location.href='...'"` / `location.assign(...)` /
 *     `location.replace(...)` / `window.open(...)`
 *
 * This module extracts only a closed, literal allowlist. It never evaluates
 * JavaScript. Handlers with variables, concatenation, multiple statements,
 * function calls, template literals, or non-http(s) schemes are excluded.
 * The inspected page's existing destination policy, admission boundary,
 * ranking, and navigation budgets still decide whether an extracted target is
 * pursued.
 *
 * This is not clicking and not a generic heuristic: a target must be a
 * statically readable literal in one of the approved control shapes.
 */
import type { CheerioAPI } from 'cheerio';

export type StaticControlKind = 'META_REFRESH' | 'FORMACTION' | 'ONCLICK_NAVIGATION';

export interface StaticControlTarget {
  /** Literal target as written; the caller resolves it against `<base href>`. */
  url: string;
  kind: StaticControlKind;
  /** Human-readable control text/kind used only for navigation scoring. */
  label: string;
}

export interface StaticControlExtraction {
  targets: StaticControlTarget[];
  /** Eligible unique targets dropped by the deterministic cap. */
  truncated: number;
}

/** Bound per inspected page; normal pages carry only a handful. */
export const MAX_STATIC_CONTROL_TARGETS = 20;

/** Long-delayed refreshes are session/expiry pages, not immediate controls. */
export const MAX_META_REFRESH_DELAY_SECONDS = 5;

const NON_HTTP_SCHEME = /^(?:javascript|data|mailto|tel|blob|file|about):/i;

/**
 * Accept only a literal navigation target. The value may be relative or
 * absolute http(s); fragments are same-page and never reveal new content.
 */
export function literalNavigationTarget(raw: string | null | undefined): string | null {
  const value = String(raw ?? '').trim();
  if (!value || value.startsWith('#')) return null;
  if (NON_HTTP_SCHEME.test(value)) return null;
  try {
    const parsed = new URL(value, 'https://static-control.invalid/');
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  } catch {
    return null;
  }
  return value;
}

/**
 * Strict literal `onclick` navigation parser.
 *
 * Accepted shapes (optional `javascript:`/`return`, one trailing semicolon):
 *   location = '...'
 *   location.href = '...'
 *   window.location = '...'
 *   document.location.href = '...'
 *   location.assign('...')
 *   location.replace('...')
 *   window.open('...') / window.open('...', '_blank')
 *
 * Any expression, concatenation, template literal, second statement, or
 * non-http(s) literal is rejected.
 */
export function parseOnclickNavigation(raw: string | null | undefined): string | null {
  let value = String(raw ?? '').trim();
  if (!value) return null;
  value = value.replace(/^javascript\s*:/i, '').trim();
  value = value.replace(/^return\s+/i, '').trim();
  if (!value || /[`{}]/.test(value)) return null;

  const assignment = /^(?:(?:window|document)\.)?location(?:\.href)?\s*=\s*(['"])(.*?)\1\s*;?$/s.exec(value);
  if (assignment) return literalNavigationTarget(assignment[2]);

  const call = /^(?:(?:window|document)\.)?location\.(?:assign|replace)\(\s*(['"])(.*?)\1\s*\)\s*;?$/s.exec(value);
  if (call) return literalNavigationTarget(call[2]);

  const open = /^(?:window\.)?open\(\s*(['"])(.*?)\1(?:\s*,\s*(['"]).*?\3)?\s*\)\s*;?$/s.exec(value);
  if (open) return literalNavigationTarget(open[2]);

  return null;
}

/**
 * Parse a literal meta-refresh content value. Requires a `url=` target and a
 * finite non-negative delay; malformed or script targets return null.
 */
export function parseMetaRefreshTarget(raw: string | null | undefined): string | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  const match = /^(\d+(?:\.\d+)?)\s*;\s*(?:url\s*=\s*)?(?:"([^"]*)"|'([^']*)'|(\S+))\s*;?\s*$/i.exec(value);
  if (!match) return null;
  if (Number(match[1]) > MAX_META_REFRESH_DELAY_SECONDS) return null;
  return literalNavigationTarget(match[2] ?? match[3] ?? match[4]);
}

/**
 * Extract approved static control targets in DOM order. The same URL is kept
 * once (the first control kind wins); the cap bounds pathological pages and
 * reports how many eligible unique targets were dropped.
 */
export function staticControlTargetsFromDocument(
  $: CheerioAPI,
  maxTargets: number = MAX_STATIC_CONTROL_TARGETS,
): StaticControlExtraction {
  const cap = Math.max(0, Math.floor(maxTargets) || 0);
  const targets: StaticControlTarget[] = [];
  const seen = new Set<string>();
  let eligible = 0;

  const add = (url: string | null, kind: StaticControlKind, label: string): void => {
    if (!url) return;
    if (seen.has(url)) return;
    seen.add(url);
    eligible += 1;
    if (targets.length < cap) targets.push({ url, kind, label });
  };

  $('meta[http-equiv], button[formaction], input[formaction], [onclick]').each((_, element) => {
    const node = $(element);
    const tag = String((element as { tagName?: unknown }).tagName || '').toLowerCase();
    if (tag === 'meta') {
      if (String(node.attr('http-equiv') || '').trim().toLowerCase() === 'refresh') {
        add(parseMetaRefreshTarget(node.attr('content')), 'META_REFRESH', 'meta refresh');
      }
    }
    if (tag === 'button' || tag === 'input') {
      const formAction = node.attr('formaction');
      const type = String(node.attr('type') || (tag === 'button' ? 'submit' : 'text')).trim().toLowerCase();
      const submitLike = tag === 'button' ? type === 'submit' : type === 'submit' || type === 'image';
      if (formAction !== undefined && submitLike) {
        add(literalNavigationTarget(formAction), 'FORMACTION', node.text().trim() || `${tag} form action`);
      }
    }
    const onclick = node.attr('onclick');
    if (onclick !== undefined) {
      add(parseOnclickNavigation(onclick), 'ONCLICK_NAVIGATION', node.text().trim() || 'onclick control');
    }
  });

  return { targets, truncated: Math.max(0, eligible - targets.length) };
}
