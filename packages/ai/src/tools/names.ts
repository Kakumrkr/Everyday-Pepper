// What the model sees of a client's name (playbook principle 11, ADR-0029): the first name and
// the last initial, enough to talk about "Maria L." and tell two Marias apart. A client types
// their own name on the booking page, so it is untrusted text: keeping letters only, and at
// most a short first word, leaves no room for instructions hidden in it.

const FIRST_NAME_MAX = 20;
const LETTERS = /[^\p{L}\p{M}'’-]/gu;

const wordsOf = (name: string) =>
  name
    .split(/\s+/)
    .map((word) => word.replace(LETTERS, ''))
    .filter((word) => /\p{L}/u.test(word));

/** "Maria Lopez" → "Maria L."; letters only, the first word at most 20 of them. */
export function shortClientName(name: string): string {
  const words = wordsOf(name);
  const first = clientFirstName(name);
  if (first === null) return 'Client';
  const last = words.length > 1 ? Array.from(words[words.length - 1] ?? '')[0] : undefined;
  return last === undefined ? first : `${first} ${last.toUpperCase()}.`;
}

/** "Maria Lopez" → "Maria" (a rebooking email's greeting, S36b); null without a letter. */
export function clientFirstName(name: string): string | null {
  const first = Array.from(wordsOf(name)[0] ?? '')
    .slice(0, FIRST_NAME_MAX)
    .join('');
  return first === '' ? null : first;
}
