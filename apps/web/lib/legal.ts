import {
  aiDisclosureSentence,
  PRIVACY_AI_SECTION,
  PRIVACY_PATH,
  TERMS_PATH,
} from '@pepper/contracts';
import { HELP_CONTACT_PATH, HELP_PATH, type HelpBlock } from './help';

// The terms of service and the privacy policy (S59.5, ADR-0064, AC-X-54), the S51 drafts
// finished: written from how Pepper behaves today, in plain words, as typed data (like the
// help centre) so nothing in them can become markup. This file is the one source: the pages
// render it and `docs/legal/` points here. A change to what Pepper collects, keeps, shares or
// sends changes this file in the same PR. Drafts until the lawyer's review: every page says so.

/** A block of a policy: a help block, a quoted line, or a link to read more. */
export type LegalBlock =
  HelpBlock | { kind: 'quote'; text: string } | { kind: 'link'; text: string; href: string };

export interface LegalSection {
  /** The section's anchor (`/privacy#ai`): stable, as emails and other pages link to it. */
  id: string;
  heading: string;
  blocks: readonly LegalBlock[];
}

export interface LegalDocument {
  path: string;
  title: string;
  /** One line under the title. */
  summary: string;
  /** ISO date the text last changed. */
  updated: string;
  sections: readonly LegalSection[];
}

/** Shown on both pages until the lawyer's review (playbook S59.5). */
export const LEGAL_DRAFT_NOTICE =
  'This is a draft. It describes how Pepper works today and is waiting for a lawyer’s review, so it isn’t in force yet. The company’s legal name, address and governing state are added before it is.';

/** The date both texts last changed. */
const UPDATED = '2026-11-09';

/** Where a person writes to us: the help centre's form, open without an account. */
const CONTACT = { text: 'Write to us', href: HELP_CONTACT_PATH } as const;

const p = (text: string): LegalBlock => ({ kind: 'p', text });
const list = (...items: string[]): LegalBlock => ({ kind: 'list', items });
const note = (text: string): LegalBlock => ({ kind: 'note', text });
const quote = (text: string): LegalBlock => ({ kind: 'quote', text });
const link = (text: string, href: string): LegalBlock => ({ kind: 'link', text, href });

/** The line every email in the AI's words carries, as the privacy page quotes it. */
export const DISCLOSURE_AS_QUOTED = aiDisclosureSentence('[the business]');

export const PRIVACY: LegalDocument = {
  path: PRIVACY_PATH,
  title: 'Privacy policy',
  summary:
    'What Pepper collects about the businesses that use it and their clients, what its AI assistant does, and how to see, take or delete any of it.',
  updated: UPDATED,
  sections: [
    {
      id: 'summary',
      heading: 'The short version',
      blocks: [
        list(
          'A business’s clients and bookings belong to the business. Pepper keeps them only to run Pepper for it.',
          'We never sell personal information or use it for advertising, and there are no tracking cookies.',
          'Pepper’s AI assistant helps the business with its work. When the AI wrote an email’s words, the email says so.',
          'You can see what Pepper remembers, change it or make it forget, and the owner can download or delete everything.',
        ),
      ],
    },
    {
      id: 'who',
      heading: 'Who this is about',
      blocks: [
        p(
          'Pepper is an app that appointment-based businesses in the United States use to run their day. This policy covers two groups of people.',
        ),
        list(
          'Owners, managers and staff who sign in to Pepper. For your accounts, Pepper decides what is collected.',
          'The business’s clients. The business decides what it keeps about you; Pepper handles it on the business’s behalf and only to run Pepper for it (a service provider). For a question about your details, ask the business first. We will help it answer.',
        ),
      ],
    },
    {
      id: 'collect',
      heading: 'What we collect',
      blocks: [
        p(
          'Accounts: name, email, the password (kept only as a one-way hash), the two-step verification secret and backup codes, the businesses you belong to and your role, the devices you are signed in on, and what you do in the app, recorded in the business’s change history.',
        ),
        p(
          'The business: its name, booking link, time zone, type, phone, public and mailing addresses, cancellation policy, review link, colours, photos, services, prices, team, hours, time off and booking rules.',
        ),
        p(
          'Clients, on the business’s behalf: name, email, phone, tags, birthday, appointments and visit history, waitlist requests, unsubscribe choices, and what the business has asked Pepper to remember about them. A client who books on the booking page also gives the code we email them. If they choose, their phone is remembered for 90 days so they can book again without a code.',
        ),
        p(
          'Imports: when a business moves its clients from another app, Pepper keeps the rows it needs to show the preview and undo the import for 7 days, not the file itself.',
        ),
        p(
          'Conversations with the assistant, and the requests and replies a business sends us for support, with any screenshots attached.',
        ),
        p(
          'Technical data: the IP address and browser, for security and rate limits, and error reports. The booking page counts how many visitors reach each step without recording who they are.',
        ),
        note(
          'Pepper uses cookies only to keep you signed in and, on the booking page, to remember a phone a client asked us to remember.',
        ),
      ],
    },
    {
      id: 'use',
      heading: 'Why we use it',
      blocks: [
        p(
          'To run Pepper for the business: bookings, confirmations and reminders, the calendar, client records, the assistant’s suggestions and actions, imports and exports. To keep accounts and data safe (two-step verification, rate limits, the change history). To answer support requests. To improve Pepper from totals that identify no one. And to meet legal duties.',
        ),
      ],
    },
    {
      id: PRIVACY_AI_SECTION,
      heading: 'Pepper, the AI assistant',
      blocks: [
        p('If you got an email from a business that uses Pepper, it may end with this line:'),
        quote(DISCLOSURE_AS_QUOTED),
        p(
          'It means the business used Pepper’s AI to write that email’s words. The business chose to send it, and the booking details and links in it come from the business’s own calendar, not from the AI. To write the words, the AI was given only your first name, the service, when you last visited and who usually looks after you. It never sees your email address or phone number.',
        ),
        list(
          'Don’t want emails like it? Every one has an unsubscribe link at the bottom, and one tap stops them all from that business.',
          'Questions about what the business keeps about you? Ask the business, or write to us and we will pass your question on.',
        ),
        p(
          'For the people who use Pepper at work: the assistant prepares work and, when the business allows it, does it. An AI model provider (OpenAI) processes each request under an agreement that the data is not used to train its models, and we ask it not to store requests. Pepper sends the model only what a request needs: clients by first name and initial, never their email or phone, and what Pepper remembers about them, including notes marked sensitive, only to members allowed to read them. What you type in the chat is sent as you type it.',
        ),
        p(
          'The assistant never reads or changes the database itself. Everything it does goes through the same checks as the app’s screens, follows the business’s settings for what it may do without asking, is recorded with its reason, and can be undone where possible. When a business imports a file, the AI may be shown the column names and a masked sample of each column to suggest which is which.',
        ),
        p('Development and testing use made-up data only.'),
      ],
    },
    {
      id: 'memory',
      heading: 'What Pepper remembers',
      blocks: [
        p(
          'Pepper remembers what a business tells it, so nobody has to repeat it: a client’s preferences or a visit note, how the business likes things done, a staff member’s habits. It saves only what a member said or wrote on a screen, and a rule it learns from that needs a person’s OK first. Health and other personal notes are marked sensitive.',
        ),
        p(
          'It also keeps a short summary of each conversation with the assistant, which only the member who had that conversation can see, for one year.',
        ),
        list(
          'See it: on the “What I know” page, on each client’s profile, and on any answer that used it (“Remembered”).',
          'Change or forget it: forgetting is immediate and everywhere: the note, the summaries that mention it, and the assistant’s past answers that quoted it. A changed note keeps its old value for 7 days, only so it can be undone.',
          'Pause it: a switch stops the assistant from remembering anything new.',
          'Staff see only the clients and visits their role allows, and never sensitive notes about the business, the team or its services.',
        ),
        p(
          'What Pepper remembers is never put in an email to a client, and an email draft that mentions a sensitive note is refused before anyone can send it.',
        ),
      ],
    },
    {
      id: 'support',
      heading: 'Support requests',
      blocks: [
        p(
          'When you ask us for help, we keep your message, our replies and, so we can see what you saw, the page you were on, the app version, your browser and how far the business is set up. Never a client’s details. Screenshots you attach have their hidden details (such as location) removed and are kept privately. Someone without an account can write to us with an email address and a message.',
        ),
        p(
          'A small number of people on the Pepper team can read support requests. They must use two-step verification, can read only support requests (never clients, bookings or the business’s other data), and every time they open one it is recorded. The business sees “Seen by Pepper” on its request.',
        ),
        p(
          'Replies by email land in the request. An email whose sender we can’t verify is held for review for 7 days, then deleted. If an address bounces or marks our email as spam, we stop sending support email to it.',
        ),
      ],
    },
    {
      id: 'sharing',
      heading: 'Who else handles it',
      blocks: [
        list(
          'Hosting and storage, in the United States.',
          'Email delivery: Resend (booking emails, reminders, account and support email).',
          'AI processing: OpenAI.',
          'Error and performance monitoring: Sentry and Grafana Cloud, without message content.',
          'Later, only when a business turns them on: a text message provider, Stripe for deposits and card payments, Google for calendar sync.',
        ),
        p(
          'Each receives only what it needs to do its job. We may disclose information if the law requires it, to protect someone’s safety, or as part of a sale or merger of Pepper, with this policy continuing to apply.',
        ),
      ],
    },
    {
      id: 'retention',
      heading: 'How long we keep it',
      blocks: [
        list(
          'Business and client data: while the business uses Pepper, until it deletes it.',
          'A deleted client: their details and what Pepper remembered about them go at once; past visits stay in the business’s history as “Deleted client”.',
          'Conversations with the assistant: 90 days after the last message. Their summaries: one year.',
          'Support requests and screenshots: while the business uses Pepper. Screenshots never sent: 24 hours.',
          'Sent emails’ delivery records: 30 days. Unconfirmed booking requests: 24 hours.',
          'Import working rows: 7 days, while the import can be undone.',
          'A remembered phone on the booking page: 90 days from its last use, or until the client taps “Forget this phone”.',
          'Backups: overwritten on a fixed schedule, stated here before this policy takes effect.',
        ),
      ],
    },
    {
      id: 'security',
      heading: 'Security',
      blocks: [
        p(
          'Data is encrypted in transit. Each business’s data is kept apart in the database itself, so one business can never read another’s. Owners must use two-step verification, each member can do only what their role allows, and changes are recorded. No system is perfectly secure: if a breach affects your information, we will tell the businesses concerned without undue delay and as the law requires.',
        ),
      ],
    },
    {
      id: 'rights',
      heading: 'Your choices and rights',
      blocks: [
        list(
          'Download everything: the owner can download all the business’s data at any time (More → Your data), clients and visits as spreadsheets other apps import. We build the file when asked and keep no copy.',
          'Correct or delete a client: owners and managers can, in the app.',
          'Delete an account or a business: it waits 30 days, in case it was a mistake, and can be restored until then. Then its data is removed from Pepper, and from backups as they are overwritten. While it waits, its booking page takes no bookings and its clients get no email.',
          'Unsubscribe: every marketing email has a one-tap unsubscribe link.',
          'Know, access, correct, delete or move your information: depending on where you live, the law gives you these rights. Owners and staff can write to us; clients can ask the business, or write to us and we will pass the request on. Using your rights never changes how you are treated.',
        ),
        link(CONTACT.text, CONTACT.href),
      ],
    },
    {
      id: 'children',
      heading: 'Children',
      blocks: [
        p(
          'Pepper is for businesses and is not directed to children under 13. A business may book a child’s appointment through a parent or guardian.',
        ),
      ],
    },
    {
      id: 'changes',
      heading: 'Changes to this policy',
      blocks: [
        p(
          'We update this policy as Pepper changes, and tell businesses about an important change in the app or by email before it takes effect.',
        ),
      ],
    },
    {
      id: 'contact',
      heading: 'Contact',
      blocks: [
        p('Questions about privacy, or a request about your information:'),
        link(CONTACT.text, CONTACT.href),
      ],
    },
  ],
};

export const TERMS: LegalDocument = {
  path: TERMS_PATH,
  title: 'Terms of service',
  summary:
    'The agreement between Pepper and a business that uses it: what Pepper does, what is yours, and what each of us can expect.',
  updated: UPDATED,
  sections: [
    {
      id: 'agreement',
      heading: 'This agreement',
      blocks: [
        p(
          'These terms are an agreement between Pepper (“we”) and the business that signs up (“you”). By creating an account or a business on Pepper you accept them on behalf of that business.',
        ),
      ],
    },
    {
      id: 'pepper',
      heading: 'What Pepper is',
      blocks: [
        p(
          'Pepper is an app that helps an appointment-based business run its day: a booking page, a calendar, client records, reminders and an AI assistant that prepares work and, when you allow it, does it for you. Some features are marked as early; they may change.',
        ),
      ],
    },
    {
      id: 'account',
      heading: 'Your account',
      blocks: [
        list(
          'You must be at least 18 and able to agree to these terms for the business.',
          'Keep your password and second step safe. A business’s owner must use two-step verification.',
          'You are responsible for what happens under your account and for the people you invite. You choose their roles; Pepper enforces what each role may do.',
        ),
      ],
    },
    {
      id: 'data',
      heading: 'Your data',
      blocks: [
        list(
          'It’s yours. The business’s information and its clients’ information belong to you. You let us store and use it only to run Pepper for you, as the privacy policy describes.',
          'You may put it in Pepper. You confirm you collected your clients’ details lawfully, may use them to book, remind and message them, and have their consent where the law needs it, such as for marketing email.',
          'Take it with you. The owner can download everything at any time (More → Your data), as files spreadsheets open and Pepper imports again.',
          'Delete it. You can delete a client at any time; deleting an account or a business waits 30 days and can be undone until then.',
        ),
        link('Read the privacy policy', PRIVACY_PATH),
      ],
    },
    {
      id: 'ai',
      heading: 'The AI assistant',
      blocks: [
        list(
          'Pepper’s assistant uses an AI model to suggest and prepare work. It can be wrong. You choose what it may do without asking you; anything that reaches a client asks first unless you choose otherwise.',
          'Every action it takes is recorded with its reason, and most can be undone. You are responsible for the messages and bookings you approve or allow it to make.',
          'An email to a client whose words the AI wrote says so in one line, with a link to how Pepper works. You agree not to remove or hide it.',
          'Don’t use the assistant for medical, legal or financial advice, or to send anything unlawful.',
        ),
        link('How the assistant handles information', `${PRIVACY_PATH}#${PRIVACY_AI_SECTION}`),
      ],
    },
    {
      id: 'use',
      heading: 'Acceptable use',
      blocks: [
        p(
          'You will not send spam or messages to people who haven’t agreed to them; upload malware or try to break, overload or get around Pepper’s security; reach another business’s data; use Pepper to discriminate unlawfully or harass anyone; or resell Pepper without our written agreement.',
        ),
      ],
    },
    {
      id: 'messages',
      heading: 'Messages to your clients',
      blocks: [
        p(
          'Pepper sends booking confirmations, reminders and, when you choose, rebooking, review and other emails on your behalf and in your business’s name. Marketing emails carry your postal address and an unsubscribe link, and Pepper honours every unsubscribe. You remain the sender responsible for their content.',
        ),
      ],
    },
    {
      id: 'support',
      heading: 'Support',
      blocks: [
        p(
          'You can ask us for help from the app or the help centre, and a person on the Pepper team answers. To help you, the people who answer can read your request and what came with it, never your clients’ details.',
        ),
        link('Visit the help centre', HELP_PATH),
      ],
    },
    {
      id: 'payments',
      heading: 'Payments',
      blocks: [
        p(
          'During the pilot Pepper is free. When paid plans start (planned with a 30-day trial), prices, billing and refunds are shown before you choose a plan and added to these terms. Card payments by your clients, when available, are handled by a payment provider under its own terms.',
        ),
      ],
    },
    {
      id: 'availability',
      heading: 'Availability and changes',
      blocks: [
        p(
          'We work to keep Pepper available and your data safe and backed up, but during the pilot Pepper is provided as it is, without a guaranteed level of service. We may change features, and tell you in the app or by email before a change that takes away something important.',
        ),
      ],
    },
    {
      id: 'ending',
      heading: 'Ending',
      blocks: [
        p(
          'You can stop using Pepper and delete your business at any time. We may suspend or end an account that breaks these terms or the law, after telling you why unless the law or someone’s safety prevents it. Unless the reason is serious abuse, you can download your data first.',
        ),
      ],
    },
    {
      id: 'liability',
      heading: 'Liability',
      blocks: [
        p(
          'As far as the law allows, Pepper is not liable for indirect or consequential losses, such as lost profits or missed bookings, and our total liability is limited to the greater of what you paid us in the 12 months before the claim and US$100. Nothing here limits liability that the law does not allow to be limited.',
        ),
      ],
    },
    {
      id: 'law',
      heading: 'Law and disputes',
      blocks: [
        p(
          'These terms are governed by the laws of the US state where Pepper’s company is registered, named here before they take effect. How disputes are resolved is added after the lawyer’s review.',
        ),
      ],
    },
    {
      id: 'contact',
      heading: 'Contact',
      blocks: [p('Questions about these terms:'), link(CONTACT.text, CONTACT.href)],
    },
  ],
};

export const LEGAL_DOCUMENTS = [TERMS, PRIVACY] as const;

/** "November 9, 2026", from the ISO date (a calendar date: no time zone moves it). */
export function legalDate(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1)).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}
