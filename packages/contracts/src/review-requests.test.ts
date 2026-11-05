import { describe, expect, it } from 'vitest';
import { FeedSettingsChangeSchema } from './feed.js';
import { ReviewUrlSchema } from './review-requests.js';

describe('ReviewUrlSchema (S55.2)', () => {
  it.each([
    'https://g.page/r/CbX3a/review',
    'https://www.yelp.com/writeareview/biz/fade-room',
    '  https://fade-room.com/reviews  ',
  ])('takes %s', (value) => {
    expect(ReviewUrlSchema.parse(value)).toBe(value.trim());
  });

  it.each([
    'http://g.page/r/abc', // not https
    'g.page/r/abc', // no scheme
    'https://localhost/review', // no real host
    'https://10.0.0.5/review', // an IP address
    'https://[::1]/review',
    'https://intranet.local1/review', // not a public name
    'https://user:pass@g.page/r/abc', // credentials
    'https://g.page/r/a b', // a space
    'javascript:alert(1)',
    `https://g.page/${'a'.repeat(500)}`, // too long
  ])('refuses %s', (value) => {
    expect(ReviewUrlSchema.safeParse(value).success).toBe(false);
  });

  it('is set or cleared with the feed settings', () => {
    expect(FeedSettingsChangeSchema.parse({ reviewUrl: null })).toEqual({ reviewUrl: null });
    expect(FeedSettingsChangeSchema.safeParse({ reviewUrl: 'http://x.com' }).success).toBe(false);
  });
});
