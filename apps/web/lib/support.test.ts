import { describe, expect, it } from 'vitest';
import {
  authorLabel,
  newRequestHref,
  supportContext,
  supportTime,
  SUPPORT_STATUS,
} from './support';

// The words and context of support requests (S59, AC-X-14…16).

describe('supportContext', () => {
  it('takes the page, the article, the error and the screen size when they have the api’s shapes', () => {
    expect(
      supportContext(
        { from: '/clients/import', topic: 'import-clients', error: 'abc123' },
        { width: 375.4, height: 812 },
      ),
    ).toEqual({
      page: '/clients/import',
      topic: 'import-clients',
      errorRef: 'abc123',
      viewport: { width: 375, height: 812 },
    });
  });

  it('drops anything else a pasted link could carry', () => {
    expect(
      supportContext(
        { from: '//evil.test/x', topic: 'Not A Slug', error: 'has spaces' },
        { width: 0, height: 0 },
      ),
    ).toEqual({});
    expect(supportContext({ from: 'https://evil.test' }, null)).toEqual({});
    expect(supportContext({ from: `/${'a'.repeat(250)}` }, null)).toEqual({});
  });
});

describe('newRequestHref', () => {
  it('builds the form’s address from where it is opened', () => {
    expect(newRequestHref({})).toBe('/support/new');
    expect(newRequestHref({ page: '/more' })).toBe('/support/new?from=%2Fmore');
    expect(newRequestHref({ page: '/help/team', topic: 'team', error: 'x1' })).toBe(
      '/support/new?from=%2Fhelp%2Fteam&topic=team&error=x1',
    );
  });
});

describe('words', () => {
  it('names the writer and the status as people read them', () => {
    expect(authorLabel({ kind: 'you' })).toBe('You');
    expect(authorLabel({ kind: 'teammate', name: 'Jess' })).toBe('Jess');
    expect(authorLabel({ kind: 'former_member' })).toBe('A former team member');
    expect(authorLabel({ kind: 'pepper' })).toBe('Pepper team');
    expect(SUPPORT_STATUS.pepper_replied.label).toBe('Pepper replied');
  });

  it('says when, on the business’s clock', () => {
    const now = Date.parse('2026-11-07T20:00:00Z');
    expect(supportTime('2026-11-07T19:05:00Z', 'America/New_York', now)).toBe('Today, 2:05 PM');
    expect(supportTime('2026-11-06T14:00:00Z', 'America/New_York', now)).toBe('Yesterday, 9:00 AM');
    expect(supportTime('2026-11-03T14:00:00Z', 'America/New_York', now)).toBe('Nov 3, 9:00 AM');
  });
});
