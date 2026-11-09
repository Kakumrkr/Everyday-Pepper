import { describe, expect, it } from 'vitest';
import {
  aiDisclosureLines,
  aiDisclosureSentence,
  PRIVACY_AI_SECTION,
  PRIVACY_PATH,
  privacyAiUrl,
} from './legal.js';

describe('the AI disclosure (AC-X-55, AC-X-56)', () => {
  it('names the business the client knows', () => {
    expect(aiDisclosureSentence('Fade Room')).toBe(
      'Written with help from Pepper, the AI assistant Fade Room uses.',
    );
  });

  it('links to the privacy policy’s AI section, absolute and with one slash', () => {
    expect(privacyAiUrl('https://app.example.com')).toBe('https://app.example.com/privacy#ai');
    expect(privacyAiUrl('https://app.example.com/')).toBe('https://app.example.com/privacy#ai');
    expect(privacyAiUrl('http://localhost:3000//')).toBe('http://localhost:3000/privacy#ai');
    expect(`${PRIVACY_PATH}#${PRIVACY_AI_SECTION}`).toBe('/privacy#ai');
  });

  it('is the sentence, then the link on a line of its own', () => {
    const [sentence, more] = aiDisclosureLines('Fade Room', 'https://app.example.com');
    expect(sentence).toBe(aiDisclosureSentence('Fade Room'));
    expect(more).toMatch(/ https:\/\/app\.example\.com\/privacy#ai$/);
  });
});
