// The words of an emailed reply (S59.3, ADR-0063 §6): HTML turned into plain text (never
// rendered), then the quoted email, the "Reply above this line" part and the signature cut, so
// the thread shows what the person wrote. Heuristic by nature: a layout it doesn't know keeps the
// whole text, which loses no words.

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity.startsWith('#')) {
      const code =
        entity[1]?.toLowerCase() === 'x'
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) &&
        code > 0 &&
        code <= 0x10ffff &&
        (code < 0xd800 || code > 0xdfff)
        ? String.fromCodePoint(code)
        : '';
    }
    return ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

/**
 * Where a mail app's quoted email starts in HTML (Gmail, Outlook, Yahoo, Apple Mail): the tag
 * holding one of these, and everything after it, is dropped. Literal markers, found with
 * `indexOf`: linear on any input.
 */
const HTML_QUOTE_MARKERS = [
  'gmail_quote',
  'id="appendonsend"',
  'id="divrplyfwdmsg"',
  'yahoo_quoted',
  'type="cite"',
];

function cutAtQuote(html: string): string {
  const lower = html.toLowerCase();
  // Only in the body: a style rule in the head may name the same classes.
  const body = Math.max(0, lower.indexOf('<body'));
  let cut = html.length;
  for (const marker of HTML_QUOTE_MARKERS) {
    const at = lower.indexOf(marker, body);
    if (at < 0) continue;
    const tag = lower.lastIndexOf('<', at);
    if (tag >= 0 && tag < cut) cut = tag;
  }
  return html.slice(0, cut);
}

const DROPPED_ELEMENTS = new Set(['head', 'style', 'script', 'title', 'template']);
const BLOCK_ENDS = new Set([
  'p',
  'div',
  'li',
  'tr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'table',
  'ul',
  'ol',
]);

/**
 * Plain text of an HTML email: no tags, scripts or styles; blocks on their own lines. One pass
 * with `indexOf` (never a backtracking pattern over the whole body), so hostile HTML (thousands
 * of unclosed tags) costs linear time.
 */
export function htmlToText(html: string): string {
  const body = cutAtQuote(html.slice(0, 2_000_000));
  const lower = body.toLowerCase();
  let out = '';
  let at = 0;
  while (at < body.length) {
    const open = body.indexOf('<', at);
    if (open < 0) {
      out += body.slice(at);
      break;
    }
    out += body.slice(at, open);
    if (lower.startsWith('<!--', open)) {
      const close = body.indexOf('-->', open + 4);
      if (close < 0) break;
      at = close + 3;
      continue;
    }
    const close = body.indexOf('>', open + 1);
    if (close < 0) break;
    const tag = /^\/?([a-z][a-z0-9]*)/.exec(lower.slice(open + 1, Math.min(close, open + 20)));
    const name = tag?.[1] ?? '';
    const closing = lower.charAt(open + 1) === '/';
    at = close + 1;
    if (!closing && DROPPED_ELEMENTS.has(name)) {
      const end = lower.indexOf(`</${name}`, at);
      if (end < 0) break;
      const endClose = body.indexOf('>', end);
      at = endClose < 0 ? body.length : endClose + 1;
      continue;
    }
    if (name === 'br') out += '\n';
    else if (name === 'blockquote' && !closing) out += '\n> ';
    else if (name === 'li' && !closing) out += '• ';
    else if (closing && BLOCK_ENDS.has(name)) out += '\n';
  }
  return decodeEntities(out)
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const SIGNATURE_LINES = [
  /^sent from my (iphone|ipad|android|mobile|phone|samsung|galaxy|pixel)/i,
  /^sent from (outlook|mail|yahoo mail|gmail)( for (ios|android|mac|windows))?/i,
  /^get outlook for (ios|android)/i,
  /^sent via /i,
];

const WROTE =
  /^(on|am|le|el|il|em|op)\s.+\s(wrote|schrieb|a écrit|escribió|ha scritto|escreveu|schreef)(?=[\s:]|$).*:\s*$/i;

function isWroteLine(line: string, next: string | undefined): boolean {
  // Gmail and Apple Mail: "On Mon, 8 Nov 2026 at 10:00, Pepper <…> wrote:" (and its common
  // translations), which some apps wrap over two lines.
  const trimmed = line.trim();
  // A quote line is short; long lines are never tested (the pattern is not linear).
  if (trimmed.length > 400) return false;
  if (WROTE.test(trimmed)) return true;
  return /^on\s/i.test(trimmed) && /\bwrote:\s*$/i.test(next?.trim() ?? '');
}

function isHeaderBlock(lines: readonly string[], at: number): boolean {
  // Outlook: "From: …" then "Sent:"/"Date:" and "Subject:" within the next lines.
  if (!/^\*?from:\*?\s/i.test(lines[at]?.trim() ?? '')) return false;
  const next = lines.slice(at + 1, at + 6).map((line) => line.trim());
  return (
    next.some((line) => /^\*?(sent|date):\*?\s/i.test(line)) &&
    next.some((line) => /^\*?(subject|to):\*?\s/i.test(line))
  );
}

/**
 * What the person wrote above the quoted email: cut at the "Reply above this line" marker
 * (`marker`), an "On … wrote:" line, Outlook's header block or separator, a quoted block that runs
 * to the end, or the signature delimiter (`-- `) and the mobile "Sent from" lines.
 */
export function stripQuotedReply(text: string, marker: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const markerWords = marker.replace(/[—–-]/g, '').trim().toLowerCase();
  let end = lines.length;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const bare = line.replace(/^[>\s]+/, '').trim();
    if (bare !== '' && bare.replace(/[—–-]/g, '').trim().toLowerCase() === markerWords) {
      end = i;
      break;
    }
    if (isWroteLine(line, lines[i + 1])) {
      end = i;
      break;
    }
    if (/^-{2,}\s*original message\s*-{2,}$/i.test(bare) || /^_{10,}$/.test(bare)) {
      end = i;
      break;
    }
    if (isHeaderBlock(lines, i)) {
      end = i;
      break;
    }
    if (line === '-- ' || line === '--') {
      end = i;
      break;
    }
  }
  let kept = lines.slice(0, end);
  // A quoted block that runs to the end (">"-prefixed lines and blank lines).
  let last = kept.length;
  while (last > 0 && /^\s*(>.*)?$/.test(kept[last - 1] ?? '')) last -= 1;
  if (last < kept.length && kept.slice(last).some((line) => line.trim().startsWith('>'))) {
    kept = kept.slice(0, last);
  }
  // Mobile signatures at the end.
  while (kept.length > 0) {
    const tail = (kept[kept.length - 1] ?? '').trim();
    if (tail === '' || SIGNATURE_LINES.some((pattern) => pattern.test(tail))) kept.pop();
    else break;
  }
  return kept.join('\n').trim();
}

/**
 * The reply's words: the text part when there is one, else the HTML's text; quotes and
 * signatures cut; control characters but line breaks and tabs removed.
 */
export function replyTextOf(
  email: { text: string | null; html: string | null },
  marker: string,
): string {
  const source =
    email.text !== null && email.text.trim() !== ''
      ? email.text
      : email.html === null
        ? ''
        : htmlToText(email.html);
  return (
    stripQuotedReply(source.slice(0, 1_000_000), marker)
      // eslint-disable-next-line no-control-regex -- the point is to remove control characters
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .trim()
  );
}
