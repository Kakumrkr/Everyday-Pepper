import { describe, expect, it } from 'vitest';
import { cx } from './class-names.js';

describe('cx', () => {
  it('joins truthy names', () => {
    expect(cx('a', false, null, undefined, '', 'b')).toBe('a b');
    expect(cx()).toBe('');
  });
});
