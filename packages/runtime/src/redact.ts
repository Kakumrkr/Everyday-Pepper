/**
 * Removes secrets and personal data from anything about to leave the process as a log line or
 * an error report. Keys are matched by name; strings are scrubbed for patterns that look like
 * PII or credentials, wherever they appear (messages, error messages, stack traces).
 */

export const REDACTED = '[redacted]';

/** Keys whose values are never written out, whatever they hold. */
const SENSITIVE_KEY =
  /pass(word|wd|phrase)?$|secret|token$|session(_?id)?$|authori[sz]ation|cookie|api[-_]?key|private[-_]?key|credential|dsn|e-?mail|phone|ssn|database_?url|redis_?url/i;

const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;
// Bearer tokens in free text; an `authorization` key is redacted whole anyway.
const BEARER = /\b(bearer)\s+[\w.~+/=-]{8,}/gi;
const EMAIL = /[\w.+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}/gi;
// North American numbers in common formats: +1 (555) 123-4567, 555.123.4567, 5551234567.
const PHONE = /(?<![\w-])(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?![\w-])/g;

const MAX_DEPTH = 8;

/** Scrubs credentials, emails and phone numbers out of free text. */
export function redactString(value: string): string {
  return value
    .replace(URL_CREDENTIALS, `$1${REDACTED}@`)
    .replace(BEARER, `$1 ${REDACTED}`)
    .replace(EMAIL, '[email]')
    .replace(PHONE, '[phone]');
}

/**
 * Returns a redacted copy of `value`: sensitive keys are replaced, strings scrubbed, errors
 * turned into plain `{ type, message, stack }` objects. Cycles and very deep nesting are cut off.
 * The input is never mutated.
 */
export function redact(value: unknown): unknown {
  return walk(value, 0, new WeakSet());
}

function walk(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object' || value === null) return value;
  if (seen.has(value)) return '[circular]';
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return '[binary]';

  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1, seen));
    if (value instanceof Error) return walkError(value, depth, seen);
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = SENSITIVE_KEY.test(key) ? REDACTED : walk(item, depth + 1, seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

function walkError(error: Error, depth: number, seen: WeakSet<object>): Record<string, unknown> {
  const output: Record<string, unknown> = {
    type: error.name,
    message: redactString(error.message),
  };
  if (error.stack !== undefined) output['stack'] = redactString(error.stack);
  // Own enumerable extras (`code`, `status`, ...), redacted like any other object.
  for (const [key, item] of Object.entries(error)) {
    if (key === 'name' || key === 'message' || key === 'stack') continue;
    output[key] = SENSITIVE_KEY.test(key) ? REDACTED : walk(item, depth + 1, seen);
  }
  if (error.cause !== undefined) output['cause'] = walk(error.cause, depth + 1, seen);
  return output;
}
