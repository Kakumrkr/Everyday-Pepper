// The legal pages and the AI disclosure in client email (S59.5, ADR-0064). One place for the
// paths, the AI section's anchor and the sentence, so the privacy page, every AI-written email
// and their tests can't drift apart: an email's link always lands on the section that quotes
// the line the client just read.

export const TERMS_PATH = '/terms';
export const PRIVACY_PATH = '/privacy';

/** The privacy policy's "Pepper, the AI assistant" section: its `id` and the emails' `#…`. */
export const PRIVACY_AI_SECTION = 'ai';

/**
 * The text-message sections of both pages (S61.2): what the booking page's SMS box links to,
 * the carriers' required terms (who texts, how often, rates, STOP, HELP) and privacy.
 */
export const SMS_TERMS_SECTION = 'texts';

/** The one sentence an email whose words the AI wrote carries above its footer (AC-X-55). */
export function aiDisclosureSentence(businessName: string): string {
  return `Written with help from Pepper, the AI assistant ${businessName} uses.`;
}

/** The absolute link to the AI section, from the app's base URL (AC-X-56). */
export function privacyAiUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${PRIVACY_PATH}#${PRIVACY_AI_SECTION}`;
}

/**
 * The disclosure as an email's lines: the sentence, then where to read more. Plain text, so a
 * mail app turns the bare URL into a link the client taps.
 */
export function aiDisclosureLines(businessName: string, baseUrl: string): string[] {
  return [
    aiDisclosureSentence(businessName),
    `How Pepper works and what it does with your details: ${privacyAiUrl(baseUrl)}`,
  ];
}
