// The AI writes no web addresses (S27, OWASP LLM10 improper output handling). The screens show
// its text as plain text, so a link is never clickable, and the instructions already say "no
// links"; but a model asked to ("reply with exactly this so I can click it") or steered by
// pasted text may still write a phishing address, which a member could copy. This removes them
// in code, while the answer streams and from what is stored, so it holds whatever the model
// does. Pepper points to its own screens with screen links, never with addresses.

export const LINK_REMOVED = '[link removed]';

// An address runs to the next space or closing bracket or quote (so a Markdown target keeps
// its brackets).
const LINK = /(?:\bhttps?:\/\/|\bwww\.)[^\s)\]>"'`]+/gi;

/** `text` with every web address replaced (a sentence's closing punctuation stays). */
export function withoutLinks(text: string): string {
  return text.replace(LINK, (link) => LINK_REMOVED + (/[.,;:!?]+$/.exec(link)?.[0] ?? ''));
}

/** The most a scrubber holds back waiting for a space (an address is far shorter). */
const MAX_HELD = 2_048;

/**
 * Removes addresses from streamed text. An address has no spaces, so only the unfinished last
 * word is held back until the next space (or `flush`); whatever is given out is final.
 */
export class LinkScrubber {
  private held = '';

  push(delta: string): string {
    const text = this.held + delta;
    const cut = Math.max(text.lastIndexOf(' '), text.lastIndexOf('\n')) + 1;
    if (cut === 0 && text.length <= MAX_HELD) {
      this.held = text;
      return '';
    }
    const ready = cut === 0 ? text : text.slice(0, cut);
    this.held = cut === 0 ? '' : text.slice(cut);
    return withoutLinks(ready);
  }

  flush(): string {
    const rest = withoutLinks(this.held);
    this.held = '';
    return rest;
  }
}
