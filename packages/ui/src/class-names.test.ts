import { describe, expect, it } from 'vitest';
import { buttonClass, chipClass, cx } from './class-names.js';

describe('cx', () => {
  it('joins truthy names', () => {
    expect(cx('a', false, null, undefined, '', 'b')).toBe('a b');
    expect(cx()).toBe('');
  });
});

describe('buttonClass', () => {
  it('defaults to a primary, 44 px tall pill', () => {
    const classes = buttonClass().split(' ');
    expect(classes).toEqual(expect.arrayContaining(['bg-brand', 'text-on-brand', 'rounded-full']));
    expect(classes).toContain('min-h-11');
  });

  it('keeps the tap target at every size and adds extra classes', () => {
    for (const size of ['md', 'sm'] as const) {
      expect(buttonClass({ size }).split(' ')).toContain('min-h-11');
    }
    expect(buttonClass({ variant: 'secondary', className: 'w-full' })).toMatch(
      /border-line.*w-full$/,
    );
    expect(buttonClass({ variant: 'quiet' })).toContain('text-brand');
  });
});

describe('chipClass', () => {
  it('marks the selected chip', () => {
    expect(chipClass({ selected: true })).toContain('border-brand');
    expect(chipClass()).toContain('border-line');
    expect(chipClass({ className: 'x' }).endsWith(' x')).toBe(true);
  });
});
