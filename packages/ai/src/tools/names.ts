// What the model sees of a client's name (playbook principle 11, ADR-0029): the first name and
// the last initial, enough to talk about "Maria L." and tell two Marias apart. A client types
// their own name on the booking page, so it is untrusted text: keeping letters only, and at
// most a short first word, leaves no room for instructions hidden in it.

const FIRST_NAME_MAX = 20;
const LETTERS = /[^\p{L}\p{M}'’-]/gu;

/** "Maria Lopez" → "Maria L."; letters only, the first word at most 20 of them. */
export function shortClientName(name: string): string {
  const words = name
    .split(/\s+/)
    .map((word) => word.replace(LETTERS, ''))
    .filter((word) => /\p{L}/u.test(word));
  const first = Array.from(words[0] ?? '')
    .slice(0, FIRST_NAME_MAX)
    .join('');
  if (first === '') return 'Client';
  const last = words.length > 1 ? Array.from(words[words.length - 1] ?? '')[0] : undefined;
  return last === undefined ? first : `${first} ${last.toUpperCase()}.`;
}
