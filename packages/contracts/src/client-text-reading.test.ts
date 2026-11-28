import { describe, expect, it } from 'vitest';
import {
  CLIENT_TEXT_READ_LIMITS,
  ClientTextQuestionSchema,
  ClientTextReadingSchema,
} from './client-text-reading.js';

const visitId = '7d5f0c1e-3b2a-4c8d-9e6f-1a2b3c4d5e6f';
const reading = {
  intent: 'confirm',
  visitId,
  askedFor: null,
  minutesLate: null,
  confidence: 'sure',
} as const;

describe('ClientTextReadingSchema (AC-X-238)', () => {
  it('takes a confirm of one visit', () => {
    expect(ClientTextReadingSchema.parse(reading)).toEqual(reading);
  });

  it('takes a reschedule with a date only, a time only, or both', () => {
    for (const askedFor of [
      { date: '2026-12-04', time: null },
      { date: null, time: '15:00' },
      { date: '2026-12-04', time: '09:30' },
    ]) {
      expect(
        ClientTextReadingSchema.safeParse({ ...reading, intent: 'reschedule', askedFor }).success,
      ).toBe(true);
    }
  });

  it('refuses a time asked for that is neither, or malformed', () => {
    for (const askedFor of [
      { date: null, time: null },
      { date: '2026-13-01', time: null },
      { date: null, time: '3pm' },
      { date: null, time: '24:00' },
    ]) {
      expect(
        ClientTextReadingSchema.safeParse({ ...reading, intent: 'reschedule', askedFor }).success,
      ).toBe(false);
    }
  });

  it('keeps each field to its intent', () => {
    expect(
      ClientTextReadingSchema.safeParse({
        ...reading,
        askedFor: { date: '2026-12-04', time: null },
      }).success,
    ).toBe(false);
    expect(ClientTextReadingSchema.safeParse({ ...reading, minutesLate: 10 }).success).toBe(false);
    expect(
      ClientTextReadingSchema.safeParse({ ...reading, intent: 'running_late', minutesLate: 10 })
        .success,
    ).toBe(true);
  });

  it('refuses minutes late out of range, an extra field, or an id that is not one', () => {
    const late = { ...reading, intent: 'running_late' };
    expect(ClientTextReadingSchema.safeParse({ ...late, minutesLate: 0 }).success).toBe(false);
    expect(
      ClientTextReadingSchema.safeParse({
        ...late,
        minutesLate: CLIENT_TEXT_READ_LIMITS.maxMinutesLate + 1,
      }).success,
    ).toBe(false);
    expect(ClientTextReadingSchema.safeParse({ ...reading, price: 0 }).success).toBe(false);
    expect(ClientTextReadingSchema.safeParse({ ...reading, visitId: 'v1' }).success).toBe(false);
  });
});

describe('ClientTextQuestionSchema (AC-X-237)', () => {
  const question = {
    text: 'Running 10 late',
    now: '2026-11-28T14:00:00.000Z',
    timeZone: 'America/New_York',
    visits: [{ id: visitId, startsAt: '2026-11-28T15:00:00.000Z' }],
  };

  it('takes a text and next visits as ids and times only', () => {
    expect(ClientTextQuestionSchema.safeParse(question).success).toBe(true);
    expect(
      ClientTextQuestionSchema.safeParse({
        ...question,
        visits: [{ ...question.visits[0], service: 'Color' }],
      }).success,
    ).toBe(false);
  });

  it('takes at most five visits and a text of at most 1600 characters', () => {
    const visits = Array.from({ length: CLIENT_TEXT_READ_LIMITS.visits + 1 }, () => ({
      id: visitId,
      startsAt: question.now,
    }));
    expect(ClientTextQuestionSchema.safeParse({ ...question, visits }).success).toBe(false);
    expect(
      ClientTextQuestionSchema.safeParse({ ...question, text: 'x'.repeat(1601) }).success,
    ).toBe(false);
    expect(ClientTextQuestionSchema.safeParse({ ...question, text: '   ' }).success).toBe(false);
  });
});
