# ADR-0063: Replies by email: signed reply addresses, a verified sender, the same rules as the app

- **Status:** Accepted. Pre-approved by the user at the S59.3 brief on 2026-11-08 ("Go ahead with your recommendation and complete the session"). The brief was revised before that answer, at the user's request, to aim for the standard of the leading support tools.
- **Date:** 2026-11-08
- **Builds on:** ADR-0010 (RLS), ADR-0024 (outbox), ADR-0025 (jobs), ADR-0040 (signed unsubscribe links), ADR-0062 (the support console, its Part 3 screenshots), [PCR-010](../plan/changes/PCR-010.md) (our own support system, Resend as the only mail provider)

## Context
Since S59, Pepper's answers to a request reach the member by email, but a reply to that email went to the team's inbox and never back into the thread. Owners live in their mail app; the leading support tools (Zendesk, Help Scout, Front, Intercom) all let a customer answer from it. Inbound mail is outside text from the internet, so how a reply is matched to a request, and who may write into a business's thread by email, has to be decided as carefully as a sign-in.

## Decision
1. **Signed reply addresses.** Each request has one reply address, `reply+<reference>-<key version>-<mac>@<INBOUND_EMAIL_DOMAIN>`, e.g. `reply+pep-7k2m9q-1-…@reply.example.com`.
   - The MAC is HMAC-SHA256 over the version and the reference, 20 base32 characters (100 bits). The key comes from the outbox key by HKDF (`pepper/support-reply-addresses/v<n>`), the way unsubscribe links do it (ADR-0040).
   - Lowercase base32 only, so a mail server that changes the address's case breaks nothing. The local part stays well under 64 characters.
   - The key version lets the key change: a later version is added beside the earlier one, so addresses already in people's inboxes keep working until the old version is retired.
   - The address names the request, not a person. Who may write is decided by the sender check (4), so one address serves the whole thread.
2. **Outgoing headers.** Emails to members about a request (the team's answer, the close after 7 quiet days) get, when `INBOUND_EMAIL_DOMAIN` is set:
   - `Reply-To` the signed address;
   - `In-Reply-To` and `References` naming the request's root id, `<support.<reference>-<version>-<mac>@<domain>>`. A mail app that answers our `From` instead of `Reply-To` still threads, and the id is checked like the address;
   - a first line "Reply above this line to answer": everything from that line down is cut from the reply;
   - `Auto-Submitted: auto-generated` on the automated ones (the close), so other systems don't auto-answer them.
   Unset domain: `Reply-To` stays the team's address, as before. S57 sets it when DNS and Resend's inbound domain exist.
3. **The webhook only verifies, stores and queues.** `POST /v1/webhooks/resend` is off (404) until `RESEND_WEBHOOK_SECRET` is set.
   - It checks the Svix signature: HMAC-SHA256 of `id.timestamp.body` with the secret, compared in constant time, and a timestamp within 5 minutes.
   - It stores `email.received` events in `inbound_emails` (provider event id and `Message-ID` unique: a resend, or the same email twice, changes nothing) and answers 200. Other event types are acknowledged and not stored.
   - The body is capped by the api’s 100 KB JSON limit (413). Nothing from an email is logged.
   - The webhook carries no email text; the worker fetches the message from the provider (`InboundMailSource` port, a Resend adapter on its API, `RESEND_API_KEY`), so provider retries are harmless and the api holds no bodies.
4. **The sender check.** A reply lands only when all of these hold:
   - its address (or `References`) carries a valid signature for an existing request;
   - its `From` is the opener or another member of that business who may read the request (owners and managers; RLS decides, through the member's own transaction);
   - the receiving server's verdict, in the topmost `Authentication-Results` header whose authserv-id is the configured one (`INBOUND_AUTHSERV_ID`), says DMARC passed or a DKIM signature of the `From` domain passed. Headers further down were written by the sender's side and are ignored. Without the setting, every reply is held.
   A valid address with any other sender is **held**: kept for an operator with its sender and text for 7 days, then emptied. Nothing is sent to an unverified address, so the reply path can't be used to send mail to others.
5. **Ignored and refused.** Lands nowhere, never answered:
   - auto-replies (`Auto-Submitted` other than `no`, `X-Autoreply`, `X-Autorespond`, `Precedence: bulk/junk/list/auto_reply`, "Out of office"/"Automatic reply" subjects);
   - a spam verdict;
   - more than 5 emails to one request in an hour (a loop guard);
   - no valid signed address or `References` (new requests by email are S59.3.2);
   - over 40 MB.
6. **The same rules as the app.** A landed reply is a member's message:
   - quoted text, the "Reply above this line" part and common signatures are cut. HTML-only mail is turned into plain text and never rendered. Text over 4,000 characters is cut;
   - the day's message limit applies;
   - a solved request reopens within 30 days of its solving; later, a new request "Follow-up to PEP-…" is opened, under the day's request limit;
   - the business's audit log records `support_thread.replied` by the member, with `channel: email`;
   - the team's address is emailed as for any reply;
   - the message's `channel` is `email`, shown as "by email" in both threads.
7. **Images become screenshots.** Up to 3 images per email, attached or inline (`cid:`), go through the same `ScreenshotStorage.process` checks as an upload (ADR-0062 Part 3). They count towards the sender's 20 a day and are attached to the new message. Other files, more than 3, and refused images are left out.
8. **Telling a verified sender.** When something was cut, left out, over a limit or empty, a verified sender gets one short email (deduped per inbound email) saying what happened and linking to the request.
9. **Where it lives.**
   - `inbound_emails` is a platform table with forced RLS, reached only in a transaction that names the inbound context (`withInboundMail`); after matching, it records the business and the thread, and it goes when the business is deleted.
   - The request is found from its reference through one definer function, `support_inbound_thread(reference)`, called only after the signature checked.
   - The worker's `inbound-mail` job takes received rows under a lease every 15 s, gives up after 5 failed attempts, and empties held rows after 7 days.

## Consequences
- A reply from the owner's mail app lands in the thread in about a minute, with its screenshots, and nothing an outsider sends can write into a business's request.
- Resend's inbound API shape is coded from its documentation and kept behind the port and recorded fixtures; S57 confirms it with a live domain, and sets `INBOUND_AUTHSERV_ID` from what its receiving server writes.
- Held mail has no review screen yet: S59.3.2 adds Accept/Discard in the console, new requests by email to the team's address, bounce and complaint handling, and inbound counts for S59.4's metrics.
- Quote cutting is heuristic. Unknown layouts keep the full text, which is safer than losing words.

## Built (S59.3)
- **contracts:** `MessageIdHeaderSchema` and the threading fields of `OutboxEmailSchema`; `ResendWebhookEventSchema`, `InboundDomainSchema`; `SupportMessageChannelSchema` on members' and operators' messages; the audit's `channel: 'email'`.
- **db:** migration 0071:
  - `inbound_emails`: forced RLS, its only policy `inbound_mail`, no delete for the services;
  - `support_messages.channel`;
  - `support_threads.follow_up_of`, where later replies to an old request land;
  - `support_inbound_thread`;
  - `withInboundMail` and `setTransactionInboundMail`, and the inbound repository.
- **core:** `support-reply-address.ts`, `inbound-email.ts` (the sender check reads only the receiver's topmost header, with quoted strings and comments dropped; a DMARC failure for the From domain decides), `email-text.ts` (linear HTML scan), and `services/inbound-email.ts`. Also `supportReplyRouting` in the support emails, and 8 client fixtures.
- **runtime:** `ResendInboundSource`, which takes the last `<…>` of `From` and downloads only https links, capped at 12 MB; threading headers in `SmtpMailer`; `rawBody` in `createServiceApp`.
- **api:** `InboundModule` (`POST /v1/webhooks/resend`); `INBOUND_EMAIL_DOMAIN`, `RESEND_WEBHOOK_SECRET`.
- **worker:** `Inbound email job` (`INBOUND_POLL_MS`, 15 s); `RESEND_API_KEY`, `INBOUND_AUTHSERV_ID`.
- **web:** `SupportMessageMeta` ("by email") in both threads, and the gallery's "Support" section.

## Part 2 (S59.3.2): new requests by email, bounces and complaints, held review, counts
Decided at the S59.3.2 brief (user, 2026-11-08, "Start with ur recommend").
1. **New requests by email.** Mail to the team's address for requests, `help@<inbound domain>` (S57 points the public support address there), that names no request goes through the same checks as a reply (§4–§5: the receiver's verdict, auto-replies, spam, size). The loop guard is per sender address instead of per request: more than 5 an hour are ignored.
   - **A member** (their address is a Pepper user's with a membership) opens a request in their business, by email, under the app's request limits, and is told its reference. A member of several businesses gets it in the business their latest session chose (`sessions.active_tenant_id`, still a membership), else the one they joined first; the email back says which. Only verified accounts not being deleted are found. The address is matched to the user's businesses through one definer function that returns ids only.
   - **Anyone else** who passes the check becomes a public request, the same row the signed-out form makes, with channel `email`, and is told its reference. Its row and the inbound outcome commit together; the two emails (to the team, and the reference to the sender, `Reply-To` the team) go after, best effort, as the form's do (no business, so no outbox), and its images aren't kept. An unverified sender is held, with the business it would go to if any: `inbound_emails` may keep a held row's text and subject without a tenant. Mail to another address of the domain that names no request still lands nowhere.
2. **Bounces and complaints.** Resend's signed `email.bounced` (hard only) and `email.complained` events add the recipient to `email_suppressions`, a platform table (forced RLS, its own context, no delete for the services; one row per address, its reason and time, deduped on the event). Support email (`support.*` outbox keys) to a stopped address is skipped at delivery and recorded. Booking and client email keep their own opt-out (`clients.email_opt_out_at`). Soft bounces are counted, not stopped. An operator can resume an address from the console, which is audited.
3. **Held review.** The console's "Held" view lists held mail, longest waiting first, with its text shown as plain text. **Accept** lands it as if its checks had passed: the operator vouches for the sender, so it becomes a reply, a member's new request or a public request. **Discard** empties it. Viewing, accepting, discarding and resuming each write a row in the operator access log in the same transaction (new `OperatorActionSchema` values, and the CHECK). The 7-day emptying is unchanged.
4. **Counts.** `inbound_emails` rows keep their status and reason after emptying. An operator endpoint returns counts for 7 and 30 days by status and reason, plus bounces and complaints, for S59.4. The console's inbox header shows the held count (the S59.3 retro's top-up).
