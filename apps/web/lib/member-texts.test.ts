import type { MemberTexts } from '@pepper/contracts';
import { describe, expect, it } from 'vitest';
import {
  cardTextsHint,
  cardTextsSavedNote,
  checkedNote,
  codeSentLine,
  isCodeShaped,
  numberAction,
  numberLine,
  typedNumber,
} from './member-texts';

const none: MemberTexts = { phone: null, cardTexts: false, canTextCards: true };
const checked: MemberTexts = { phone: '+15550102233', cardTexts: false, canTextCards: true };
const on: MemberTexts = { ...checked, cardTexts: true };

describe('Your number (AC-X-88)', () => {
  it('shows the checked number as people read it, or that there is none', () => {
    expect(numberLine(none)).toBe('None yet');
    expect(numberLine(checked)).toBe('(555) 010-2233');
    expect(numberAction(none)).toBe('Add your number');
    expect(numberAction(checked)).toBe('Change number');
  });

  it('names the typed number and how long the code works', () => {
    const now = new Date('2026-11-20T15:00:00Z');
    expect(codeSentLine('555 010 2233', '2026-11-20T15:10:00Z', now)).toBe(
      'I texted a code to (555) 010-2233. It works for 10 minutes.',
    );
    expect(codeSentLine('+1 (555) 010-2233', '2026-11-20T15:00:20Z', now)).toBe(
      'I texted a code to (555) 010-2233. It works for 1 minute.',
    );
    // Past its end (a slow clock): never "0 minutes".
    expect(codeSentLine('5550102233', '2026-11-20T14:59:00Z', now)).toContain('1 minute.');
    expect(typedNumber('+44 20 7946 0000')).toBe('+442079460000');
  });

  it('waits for six digits', () => {
    expect(isCodeShaped('482193')).toBe(true);
    expect(isCodeShaped(' 482193 ')).toBe(true);
    expect(isCodeShaped('48219')).toBe(false);
    expect(isCodeShaped('48a193')).toBe(false);
  });
});

describe('Text me cards (AC-X-89)', () => {
  it('shows the exact words agreed to, with the business name, once a number is checked', () => {
    expect(cardTextsHint(checked, 'Fade Studio')).toBe(
      'Text me cards that need my OK from Fade Studio at this number. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help.',
    );
    expect(cardTextsHint(none, 'Fade Studio')).toMatch(/^Add your number first\./);
  });

  it('says a new number turned cards off, else what comes next', () => {
    expect(checkedNote(on, checked)).toMatch(/off for the new number/);
    expect(checkedNote(none, checked)).toBe(
      'Number checked. Turn on Text me cards to approve by text.',
    );
    expect(checkedNote(on, on)).toBe('Number checked. Cards that need your OK come to it by text.');
  });

  it('says what a save did', () => {
    expect(cardTextsSavedNote(true)).toBe('Saved. I’ll text you cards that need your OK.');
    expect(cardTextsSavedNote(false)).toBe('Saved. Cards stay in the app, no texts.');
  });
});
