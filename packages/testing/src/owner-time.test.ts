import { describe, expect, it } from 'vitest';
import { OWNER_TIME_SECONDS, OwnerClock, formatSeconds, wordCount } from './owner-time.js';

const { tap, think, typeChar, readWord, emailWait, pickPhoto } = OWNER_TIME_SECONDS;

describe('the owner time model (S47.3)', () => {
  it('charges a tap with a moment of thought before it', () => {
    expect(new OwnerClock().step('a').tap().total()).toBe(think + tap);
    expect(new OwnerClock().step('a').tap(3).total()).toBeCloseTo(3 * (think + tap));
  });

  it('charges typing per character after tapping into the field', () => {
    expect(new OwnerClock().step('a').type('Ana Reyes').total()).toBeCloseTo(
      think + tap + 9 * typeChar,
    );
  });

  it('charges reading by the words on screen', () => {
    expect(wordCount('  Check your\ninbox  now ')).toBe(4);
    expect(wordCount('')).toBe(0);
    expect(new OwnerClock().step('a').read('Check your inbox').total()).toBeCloseTo(3 * readWord);
  });

  it('adds fixed costs and keeps each step apart', () => {
    const clock = new OwnerClock()
      .step('Confirm email')
      .wait('emailWait')
      .step('Photos')
      .wait('pickPhoto', 2);
    expect(clock.steps()).toEqual([
      { name: 'Confirm email', seconds: emailWait },
      { name: 'Photos', seconds: 2 * pickPhoto },
    ]);
    expect(clock.total()).toBe(emailWait + 2 * pickPhoto);
  });

  it('refuses a charge before any step, so no time goes unreported', () => {
    expect(() => new OwnerClock().tap()).toThrow('start a step');
  });

  it('reports each step, the total and the wall clock in minutes and seconds', () => {
    const report = new OwnerClock().step('Sign up').wait('emailWait', 3).report('Owner', 61_400);
    expect(report).toContain('Owner');
    expect(report).toMatch(/Sign up\s+1:30/);
    expect(report).toMatch(/Total \(model\)\s+1:30/);
    expect(report).toMatch(/Wall clock \(this machine\)\s+1:01/);
  });

  it('formats seconds as m:ss', () => {
    expect(formatSeconds(0)).toBe('0:00');
    expect(formatSeconds(59.6)).toBe('1:00');
    expect(formatSeconds(601)).toBe('10:01');
  });
});
