import { readdir, readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The eval fixtures go to the `pepper-dev-evals` project, which shares data with OpenAI for the
// free daily tokens (P1-7, ai-budget.md): everything in them is made up. This fails on an email
// address outside the domains reserved for examples (RFC 2606/6761) and on a phone number
// outside the fictional 555-0100…0199 range (S56a).

const root = fileURLToPath(new URL('../../', import.meta.url));
const SCANNED = ['evals/cases', 'evals/cassettes', 'evals/retrieval', 'src/evals/world.ts'];

const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;
const PHONE = /(?<![\w-])(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?![\w-])|\+1\d{10}\b/g;
const RESERVED_DOMAIN = /(?:^|\.)(?:example\.(?:com|net|org)|example|test|invalid|localhost)$/i;

/** Whether `phone` is in the fictional 555-0100…0199 range. */
function fictionalPhone(phone: string): boolean {
  return /^1?\d{3}5550(1\d\d)$/.test(phone.replace(/\D/g, ''));
}

/** Whether `domain` is reserved for examples. */
function reservedDomain(domain: string): boolean {
  return RESERVED_DOMAIN.test(domain);
}

/** The real-looking contacts in `text`. */
function realLookingContacts(text: string): string[] {
  const emails = [...text.matchAll(EMAIL)]
    .filter((match) => !reservedDomain(match[1] ?? ''))
    .map((match) => match[0]);
  const phones = [...text.matchAll(PHONE)]
    .map((match) => match[0])
    .filter((phone) => !fictionalPhone(phone));
  return [...emails, ...phones];
}

async function filesUnder(path: string): Promise<string[]> {
  const info = await stat(path);
  if (info.isFile()) return [path];
  const entries = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => filesUnder(join(path, entry.name))));
  return nested.flat();
}

describe('the eval fixtures hold only made-up contacts (S56a)', () => {
  it('tells real-looking contacts from the reserved and fictional ones', () => {
    expect(realLookingContacts('maria.lopez@example.test, ana@example.com, +12125550143')).toEqual(
      [],
    );
    expect(realLookingContacts('Call 212-555-0199 or (212) 555 0100')).toEqual([]);
    expect(realLookingContacts('maria@gmail.com and 212-555-1234 and +14155552671')).toEqual([
      'maria@gmail.com',
      '212-555-1234',
      '+14155552671',
    ]);
    // Ids and times are not phone numbers.
    expect(realLookingContacts('0199f4b2-7c1e-7a00-8000-0000000000b1 2026-11-03T15:00')).toEqual(
      [],
    );
  });

  it('finds none in the cases, cassettes, retrieval sets or the seeded world', async () => {
    const files = (await Promise.all(SCANNED.map((path) => filesUnder(join(root, path))))).flat();
    expect(files.length).toBeGreaterThan(100);
    const found: string[] = [];
    for (const file of files) {
      for (const contact of realLookingContacts(await readFile(file, 'utf8'))) {
        found.push(`${file.slice(root.length)}: ${contact}`);
      }
    }
    expect(found).toEqual([]);
  });
});
