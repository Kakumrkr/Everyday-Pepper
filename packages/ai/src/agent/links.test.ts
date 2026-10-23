import { describe, expect, it } from 'vitest';
import { LINK_REMOVED, LinkScrubber, withoutLinks } from './links.js';

describe('withoutLinks (LLM10: the AI writes no web addresses, S27)', () => {
  it('removes http, https and www addresses, Markdown targets included, and keeps the rest', () => {
    expect(withoutLinks('[Pay now](http://evil.example/pay)')).toBe(`[Pay now](${LINK_REMOVED})`);
    expect(withoutLinks('See HTTPS://x.example/a?b=1, or www.y.example.')).toBe(
      `See ${LINK_REMOVED}, or ${LINK_REMOVED}.`,
    );
    expect(withoutLinks('Maria is booked at 3pm. Approve it on the card.')).toBe(
      'Maria is booked at 3pm. Approve it on the card.',
    );
  });
});

describe('LinkScrubber (the same while the answer streams)', () => {
  const streamed = (deltas: string[]) => {
    const scrubber = new LinkScrubber();
    return deltas.map((delta) => scrubber.push(delta)).join('') + scrubber.flush();
  };

  it('removes an address split across deltas and gives back the rest unchanged', () => {
    const deltas = ['Here: [Pay', ' now](ht', 'tp://evil.', 'example/pay) ', 'thanks'];
    expect(streamed(deltas)).toBe(withoutLinks(deltas.join('')));
    expect(streamed(deltas)).not.toMatch(/https?:|evil/);
    expect(streamed(['Tomorrow ', 'is ', 'free.'])).toBe('Tomorrow is free.');
  });

  it('holds back only the unfinished last word, and never more than a bounded amount', () => {
    const scrubber = new LinkScrubber();
    expect(scrubber.push('Tomorrow is fr')).toBe('Tomorrow is ');
    expect(scrubber.push('ee.')).toBe('');
    expect(scrubber.flush()).toBe('free.');
    const long = 'a'.repeat(5_000);
    expect(new LinkScrubber().push(long).length).toBeGreaterThan(0);
  });
});
