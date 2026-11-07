// The help centre (S59, PCR-010, AC-X-13): short articles in plain words, grouped by topic,
// written from how Pepper works today. Typed data rather than Markdown, so nothing in an
// article can become markup. A screen links to its article by slug (`HELP_LINKS`); a test
// checks that every slug the app uses names an article here.

export const HELP_PATH = '/help';
export const HELP_CONTACT_PATH = '/help/contact';

/** A paragraph, numbered steps, a list, or a short note set apart. */
export type HelpBlock =
  | { kind: 'p'; text: string }
  | { kind: 'steps'; items: readonly string[] }
  | { kind: 'list'; items: readonly string[] }
  | { kind: 'note'; text: string };

export interface HelpArticle {
  slug: string;
  title: string;
  /** One line under the title, and in the list. */
  summary: string;
  topic: HelpTopic;
  body: readonly HelpBlock[];
}

export const HELP_TOPICS = [
  'Getting started',
  'Bookings and the calendar',
  'Pepper, your assistant',
  'Clients',
  'Team and account',
  'Getting help',
] as const;
export type HelpTopic = (typeof HELP_TOPICS)[number];

const p = (text: string): HelpBlock => ({ kind: 'p', text });
const steps = (...items: string[]): HelpBlock => ({ kind: 'steps', items });
const list = (...items: string[]): HelpBlock => ({ kind: 'list', items });
const note = (text: string): HelpBlock => ({ kind: 'note', text });

export const HELP_ARTICLES: readonly HelpArticle[] = [
  {
    slug: 'getting-started',
    title: 'Set up Pepper in ten minutes',
    summary: 'From sign-up to your first booking.',
    topic: 'Getting started',
    body: [
      p(
        'When you create your business you pick its type. Pepper fills in a starter menu, your opening hours and you as the first person clients can book, so the booking page works straight away.',
      ),
      steps(
        'On Home, open the setup review and check the services, prices, hours and time zone. Change anything that isn’t right, then tap “I’ve checked these details”.',
        'Add your team on Team, if you have one (see “Invite your team”).',
        'Copy your booking link and put it in your Instagram bio, your Google profile and your texts to clients.',
      ),
      note(
        'Any warning on Home (someone without hours, a service nobody offers) has a button that takes you straight to the fix.',
      ),
    ],
  },
  {
    slug: 'booking-page',
    title: 'Your booking page',
    summary: 'The link clients book with, and what they see.',
    topic: 'Getting started',
    body: [
      p(
        'Your booking page has its own link: Pepper’s web address, then /book/ and your business’s short name. Copy it from Home or Services.',
      ),
      steps(
        'A client picks a service, then a person or “Anyone available”, then a time.',
        'They enter their name and email, and confirm with a code Pepper emails them.',
        'They get a confirmation email with a link to move or cancel, and a reminder 24 hours before.',
      ),
      p(
        'On Services you can add your logo, a cover photo, up to 12 photos of your work, your phone, a public address and your cancellation policy. Clients see each one you set.',
      ),
      note(
        'A client who ticks “Remember me on this phone” books again for 90 days without a code.',
      ),
    ],
  },
  {
    slug: 'bookings',
    title: 'Add, move or cancel a booking',
    summary: 'Everything you can do from the calendar.',
    topic: 'Bookings and the calendar',
    body: [
      p(
        'The calendar shows one day at a time, each person in their own column. Tap a free time to book it, or tap a booking to open it.',
      ),
      list(
        'Move: pick a new time; Pepper only offers times that are really free.',
        'Cancel: the time opens up again, and the waitlist can fill it.',
        'Mark done or no-show once the visit has started.',
      ),
      p('When you change a booking you choose whether the client gets an email about it.'),
      note('You can also just tell Pepper in chat: “Move Sara to Thursday at 3”.'),
    ],
  },
  {
    slug: 'client-emails',
    title: 'The emails your clients get',
    summary: 'Confirmations, reminders and Pepper’s suggestions.',
    topic: 'Bookings and the calendar',
    body: [
      list(
        'A confirmation when they book, with a link to move or cancel.',
        'A reminder 24 hours before the visit.',
        'An email when you move or cancel their visit, if you choose to send one.',
        'A waitlist offer when a time they wanted opens up.',
        'With your OK: a nudge to rebook when they’re due, a win-back note, a review request after a visit.',
      ),
      p(
        'The suggestions carry your business’s mailing address and a one-click unsubscribe, as the law asks; Pepper only drafts them once you’ve added the address under More → Emails to clients.',
      ),
      note('A client who unsubscribes still gets confirmations and reminders for their bookings.'),
    ],
  },
  {
    slug: 'waitlist',
    title: 'The waitlist fills cancellations',
    summary: 'How an open time finds a client.',
    topic: 'Bookings and the calendar',
    body: [
      p(
        'When no time suits a client, they can join the waitlist from your booking page, or you can add them in chat.',
      ),
      steps(
        'A time opens up, for example after a cancellation.',
        'Pepper finds the people waiting for that kind of time and offers it to the best three, with your OK first unless you’ve told it to go ahead.',
        'The first to claim it is booked; the others are told it’s gone.',
      ),
      note('Waitlist (on More) shows who is waiting and for what.'),
    ],
  },
  {
    slug: 'cards',
    title: 'Pepper’s cards on Home',
    summary: 'Approve, change or dismiss what Pepper prepared.',
    topic: 'Pepper, your assistant',
    body: [
      p(
        'Pepper prepares things for you: a gap to fill, a client due to rebook, a time to offer from the waitlist. Each one is a card on Home.',
      ),
      list(
        'Approve it with one tap, and Pepper does it.',
        'Open “Why?” to see what Pepper based it on.',
        'Edit the words of an email before it goes.',
        'Dismiss it, and Pepper leaves it for a while.',
      ),
      p(
        'Right after Pepper acts there is an Undo. Activity (on More) lists everything Pepper did, who approved it and what was sent.',
      ),
    ],
  },
  {
    slug: 'autonomy',
    title: 'How much Pepper does on its own',
    summary: 'Careful, Balanced or Hands-off, and each action.',
    topic: 'Pepper, your assistant',
    body: [
      p('Autonomy (on More) decides when Pepper asks you first. Start from a preset:'),
      list(
        'Careful: Pepper asks before every change and every email.',
        'Balanced: it asks before new bookings, moves, cancellations and client nudges; smaller changes it does and tells you; confirmations go on their own.',
        'Hands-off: it makes changes and sends their emails on its own, and tells you when it sends nudges and offers. Big sends and new rules still wait for you.',
      ),
      p(
        'Under the preset, each kind of action has its own setting: ask first, do it and tell me, or just do it. Some actions can never run without asking; the screen shows a lock and why.',
      ),
      note('Owners and managers change these settings; staff can read them.'),
    ],
  },
  {
    slug: 'memory',
    title: 'What Pepper remembers',
    summary: 'What it keeps, and how to pause or delete it.',
    topic: 'Pepper, your assistant',
    body: [
      p(
        'Pepper remembers what you tell it in chat, such as “Sara likes the 9 am slot” or “we close early on Fridays”, so you don’t have to repeat yourself.',
      ),
      list(
        'What I know (on More) lists everything it remembers, with where it came from.',
        'Delete anything there; it’s gone for good.',
        'Pause memory any time: Pepper stops learning, and what it already knows stays until you delete it.',
      ),
      note('Staff see what Pepper knows about their own clients and visits only.'),
    ],
  },
  {
    slug: 'chat',
    title: 'Ask Pepper in chat',
    summary: 'What you can ask, in your own words.',
    topic: 'Pepper, your assistant',
    body: [
      p(
        'Chat is there for anything the cards don’t cover. Write as you would to a person at the front desk.',
      ),
      list(
        '“Who’s in tomorrow?”',
        '“Find Marco a time with Jess next week.”',
        '“Move Sara to Thursday at 3.”',
        '“Tell my 2 pm I’m running ten minutes late.”',
        '“Mark Leo as a no-show.”',
      ),
      p(
        'Anything that changes a booking or sends an email follows your Autonomy settings: by default Pepper shows you what it will do and waits for your OK. When Pepper can’t do something yet, it says so and what you can do instead.',
      ),
    ],
  },
  {
    slug: 'import-clients',
    title: 'Bring your clients from another app',
    summary: 'Import a CSV, JSON or JSONL export, and undo it if needed.',
    topic: 'Clients',
    body: [
      steps(
        'In your old app, export your clients (and, if it can, your past visits). Square, Booksy, Vagaro, GlossGenius and Fresha exports are recognised as they are.',
        'In Pepper, open Clients → Import and choose the file (up to 5 MB and 10,000 rows).',
        'Check the columns: Pepper matches most by itself, and suggests the rest (“Looks like Full name to me · Use it”). You decide each one.',
        'Read the preview: who is new, who needs a detail filled in, and what is left out and why. Then tap Import.',
      ),
      p('Import your clients first, then the visits file, so each visit finds its client.'),
      note(
        'Changed your mind? Undo an import for 7 days. Clients you have already booked since are kept.',
      ),
    ],
  },
  {
    slug: 'team',
    title: 'Invite your team',
    summary: 'Roles, and what each person can see.',
    topic: 'Team and account',
    body: [
      steps(
        'Open Team and tap “Invite someone”.',
        'Enter their email and choose their role. They get an email with a link to join.',
        'Link them to their place on the calendar, so clients can book them.',
      ),
      list(
        'Owners see and change everything, including the business’s data and deletion.',
        'Managers run the day: the whole calendar, every client, the settings.',
        'Staff see their own bookings and their own clients.',
      ),
      note('Owners and managers turn on two-step sign-in, because they can reach every client.'),
    ],
  },
  {
    slug: 'notifications',
    title: 'Notifications on your phone',
    summary: 'Get told when something needs you.',
    topic: 'Team and account',
    body: [
      p('Turn notifications on for each phone or computer you use, under More.'),
      note(
        'On an iPhone, add Pepper to your Home Screen first (Share → Add to Home Screen) and open it from there; iPhones only notify apps on the Home Screen.',
      ),
    ],
  },
  {
    slug: 'sign-in',
    title: 'Trouble signing in',
    summary: 'Passwords, email links and two-step codes.',
    topic: 'Team and account',
    body: [
      list(
        'Forgot your password: tap “Forgot your password?” on the sign-in page; we email you a link.',
        'No email from us: check spam, and that you typed the address you signed up with.',
        'Lost your phone with the authenticator app: use one of the backup codes you saved when you set up two-step sign-in.',
      ),
      note('Still stuck? Use the form at the end of this page. You don’t need to be signed in.'),
    ],
  },
  {
    slug: 'your-data',
    title: 'Download or delete your data',
    summary: 'Take everything with you, or close the business.',
    topic: 'Team and account',
    body: [
      p(
        'Owners can download everything the business holds in Pepper from More → Download your data: one ZIP file. Its clients and visits files import straight back into Pepper.',
      ),
      p(
        'Deleting a business takes 30 days: the booking page closes at once, and you can keep the business any time before the day. After it, everything is gone for good.',
      ),
      note(
        'Deleting your own account is under More too. If you are a business’s only owner, delete the business or make someone else an owner first.',
      ),
    ],
  },
  {
    slug: 'support',
    title: 'How support works',
    summary: 'A person answers, the same day.',
    topic: 'Getting help',
    body: [
      steps(
        'Tap “Tell us what went wrong” under More, at the end of any article, or on a screen that didn’t load.',
        'Say what it’s about and what happened. You get a reference such as PEP-7K3Q9D.',
        'A person on the Pepper team answers the same day, by email and in Your requests.',
      ),
      p(
        'We add the page you were on, the app version, your browser and how far your setup is, so you don’t have to. Never your clients’ details.',
      ),
      note(
        'Your business’s owners and managers can read the requests of everyone in it; staff see their own.',
      ),
    ],
  },
];

/** The article with this slug, if any. */
export function helpArticle(slug: string): HelpArticle | undefined {
  return HELP_ARTICLES.find((article) => article.slug === slug);
}

/** The articles a screen links to, by the screen. Each must name an article (help.test.ts). */
export const HELP_LINKS = {
  import: 'import-clients',
  autonomy: 'autonomy',
  memory: 'memory',
  bookingPage: 'booking-page',
  support: 'support',
  signIn: 'sign-in',
} as const;

export function helpHref(slug: (typeof HELP_LINKS)[keyof typeof HELP_LINKS]): string {
  return `${HELP_PATH}/${slug}`;
}

/** Lowercased, without accents, for search. */
export function searchText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[’']/g, '');
}

function articleText(article: HelpArticle): string {
  const parts = [article.title, article.summary, article.topic];
  for (const block of article.body) {
    if (block.kind === 'p' || block.kind === 'note') parts.push(block.text);
    else parts.push(...block.items);
  }
  return searchText(parts.join(' '));
}

const INDEX = new Map(HELP_ARTICLES.map((article) => [article.slug, articleText(article)]));

/**
 * The articles that hold every word of `query` (in the title, summary, topic or text; case
 * and accents ignored), titles that match first; all of them for an empty query.
 */
export function searchHelp(query: string): HelpArticle[] {
  const words = searchText(query)
    .split(/\s+/)
    .filter((word) => word !== '');
  if (words.length === 0) return [...HELP_ARTICLES];
  const hits = HELP_ARTICLES.filter((article) => {
    const text = INDEX.get(article.slug) ?? '';
    return words.every((word) => text.includes(word));
  });
  const inTitle = (article: HelpArticle) =>
    words.every((word) => searchText(article.title).includes(word)) ? 0 : 1;
  return hits.sort((a, b) => inTitle(a) - inTitle(b));
}
