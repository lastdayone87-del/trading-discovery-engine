'use strict';

const GOOGLE_API_KEY_PATTERN = /AIza[0-9A-Za-z_-]{2,}/g;
const URL_KEY_PATTERN = /([?&]key=)[^&\s]+/gi;
const SECRET_PROPERTY_PATTERN = /^(?:providerKey|apiKey|youtubeApiKey|key)$/i;

function redactString(value) {
  return String(value)
    .replace(GOOGLE_API_KEY_PATTERN, '[REDACTED_YOUTUBE_API_KEY]')
    .replace(URL_KEY_PATTERN, '$1[REDACTED_YOUTUBE_API_KEY]');
}

function sanitizeForLog(value, seen = new WeakSet(), depth = 0) {
  if (typeof value === 'string') return redactString(value);
  if (value == null || typeof value !== 'object') return value;
  if (depth > 8) return '[TRUNCATED]';
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);

  if (value instanceof Error) {
    const output = {
      name: value.name,
      message: redactString(value.message),
      stack: typeof value.stack === 'string' ? redactString(value.stack) : undefined
    };
    for (const key of Object.getOwnPropertyNames(value)) {
      if (key === 'name' || key === 'message' || key === 'stack') continue;
      if (SECRET_PROPERTY_PATTERN.test(key)) {
        output[key] = '[REDACTED]';
        continue;
      }
      try { output[key] = sanitizeForLog(value[key], seen, depth + 1); } catch { output[key] = '[UNAVAILABLE]'; }
    }
    return output;
  }

  if (Array.isArray(value)) return value.map(item => sanitizeForLog(item, seen, depth + 1));

  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_PROPERTY_PATTERN.test(key)) output[key] = '[REDACTED]';
    else output[key] = sanitizeForLog(item, seen, depth + 1);
  }
  return output;
}

function wrapConsoleMethod(method) {
  const original = console[method].bind(console);
  console[method] = (...args) => original(...args.map(arg => sanitizeForLog(arg)));
}

for (const method of ['log', 'warn', 'error']) wrapConsoleMethod(method);

module.exports = { redactString, sanitizeForLog };
