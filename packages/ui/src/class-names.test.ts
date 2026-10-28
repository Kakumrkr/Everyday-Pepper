import { describe, expect, it } from 'vitest';
import { chipClass, cx } from './class-names.js';

describe('cx', () => {
  it('joins truthy names', () => {
    expect(cx('a', false, null, undefined, '', 'b')).toBe('a b');
    expect(cx()).toBe('');
  });
});

describe('chipClass', () => {
  it('marks the selected chip', () => {
    expect(chipClass({ selected: true })).toContain('border-brand');
    expect(chipClass()).toContain('border-line');
    expect(chipClass({ className: 'x' }).endsWith(' x')).toBe(true);
  });
});
