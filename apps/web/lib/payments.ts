import type { BadgeTone } from '@pepper/ui';
import type { PaymentAccountAnswer, PaymentAccountStatus } from '@pepper/contracts';

// The words of More → Payments (S65.2, AC-X-106…110, ADR-0067): where payments stand, what
// Stripe still needs and by when, and what the owner can do next. The api decides the status
// (`paymentAccountStatus`); these only say it. The owner never sees one of Stripe's codes.

export const PAYMENTS_ACCOUNT_PATH = '/v1/payments/account';
export const PAYMENTS_SYNC_PATH = '/v1/payments/account/sync';
export const PAYMENTS_ONBOARDING_PATH = '/v1/payments/onboarding';
export const PAYMENTS_DASHBOARD_PATH = '/v1/payments/dashboard';

/** A day as the owner reads it ("Dec 3"), in the business's time zone. */
export function dueDay(at: string | Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone }).format(
    typeof at === 'string' ? new Date(at) : at,
  );
}

/** What a code Pepper doesn't know reads as. */
export const UNKNOWN_REQUIREMENT = 'One more detail for Stripe';

/** Someone other than the owner filling in (another owner, a director): one line for all. */
const ANOTHER_PERSON = 'Details of another owner or director';

/** Stripe's codes, most specific first; a rule matches its code or anything below it. */
const ACCOUNT_RULES: readonly (readonly [string, string])[] = [
  ['external_account', 'Your bank account'],
  ['tos_acceptance', 'Accept Stripe’s terms'],
  ['business_type', 'Your type of business'],
  ['business_profile.name', 'Your business name'],
  ['business_profile.mcc', 'What your business does'],
  ['business_profile.product_description', 'What your business does'],
  ['business_profile.url', 'Your website, or a few words about your business'],
  ['business_profile.support_phone', 'How clients reach your business'],
  ['business_profile.support_email', 'How clients reach your business'],
  ['business_profile', 'About your business'],
  ['settings.payments.statement_descriptor', 'The name clients see on their card statement'],
  ['settings.card_payments', 'The name clients see on their card statement'],
  ['company.name', 'Your business name'],
  ['company.tax_id', 'Your business’s tax ID (EIN)'],
  ['company.address', 'Your business address'],
  ['company.phone', 'Your business phone number'],
  ['company.verification', 'A document for your business'],
  ['company.owners_provided', 'Who owns and runs the business'],
  ['company.directors_provided', 'Who owns and runs the business'],
  ['company.executives_provided', 'Who owns and runs the business'],
  ['company', 'About your business'],
  ['owners', ANOTHER_PERSON],
  ['directors', ANOTHER_PERSON],
  ['executives', ANOTHER_PERSON],
];

/** The owner's own details, after `individual.` or `representative.`. */
const PERSON_RULES: readonly (readonly [string, string])[] = [
  ['verification.additional_document', 'A proof of address'],
  ['verification', 'A photo ID'],
  ['id_number', 'Your Social Security number'],
  ['ssn_last_4', 'The last 4 digits of your Social Security number'],
  ['dob', 'Your date of birth'],
  ['first_name', 'Your name'],
  ['last_name', 'Your name'],
  ['address', 'Your home address'],
  ['email', 'Your email'],
  ['phone', 'Your phone number'],
  ['relationship', 'Your role in the business'],
];

function matches(code: string, key: string): boolean {
  return code === key || code.startsWith(`${key}.`);
}

function ruleFor(code: string, rules: readonly (readonly [string, string])[]): string | null {
  return rules.find(([key]) => matches(code, key))?.[1] ?? null;
}

/** One of Stripe's requirement codes in words ("external_account" → "Your bank account"). */
export function requirementLabel(code: string): string {
  const own = /^(?:individual|representative)\.(.+)$/.exec(code);
  if (own?.[1] !== undefined) return ruleFor(own[1], PERSON_RULES) ?? UNKNOWN_REQUIREMENT;
  // A person Stripe added by id (`person_1Abc.dob.day`): someone other than the owner.
  if (/^person_[A-Za-z0-9]+(?:\.|$)/.test(code)) return ANOTHER_PERSON;
  return ruleFor(code, ACCOUNT_RULES) ?? UNKNOWN_REQUIREMENT;
}

/** The codes as words, each said once, in Stripe's order (past due first). */
export function requirementsInWords(codes: readonly string[]): string[] {
  return [...new Set(codes.map(requirementLabel))];
}

export interface PaymentsWords {
  /** The status word on the badge. */
  badge: string;
  tone: BadgeTone;
  title: string;
  body: string;
}

/** Where payments stand, for the page's top. */
export function paymentsWords(answer: PaymentAccountAnswer, timeZone: string): PaymentsWords {
  switch (answer.status) {
    case 'not_connected':
      return {
        badge: 'Not connected',
        tone: 'neutral',
        title: 'Take deposits with Stripe',
        body: 'Connect Stripe so Pepper can take deposits for you, paid straight to your bank. Stripe asks for your bank account and a photo ID. It takes about 5 minutes.',
      };
    case 'onboarding':
      return {
        badge: 'Not finished',
        tone: 'warn',
        title: 'Finish with Stripe',
        body: 'You started with Stripe. Finish there to turn payments on. What you already sent is saved.',
      };
    case 'pending':
      return {
        badge: 'Stripe is checking',
        tone: 'info',
        title: 'Stripe is checking your details',
        body: 'That’s usually quick, sometimes a day or two. I’ll let you know when it’s done.',
      };
    case 'action_needed': {
      const many = requirementsInWords(answer.due).length > 1;
      const when = answer.dueBy === null ? '' : ` by ${dueDay(answer.dueBy, timeZone)}`;
      const payoutsWait =
        answer.chargesEnabled && !answer.payoutsEnabled ? ' Payments are on; payouts wait.' : '';
      return {
        badge: 'Needs your input',
        tone: 'warn',
        title: many ? 'Stripe needs a few more things' : 'Stripe needs one more thing',
        body: `Send ${many ? 'them' : 'it'}${when} so payments keep working.${payoutsWait}`,
      };
    }
    case 'ready':
      return {
        badge: 'Ready',
        tone: 'ok',
        title: 'Payments are ready',
        body: 'Payments and payouts are on. Money from clients goes to your bank through Stripe.',
      };
    case 'rejected':
      return {
        badge: 'Can’t take payments',
        tone: 'danger',
        title: 'Stripe can’t take payments for you',
        body: 'Stripe won’t process payments for this business. Its dashboard says why. If that doesn’t help, tell us and a person will look.',
      };
  }
}

/** The More row's one line. */
export function paymentsSummary(answer: PaymentAccountAnswer, timeZone: string): string {
  const lines: Record<PaymentAccountStatus, string> = {
    not_connected: 'Take deposits with Stripe',
    onboarding: 'Not finished with Stripe',
    pending: 'Stripe is checking your details',
    action_needed:
      answer.dueBy === null
        ? 'Stripe needs one more thing'
        : `Stripe needs one more thing by ${dueDay(answer.dueBy, timeZone)}`,
    ready: 'Payments are on',
    rejected: 'Stripe can’t take payments for you',
  };
  return lines[answer.status];
}

/** What the owner can do from here: Stripe's pages, the dashboard, a fresh check. */
export interface PaymentsActions {
  /** The button that opens Stripe's onboarding pages, or `null`. */
  onboarding: string | null;
  dashboard: boolean;
  check: boolean;
}

export function paymentsActions(answer: PaymentAccountAnswer): PaymentsActions {
  if (!answer.canManage) return { onboarding: null, dashboard: false, check: false };
  const onboarding: Partial<Record<PaymentAccountStatus, string>> = {
    not_connected: 'Connect with Stripe',
    onboarding: 'Finish with Stripe',
    action_needed: 'Send it to Stripe',
  };
  return {
    onboarding: onboarding[answer.status] ?? null,
    // Stripe's dashboard opens once the details are in (else 409 `payments_not_onboarded`).
    dashboard: answer.detailsSubmitted && answer.status !== 'not_connected',
    check: answer.status === 'pending',
  };
}

/** The toast after coming back from Stripe's pages and reading the account again. */
export function returnedNote(status: PaymentAccountStatus): string {
  switch (status) {
    case 'ready':
      return 'Payments are ready.';
    case 'pending':
      return 'Thanks. Stripe is checking what you sent.';
    case 'action_needed':
      return 'Stripe still needs one more thing.';
    case 'onboarding':
      return 'You haven’t finished with Stripe yet. Pick up where you left off.';
    case 'rejected':
      return 'Stripe can’t take payments for you.';
    case 'not_connected':
      return 'Stripe isn’t connected.';
  }
}

/** The toast after "Check with Stripe now". */
export function checkedNote(status: PaymentAccountStatus): string {
  return status === 'pending' ? 'Stripe is still checking.' : returnedNote(status);
}

/** Where the browser came back from (Stripe's return and refresh pages, the sandbox). */
export type PaymentsArrival = 'return' | 'refresh' | 'sandbox-dashboard' | null;

export function paymentsArrival(params: {
  stripe?: string | string[] | undefined;
  sandbox?: string | string[] | undefined;
}): PaymentsArrival {
  if (params.stripe === 'return') return 'return';
  if (params.stripe === 'refresh') return 'refresh';
  if (params.sandbox === 'dashboard') return 'sandbox-dashboard';
  return null;
}

/** The delete-business screen's line about Stripe (AC-X-110, ADR-0067 §10). */
export const DELETION_STRIPE_NOTE = {
  title: 'Your Stripe account stays yours',
  meta: 'Pepper can’t close it for you. If you want it closed, ask Stripe.',
} as const;
