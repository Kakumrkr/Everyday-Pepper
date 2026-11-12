import {
  aiDisclosureSentence,
  PRIVACY_AI_SECTION,
  PRIVACY_PATH,
  SMS_AI_DISCLOSURE_LEAD,
  SMS_TERMS_SECTION,
} from '@pepper/contracts';
import { describe, expect, it } from 'vitest';
import { HELP_CONTACT_PATH, HELP_PATH } from './help';
import {
  DISCLOSURE_AS_QUOTED,
  LEGAL_DOCUMENTS,
  legalDate,
  PRIVACY,
  TERMS,
  type LegalBlock,
} from './legal';

// The terms and privacy pages' text (S59.5, AC-X-54…56).

const textOf = (blocks: readonly LegalBlock[]): string =>
  blocks
    .map((block) =>
      block.kind === 'list' || block.kind === 'steps' ? block.items.join('\n') : block.text,
    )
    .join('\n');

const section = (id: string) => {
  const found = PRIVACY.sections.find((each) => each.id === id);
  if (found === undefined) throw new Error(`no privacy section ${id}`);
  return { ...found, text: textOf(found.blocks) };
};

describe('the legal pages (AC-X-54)', () => {
  it.each(LEGAL_DOCUMENTS.map((doc) => [doc.title, doc] as const))(
    '%s: every section has a unique, URL-safe anchor and something to read',
    (_title, doc) => {
      const ids = doc.sections.map((each) => each.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const each of doc.sections) {
        expect(each.id).toMatch(/^[a-z][a-z-]*$/);
        expect(each.heading.length).toBeGreaterThan(0);
        expect(each.blocks.length).toBeGreaterThan(0);
      }
      expect(doc.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    },
  );

  it('links only to pages that exist: the other policy, its sections, and the help centre', () => {
    const known = new Set([
      HELP_PATH,
      HELP_CONTACT_PATH,
      ...LEGAL_DOCUMENTS.map((doc) => doc.path),
      ...LEGAL_DOCUMENTS.flatMap((doc) => doc.sections.map((each) => `${doc.path}#${each.id}`)),
    ]);
    const links = LEGAL_DOCUMENTS.flatMap((doc) =>
      doc.sections.flatMap((each) => each.blocks.filter((block) => block.kind === 'link')),
    );
    expect(links.length).toBeGreaterThan(0);
    for (const each of links) expect(known).toContain(each.href);
  });

  it('covers the AI, memory, support and how long each thing is kept, as Pepper behaves today', () => {
    expect(PRIVACY.sections.map((each) => each.id)).toEqual(
      expect.arrayContaining(['ai', 'memory', 'support', 'retention', 'rights', 'sharing']),
    );
    expect(section('memory').text).toMatch(/What I know/);
    expect(section('memory').text).toMatch(/one year/);
    expect(section('support').text).toMatch(/two-step verification/);
    const kept = section('retention').text;
    for (const period of ['90 days after the last message', '30 days', '24 hours', '7 days']) {
      expect(kept).toContain(period);
    }
    expect(section('rights').text).toContain('waits 30 days');
  });

  it('shows no square-bracket placeholder, except the business in the quoted line', () => {
    for (const doc of LEGAL_DOCUMENTS) {
      for (const each of doc.sections) {
        const text = textOf(each.blocks).replace(DISCLOSURE_AS_QUOTED, '');
        expect(text).not.toMatch(/\[[^\]]*\]/);
      }
    }
  });

  it('says the date in words', () => {
    expect(legalDate('2026-11-09')).toBe('November 9, 2026');
  });
});

describe('the AI section the emails link to (AC-X-56)', () => {
  it('has the anchor the emails use', () => {
    expect(PRIVACY.path).toBe(PRIVACY_PATH);
    expect(PRIVACY.sections.some((each) => each.id === PRIVACY_AI_SECTION)).toBe(true);
  });

  it('starts with the plain-words part for a client, quoting the sentence the emails carry', () => {
    const ai = section(PRIVACY_AI_SECTION);
    expect(ai.blocks[0]?.kind).toBe('p');
    expect(ai.text).toMatch(/^If you got an email from a business that uses Pepper/);
    expect(ai.blocks[1]).toEqual({ kind: 'quote', text: aiDisclosureSentence('[the business]') });
    expect(ai.text).toMatch(/never sees your email address or phone number/);
    expect(ai.text).toMatch(/unsubscribe/);
    // Texts carry their own line (S61.2, AC-X-69), quoted as they read.
    expect(ai.text).toContain(`its last line starts “${SMS_AI_DISCLOSURE_LEAD}”`);
  });

  it('is linked from the terms', () => {
    const links = TERMS.sections.flatMap((each) => each.blocks);
    expect(links).toContainEqual(
      expect.objectContaining({ kind: 'link', href: `${PRIVACY_PATH}#${PRIVACY_AI_SECTION}` }),
    );
  });
});

describe('the text-message sections the SMS box links to (S61.2, AC-X-64)', () => {
  const termsText = () => {
    const found = TERMS.sections.find((each) => each.id === SMS_TERMS_SECTION);
    if (found === undefined) throw new Error('no terms section for texts');
    return textOf(found.blocks);
  };

  it('has the carriers’ required terms: who, how often, rates, STOP, HELP, carriers', () => {
    const text = termsText();
    for (const words of [
      'Message frequency varies',
      'Message and data rates may apply',
      'STOP',
      'HELP',
      'Carriers are not liable',
    ]) {
      expect(text).toContain(words);
    }
  });

  it('says in the privacy policy how the yes is kept and that the number is never shared for marketing', () => {
    const texts = section(SMS_TERMS_SECTION).text;
    expect(texts).toMatch(/never needed to book/);
    expect(texts).toMatch(/exact words you agreed to/);
    expect(texts).toMatch(/never shared with or sold to anyone for their own marketing/);
    expect(section('sharing').text).toMatch(/Twilio/);
  });
});
