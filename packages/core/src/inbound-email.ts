// An emailed reply as the inbound job sees it (S59.3, ADR-0063), and the rules about it that
// need no database: is it an auto-reply, did the receiving server verify its sender, is it spam.
// Everything here is outside text: headers are read, never trusted beyond what is said below.

/** One header, as received (names in any case; order kept: the topmost first). */
export interface InboundHeader {
  name: string;
  value: string;
}

/** A file that came with an email; its bytes are fetched only when needed. */
export interface InboundAttachment {
  filename: string | null;
  /** As the sender labelled it: never trusted for what the bytes are. */
  contentType: string | null;
  /** In bytes, as the provider reports it; `null` when unknown. */
  size: number | null;
  /** Pasted into the body (`Content-Disposition: inline` or a `cid:`). */
  inline: boolean;
  content(): Promise<Uint8Array>;
}

/** An email the provider received, normalised by the `InboundMailSource` adapter. */
export interface InboundEmail {
  /** Lowercased address of `From`. */
  from: string;
  /** Lowercased addresses of `To` and `Cc`. */
  recipients: string[];
  subject: string;
  /** The plain-text part, if any. */
  text: string | null;
  /** The HTML part, if any: turned into text, never rendered. */
  html: string | null;
  headers: InboundHeader[];
  /** `In-Reply-To`, angle brackets included. */
  inReplyTo: string | null;
  /** The ids in `References`, oldest first. */
  references: string[];
  attachments: InboundAttachment[];
  /** The whole message's size in bytes, when known. */
  size: number | null;
}

/** Where the inbound job reads an email the webhook announced (Resend's API in production). */
export interface InboundMailSource {
  /** The email, or `null` when the provider has no email with this id. Throws to retry. */
  fetch(providerEmailId: string): Promise<InboundEmail | null>;
}

/** The largest email the job takes (Resend's own limit): anything bigger is refused. */
export const INBOUND_EMAIL_MAX_BYTES = 40 * 1024 * 1024;

function headerValues(email: Pick<InboundEmail, 'headers'>, name: string): string[] {
  const wanted = name.toLowerCase();
  return email.headers
    .filter((header) => header.name.toLowerCase() === wanted)
    .map((header) => header.value.trim());
}

const AUTO_SUBJECT =
  /^(auto(matic)?[\s-]*(reply|response|antwort)|out of (the )?office|abwesenheitsnotiz|réponse automatique|respuesta automática|i am (currently )?out of)/i;

/**
 * An answer no person wrote (RFC 3834 and what common systems send instead): `Auto-Submitted`
 * other than `no`, `X-Autoreply`/`X-Autorespond`, `Precedence: bulk/junk/list/auto_reply`, an
 * `X-Auto-Response-Suppress` of a robot, or an "Out of office"/"Automatic reply" subject.
 */
export function isAutoReply(email: Pick<InboundEmail, 'headers' | 'subject'>): boolean {
  const autoSubmitted = headerValues(email, 'auto-submitted');
  if (autoSubmitted.some((value) => value.toLowerCase() !== 'no')) return true;
  if (headerValues(email, 'x-autoreply').length > 0) return true;
  if (headerValues(email, 'x-autorespond').length > 0) return true;
  if (
    headerValues(email, 'precedence').some((value) =>
      ['bulk', 'junk', 'list', 'auto_reply'].includes(value.toLowerCase()),
    )
  ) {
    return true;
  }
  if (headerValues(email, 'x-auto-response-suppress').some((value) => /\ball\b/i.test(value))) {
    return true;
  }
  return AUTO_SUBJECT.test(email.subject.replace(/^(re|aw|fwd?):\s*/i, '').trim());
}

/**
 * The receiving server's spam verdict: SES's `X-SES-Spam-Verdict: FAIL` or `X-Spam-Flag: YES`.
 * A sender can write these too, but only to have their own email ignored.
 */
export function isSpam(email: Pick<InboundEmail, 'headers'>): boolean {
  if (headerValues(email, 'x-ses-spam-verdict').some((value) => /^fail$/i.test(value))) return true;
  if (headerValues(email, 'x-ses-virus-verdict').some((value) => /^fail$/i.test(value)))
    return true;
  return headerValues(email, 'x-spam-flag').some((value) => /^yes$/i.test(value));
}

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1).toLowerCase();
}

/** `example.com` is `mail.example.com`'s organisational parent, or the domain itself. */
function aligned(signer: string, fromDomain: string): boolean {
  const d = signer.toLowerCase().replace(/\.$/, '');
  return fromDomain === d || fromDomain.endsWith(`.${d}`) || d.endsWith(`.${fromDomain}`);
}

/**
 * Whether the receiving server verified the sender (ADR-0063 §4): only the topmost
 * `Authentication-Results` header counts, and only when its authserv-id is `authservId` (the
 * ones below were written on the sender's side). `pass`: DMARC passed for the `From` domain, or
 * a DKIM signature aligned with it passed; `fail`: neither; `unknown`: no such header (or no
 * `authservId` configured), so nothing can be said and the reply is held.
 */
export function senderVerdict(
  email: Pick<InboundEmail, 'headers' | 'from'>,
  authservId: string | null,
): 'pass' | 'fail' | 'unknown' {
  if (authservId === null) return 'unknown';
  const top = headerValues(email, 'authentication-results')[0];
  if (top === undefined) return 'unknown';
  const [server, ...rest] = top.split(';');
  const id = server?.trim().split(/\s+/)[0]?.toLowerCase();
  if (id !== authservId.toLowerCase()) return 'unknown';
  const fromDomain = domainOf(email.from);
  for (const part of rest.map((item) => item.trim())) {
    const dmarc = /^dmarc=(\w+)/i.exec(part);
    if (dmarc?.[1]?.toLowerCase() === 'pass') {
      // Only a pass for the From domain itself counts.
      const headerFrom = /header\.from=([^\s;]+)/i.exec(part)?.[1];
      if (headerFrom?.toLowerCase() === fromDomain) return 'pass';
    }
    const dkim = /^dkim=(\w+)/i.exec(part);
    if (dkim?.[1]?.toLowerCase() === 'pass') {
      const signer =
        /header\.d=([^\s;]+)/i.exec(part)?.[1] ?? /header\.i=@?([^\s;]+)/i.exec(part)?.[1];
      if (signer !== undefined && aligned(signer.replace(/^.*@/, ''), fromDomain)) return 'pass';
    }
  }
  return 'fail';
}

/** Splits a `References` header into its ids, angle brackets included. */
export function messageIdsOf(value: string | null | undefined): string[] {
  if (value === null || value === undefined) return [];
  return value.match(/<[^<>\s]+>/g) ?? [];
}
