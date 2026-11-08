import type { InboundAttachment, InboundEmail, InboundMailSource } from '@pepper/core';
import { messageIdsOf } from '@pepper/core';
import { z } from 'zod';

// Resend's received emails (S59.3, ADR-0063 §3): `GET /emails/receiving/:id` for the email and
// `GET /emails/receiving/:id/attachments/:attachmentId` for a file's short-lived download link.
// Coded from Resend's documentation and kept behind core's `InboundMailSource` port; S57
// confirms it against a live inbound domain. Every response is outside input: validated, sized,
// and never logged.

const API = 'https://api.resend.com';
const TIMEOUT_MS = 15_000;
/** The largest attachment fetched (a screenshot's limit is 10 MB; a little room for encoding). */
const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024;

const AddressListSchema = z
  .union([z.array(z.string().max(1000)).max(500), z.string().max(10_000)])
  .nullish();

const HeadersSchema = z
  .union([
    z.array(z.object({ name: z.string().max(200), value: z.string().max(20_000) })).max(500),
    z.record(
      z.string().max(200),
      z.union([z.string().max(20_000), z.array(z.string().max(20_000)).max(100)]),
    ),
  ])
  .nullish();

const ReceivedEmailSchema = z.object({
  id: z.string().min(1).max(200),
  from: z.string().max(1000),
  to: AddressListSchema,
  cc: AddressListSchema,
  subject: z.string().max(5000).nullish(),
  text: z.string().max(5_000_000).nullish(),
  html: z.string().max(10_000_000).nullish(),
  headers: HeadersSchema,
  message_id: z.string().max(998).nullish(),
  attachments: z
    .array(
      z.object({
        id: z.string().min(1).max(200),
        filename: z.string().max(500).nullish(),
        content_type: z.string().max(200).nullish(),
        content_disposition: z.string().max(200).nullish(),
        content_id: z.string().max(500).nullish(),
        size: z.number().int().nonnegative().nullish(),
      }),
    )
    .max(100)
    .nullish(),
});

const AttachmentLinkSchema = z.object({
  download_url: z.url({ protocol: /^https$/ }),
  size: z.number().int().nonnegative().nullish(),
});

/**
 * The address of `Name <a@b>` or `a@b`, lowercased; `''` when there is none. The address is
 * the last `<…>` (a display name may hold anything, `"<owner@biz>" <evil@x>` included), else a
 * bare address with nothing else around it.
 */
export function addressOf(value: string): string {
  const angled = [...value.matchAll(/<([^<>\s"]+@[^<>\s"]+)>/g)].at(-1)?.[1];
  if (angled !== undefined) return angled.toLowerCase();
  const bare = /^\s*([^\s<>",;]+@[^\s<>",;]+)\s*$/.exec(value)?.[1];
  return (bare ?? '').toLowerCase();
}

function addressesOf(value: z.infer<typeof AddressListSchema>): string[] {
  if (value === null || value === undefined) return [];
  const list = typeof value === 'string' ? value.split(',') : value;
  return list.map(addressOf).filter((address) => address !== '');
}

function headersOf(value: z.infer<typeof HeadersSchema>): { name: string; value: string }[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value;
  return Object.entries(value).flatMap(([name, values]) =>
    (Array.isArray(values) ? values : [values]).map((one) => ({ name, value: one })),
  );
}

function headerOf(
  headers: readonly { name: string; value: string }[],
  name: string,
): string | null {
  return headers.find((header) => header.name.toLowerCase() === name)?.value ?? null;
}

export interface ResendInboundOptions {
  apiKey: string;
  /** Tests give their own; production uses the global `fetch`. */
  fetch?: typeof fetch;
}

/** `InboundMailSource` on Resend's API. */
export class ResendInboundSource implements InboundMailSource {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ResendInboundOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  private async api(path: string): Promise<unknown> {
    const response = await this.fetchImpl(`${API}${path}`, {
      headers: { Authorization: `Bearer ${this.options.apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new ResendInboundError(response.status);
    return response.json();
  }

  async fetch(providerEmailId: string): Promise<InboundEmail | null> {
    const id = encodeURIComponent(providerEmailId);
    const body = await this.api(`/emails/receiving/${id}`);
    if (body === null) return null;
    const email = ReceivedEmailSchema.parse(body);
    const headers = headersOf(email.headers);
    const attachments = (email.attachments ?? []).map((attachment): InboundAttachment => ({
      filename: attachment.filename ?? null,
      contentType: attachment.content_type ?? null,
      size: attachment.size ?? null,
      inline:
        (attachment.content_disposition ?? '').toLowerCase().startsWith('inline') ||
        (attachment.content_id ?? '') !== '',
      content: () => this.download(id, attachment.id),
    }));
    const text = email.text ?? null;
    const html = email.html ?? null;
    return {
      from: addressOf(email.from),
      recipients: [...addressesOf(email.to), ...addressesOf(email.cc)],
      subject: email.subject ?? '',
      text,
      html,
      headers,
      inReplyTo: messageIdsOf(headerOf(headers, 'in-reply-to'))[0] ?? null,
      references: messageIdsOf(headerOf(headers, 'references')),
      attachments,
      // Resend reports no total: the parts it gives, a lower bound (it refuses over 40 MB itself).
      size:
        (text?.length ?? 0) +
        (html?.length ?? 0) +
        (email.attachments ?? []).reduce((sum, attachment) => sum + (attachment.size ?? 0), 0),
    };
  }

  private async download(emailId: string, attachmentId: string): Promise<Uint8Array> {
    const link = AttachmentLinkSchema.parse(
      await this.api(
        `/emails/receiving/${emailId}/attachments/${encodeURIComponent(attachmentId)}`,
      ),
    );
    if ((link.size ?? 0) > MAX_ATTACHMENT_BYTES) throw new ResendInboundError(413);
    // The link is the file itself, signed by Resend: no API key goes with it.
    const response = await this.fetchImpl(link.download_url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok || response.body === null) throw new ResendInboundError(response.status);
    if (Number(response.headers.get('content-length') ?? 0) > MAX_ATTACHMENT_BYTES) {
      throw new ResendInboundError(413);
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ATTACHMENT_BYTES) {
        await reader.cancel();
        throw new ResendInboundError(413);
      }
      chunks.push(value);
    }
    return new Uint8Array(Buffer.concat(chunks, size));
  }
}

/** Resend answered with this status (the job retries the email later). */
export class ResendInboundError extends Error {
  constructor(readonly statusCode: number) {
    super(`Resend answered ${String(statusCode)}`);
    this.name = 'ResendInboundError';
  }
}
