/**
 * Unicode boundary helpers.
 *
 * PostgreSQL rejects JSON escape sequences that encode an unpaired UTF-16
 * surrogate (for example `\udcca`). JavaScript strings can carry such values
 * from upstream payloads, and `JSON.stringify` preserves them, so a channel
 * trail write can fail deterministically with:
 *   invalid input syntax for type json
 *   Unicode low surrogate must follow a high surrogate
 *
 * Normalize every string at the persistence boundary. Well-formed surrogate
 * pairs are preserved; lone surrogates become U+FFFD, the standard replacement
 * character for unrepresentable input.
 */

export function toWellFormedString(value: string): string {
  const native = (value as unknown as { toWellFormed?: () => string }).toWellFormed;
  if (typeof native === 'function') return native.call(value);
  let out = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += value[index] + value[index + 1];
        index += 1;
      } else {
        out += '\uFFFD';
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      out += '\uFFFD';
    } else {
      out += value[index];
    }
  }
  return out;
}

/** Deep-copy plain objects/arrays, normalizing every string (and object key). */
export function toWellFormedDeep<T>(value: T): T {
  if (typeof value === 'string') return toWellFormedString(value) as unknown as T;
  if (Array.isArray(value)) return value.map(item => toWellFormedDeep(item)) as unknown as T;
  if (value && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      // A null-prototype destination keeps every JSON key as an own data
      // property. Assigning to a plain {} would treat a parsed "__proto__"
      // key as a prototype mutation and silently drop that field on output.
      const out: Record<string, unknown> = Object.create(null);
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        out[toWellFormedString(key)] = toWellFormedDeep(item);
      }
      return out as T;
    }
  }
  return value;
}

/** JSON serialization that can never emit an unpaired surrogate escape. */
export function stringifyWellFormedJson(value: unknown): string {
  return JSON.stringify(toWellFormedDeep(value)) ?? 'null';
}
