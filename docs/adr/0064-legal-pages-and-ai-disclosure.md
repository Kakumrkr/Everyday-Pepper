# ADR-0064: The legal pages as typed data, and an AI disclosure in client email that links to them

- **Status:** Accepted. Approved by the user at the S59.5 brief on 2026-11-09 ("let's go with your recommendation"), after the brief was corrected: review requests and win-back drafts are in Pepper's fixed words, not the AI's.
- **Date:** 2026-11-09
- **Builds on:** ADR-0040 (rebooking nudges, the CAN-SPAM footer), ADR-0057 (win-back drafts), ADR-0059 (review requests), ADR-0060 (client messages), the S51 drafts in `docs/legal/`, [PCR-010](../plan/changes/PCR-010.md) (S59.5 before deploy)

## Context
The pilot needs a terms of service and a privacy policy that people can read, and the S51 drafts predated memory's later rules, deletion, support, operator access and inbound email. Clients get email whose words the AI wrote (the morning pass's rebooking nudges, notes a member asks for in the chat). Laws such as Utah's AI disclosure act and California's bot law point towards saying so, and a client who asks "was this written by a machine?" deserves an answer one tap away. Other email to clients is in Pepper's fixed words (booking emails, reminders, running late, waitlist offers, review requests, win-back drafts), and labelling those as AI-written would be untrue and would teach clients to ignore the line.

## Decision
1. **One source for the text.** The policies are typed data in `apps/web/lib/legal.ts`, like the help centre (S59): sections with stable anchors, paragraphs, lists, a quoted line and links, never markup. `docs/legal/` points there. A change to what Pepper collects, keeps, shares or sends changes that file in the same PR. On the public page, plain wording replaces the S51 placeholders (`[Company]`, `[state]`). Both pages carry a draft banner until the lawyer's review.
2. **Public pages.** `/terms` and `/privacy` in their own route group, signed out or in: the title, the date last changed, the banner, a collapsed "On this page" list, the sections, and links to the other policy and the help centre. A section opened by its link is highlighted (`:target`). They are linked from sign-up (the consent sentence), the help centre's footer, the booking page's small print and More → Help.
3. **The disclosure is decided by who wrote the words, by the domain.** `send_rebooking_nudge`'s arguments say `wordsBy: 'ai' | 'template'`. The morning pass sets `ai` and win-back sets `template`. The tool is never offered to a model, so a model can't set it. A nudge stored before this change has no value and counts as `ai`: a missing line would mislead, an extra one can't. A card edit keeps the value; words an owner rewrote still went through the AI ("written with help from"). A client note always carries the line: its words come through the chat. Review requests, win-back, booking emails and reminders carry none, and tests hold both sides.
4. **One sentence, one anchor, shared.** `@pepper/contracts` (`legal.ts`) holds the paths, the AI section's anchor (`ai`), the sentence ("Written with help from Pepper, the AI assistant {business} uses.") and `privacyAiUrl(baseUrl)`. The email puts the sentence and an absolute link to `{app}/privacy#ai` on their own lines above the footer, as plain text, so mail apps make the link tappable. The privacy page's AI section starts with a part in plain words for a client who got such an email and quotes the same sentence. Tests on both sides fail if the anchor or the sentence drift.

## Consequences
- A client sees, in the email itself, that the AI helped and what that means, without an account. The line is outside the words the model or an owner can edit, so it can't be edited away on the card.
- The privacy policy now states retention periods the code enforces (chats 90 days, conversation summaries a year, held mail 7 days, unsent screenshots 24 hours, deletion's 30 days). A change to one of those constants changes `legal.ts` too. `legal.test.ts` checks the periods are stated, but not that they match the constants.
- Placeholders that wait for the company (its legal name, address, governing state, dispute clause, backup retention) are named in the banner and in the text, never shown as brackets.

## Not done
- The lawyer's review; the company's details (STATUS "Waiting on the user" 3 and 5); state-specific notices if a pilot business needs them.
- SMS (Phase 14) carries its own disclosure when it arrives; Stripe and Google Calendar join "Who else handles it" when they are switched on.
