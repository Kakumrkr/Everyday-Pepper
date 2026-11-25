import { describe, expect, it } from 'vitest';
import { formatPhone, noteFrom, profileFields, profileFromFields } from './booking-profile';

describe('the booking page profile form (S47, AC-W8-7)', () => {
  it('sends each field in its stored form, and empty ones as not shown', () => {
    expect(
      profileFromFields({
        phone: '(555) 123-4567',
        publicAddress: ' 12 Main St \n Austin, TX 78701',
      }),
    ).toEqual({
      ok: true,
      profile: {
        phone: '+15551234567',
        publicAddress: '12 Main St\nAustin, TX 78701',
      },
    });
  });

  it('names what to fix under each field that is not right', () => {
    const answer = profileFromFields({ phone: '12', publicAddress: 'x' });
    expect(answer).toEqual({
      ok: false,
      errors: {
        phone: 'Enter a phone number such as (555) 123-4567',
        publicAddress: 'Enter the street, city and ZIP code',
      },
    });
  });

  it('fills the form from the stored profile', () => {
    expect(
      profileFields({ phone: '+15551234567', publicAddress: null, cancellationPolicy: 'Thanks' }),
    ).toEqual({ phone: '(555) 123-4567', publicAddress: '' });
  });

  it('checks the cancellation note, saved with the policy (S67.2)', () => {
    expect(noteFrom('  ')).toEqual({ ok: true, note: null });
    expect(noteFrom(' Running   late? Call us. ')).toEqual({
      ok: true,
      note: 'Running late? Call us.',
    });
    expect(noteFrom('a'.repeat(601))).toMatchObject({ ok: false });
  });

  it('shows a US phone the way people write it, and others as stored', () => {
    expect(formatPhone('+15551234567')).toBe('(555) 123-4567');
    expect(formatPhone('+442079460958')).toBe('+442079460958');
  });
});
