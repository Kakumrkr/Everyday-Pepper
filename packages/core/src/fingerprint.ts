import { createHash } from 'node:crypto';
import { StateFingerprintSchema, type StateFingerprint } from '@pepper/contracts';

// The stale-proposal fingerprint (ADR-0028, playbook principle 6). A proposal stores the
// fingerprint of exactly what the member was shown; approval recomputes it from the world as it
// is now, inside the approval's transaction, and runs only if they match. Anything that would
// make the member's decision different must be in it:
// - the tool and its version (a tool whose behaviour changed is a different action);
// - the exact payload that will run;
// - the state the preview read (the touched rows' `updated_at`, the rules and hours it used);
// - the would-be messages (template and recipient ids).
// Hashing never stores anything, so the parts may hold whatever the preview read.

/** What a tool's preview fingerprints (S24 tools fill these in). */
export interface FingerprintParts {
  tool: string;
  toolVersion: number;
  payload: unknown;
  state: unknown;
  messages: unknown;
}

/** Separates this hash from any other SHA-256 of JSON we may compute. */
const DOMAIN = 'pepper.trust.fingerprint.v1\n';

/** The SHA-256 of the parts' canonical JSON. Throws on a value that is not plain JSON. */
export function stateFingerprint(parts: FingerprintParts): StateFingerprint {
  const body = canonicalJson({
    tool: parts.tool,
    toolVersion: parts.toolVersion,
    payload: parts.payload,
    state: parts.state,
    messages: parts.messages,
  });
  return StateFingerprintSchema.parse(
    createHash('sha256').update(DOMAIN).update(body).digest('hex'),
  );
}

/**
 * JSON with every object's keys sorted, so equal values give equal text whatever order they
 * were built in. Throws on anything JSON would drop or bend (`undefined`, functions, non-finite
 * numbers, dates, maps, big integers).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Not JSON: a number that is not finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const keys = Object.keys(value).sort();
    const record = value as Record<string, unknown>;
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  throw new TypeError(`Not JSON: ${typeof value}`);
}
