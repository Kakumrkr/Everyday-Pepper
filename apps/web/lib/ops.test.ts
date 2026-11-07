import { describe, expect, it } from 'vitest';
import {
  OPS_PATHS,
  opsAccessOf,
  opsView,
  replyByEmailHref,
  waitedFor,
  waitedLong,
  waitingWords,
} from './ops';

const NOW = Date.parse('2026-11-09T15:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;

describe('waitedFor (AC-X-20)', () => {
  it.each([
    [0, 'Just in'],
    [59_000, 'Just in'],
    [-5 * MIN, 'Just in'],
    [MIN, '1 min'],
    [12 * MIN + 59_000, '12 min'],
    [59 * MIN, '59 min'],
    [60 * MIN, '1 h'],
    [3 * 60 * MIN + 59 * MIN, '3 h'],
    [23 * 60 * MIN, '23 h'],
    [24 * 60 * MIN, '1 d'],
    [2 * 24 * 60 * MIN + 5 * 60 * MIN, '2 d'],
  ])('%d ms → %s', (ms, words) => {
    expect(waitedFor(ago(ms), NOW)).toBe(words);
  });

  it('reads a bad time as just in', () => {
    expect(waitedFor('not a time', NOW)).toBe('Just in');
  });
});

describe('waitingWords', () => {
  it('says waiting in the waiting view and ago elsewhere', () => {
    expect(waitingWords('waiting', ago(3 * 60 * MIN), NOW)).toBe('3 h waiting');
    expect(waitingWords('answered', ago(3 * 60 * MIN), NOW)).toBe('3 h ago');
    expect(waitingWords('solved', ago(10_000), NOW)).toBe('Just in');
  });
});

describe('waitedLong', () => {
  it('is 4 h and more', () => {
    expect(waitedLong(ago(4 * 60 * MIN - 1), NOW)).toBe(false);
    expect(waitedLong(ago(4 * 60 * MIN), NOW)).toBe(true);
  });
});

describe('opsView and paths', () => {
  it('takes only the three views', () => {
    expect(opsView('answered')).toBe('answered');
    expect(opsView('solved')).toBe('solved');
    expect(opsView(['solved'])).toBe('waiting');
    expect(opsView('everything')).toBe('waiting');
    expect(opsView(undefined)).toBe('waiting');
    expect(OPS_PATHS.view('waiting')).toBe('/ops');
    expect(OPS_PATHS.view('solved')).toBe('/ops?view=solved');
    expect(OPS_PATHS.thread('a')).toBe('/ops/threads/a');
    expect(OPS_PATHS.request('b')).toBe('/ops/requests/b');
  });
});

describe('replyByEmailHref (AC-X-21)', () => {
  it('addresses the requester with the reference in the subject', () => {
    expect(replyByEmailHref('mo+x@out.test', 'PEP-ABCDEF')).toBe(
      'mailto:mo%2Bx@out.test?subject=Re%3A%20%5BPEP-ABCDEF%5D%20Your%20Pepper%20support%20request',
    );
  });
});

describe('opsAccessOf (AC-X-19)', () => {
  it('reads the api’s answer', () => {
    expect(opsAccessOf(200, { operator: true, name: 'Olive' })).toEqual({
      state: 'operator',
      me: { operator: true, name: 'Olive' },
    });
    expect(opsAccessOf(200, { name: 'Olive' })).toEqual({ state: 'unavailable' });
    expect(opsAccessOf(403, { code: 'mfa_required', message: 'x' })).toEqual({
      state: 'mfa_required',
    });
    expect(opsAccessOf(403, { code: 'forbidden', message: 'x' })).toEqual({ state: 'refused' });
    expect(opsAccessOf(401, undefined)).toEqual({ state: 'refused' });
    expect(opsAccessOf(502, undefined)).toEqual({ state: 'unavailable' });
    expect(opsAccessOf(0, undefined)).toEqual({ state: 'unavailable' });
  });
});
