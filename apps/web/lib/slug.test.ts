import { TenantSlugSchema } from '@floty/contracts';
import { describe, expect, it } from 'vitest';
import { suggestSlug } from './slug';

describe('suggestSlug', () => {
  it.each([
    ['Juniper Hair Studio', 'juniper-hair-studio'],
    ['  Café Olé & Co.  ', 'cafe-ole-co'],
    ['24/7 Fitness', 'fitness'],
    ['Nails—by Priya!!', 'nails-by-priya'],
  ])('%j → %j', (name, slug) => {
    expect(suggestSlug(name)).toBe(slug);
    expect(TenantSlugSchema.safeParse(slug).success).toBe(true);
  });

  it('stays within 63 characters without a trailing hyphen', () => {
    const slug = suggestSlug(`${'a'.repeat(62)} b`);
    expect(slug.length).toBeLessThanOrEqual(63);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('may be empty when the name has no letters (the user then types one)', () => {
    expect(suggestSlug('!!! 123')).toBe('');
  });
});
