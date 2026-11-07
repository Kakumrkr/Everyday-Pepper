import type {
  SupportAuthor,
  SupportContextInput,
  SupportKind,
  SupportStatus,
} from '@pepper/contracts';

// "Tell us what went wrong" and "Your requests" (S59, PCR-010, AC-X-14…16): the words the
// screens use and the context a request carries. The api decides who reads what.

export const SUPPORT_PATHS = {
  list: '/support',
  new: '/support/new',
  thread: (id: string) => `/support/${id}`,
} as const;

/** What a request is about, as the form offers it. */
export const SUPPORT_KINDS: readonly { value: SupportKind; label: string; hint: string }[] = [
  {
    value: 'problem',
    label: 'Something’s not working',
    hint: 'An error, a wrong number, a stuck screen',
  },
  { value: 'question', label: 'A question', hint: 'How to do something in Pepper' },
  { value: 'idea', label: 'An idea', hint: 'Something Pepper should do' },
];

export const SUPPORT_KIND_LABEL: Readonly<Record<SupportKind, string>> = {
  problem: 'Something’s not working',
  question: 'A question',
  idea: 'An idea',
};

/** A thread's status in words, with the badge tone that shows it. */
export const SUPPORT_STATUS: Readonly<
  Record<SupportStatus, { label: string; tone: 'neutral' | 'info' | 'ok' }>
> = {
  waiting_on_pepper: { label: 'Waiting on Pepper', tone: 'neutral' },
  pepper_replied: { label: 'Pepper replied', tone: 'info' },
  solved: { label: 'Solved', tone: 'ok' },
};

/** Who wrote a message, as the thread shows it. */
export function authorLabel(author: SupportAuthor): string {
  switch (author.kind) {
    case 'you':
      return 'You';
    case 'teammate':
      return author.name;
    case 'former_member':
      return 'A former team member';
    case 'pepper':
      return 'Pepper team';
  }
}

const APP_PATH = /^\/(?!\/)[A-Za-z0-9\-._~/%]*$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ERROR_REF = /^[A-Za-z0-9._:-]{1,100}$/;

/**
 * The context of a new request from the address's query (`?from=/clients/import&topic=…&error=…`)
 * and the screen's size: only values of the shapes the api takes, so a pasted link can't fill
 * in anything else. The rest (version, browser, setup) the server adds.
 */
export function supportContext(
  query: { from?: string | null; topic?: string | null; error?: string | null },
  viewport: { width: number; height: number } | null,
): SupportContextInput {
  const page = query.from ?? null;
  const topic = query.topic ?? null;
  const error = query.error ?? null;
  return {
    ...(page !== null && page.length <= 200 && APP_PATH.test(page) && { page }),
    ...(topic !== null && topic.length <= 80 && SLUG.test(topic) && { topic }),
    ...(error !== null && ERROR_REF.test(error) && { errorRef: error }),
    ...(viewport !== null &&
      viewport.width >= 1 &&
      viewport.height >= 1 && {
        viewport: {
          width: Math.min(10_000, Math.round(viewport.width)),
          height: Math.min(10_000, Math.round(viewport.height)),
        },
      }),
  };
}

/** The address of a new request from a page, an article or an error. */
export function newRequestHref(from: { page?: string; topic?: string; error?: string }): string {
  const query = new URLSearchParams();
  if (from.page !== undefined) query.set('from', from.page);
  if (from.topic !== undefined) query.set('topic', from.topic);
  if (from.error !== undefined) query.set('error', from.error);
  const text = query.toString();
  return text === '' ? SUPPORT_PATHS.new : `${SUPPORT_PATHS.new}?${text}`;
}

/** When something happened, for the thread: `Today, 2:05 PM`, `Nov 3, 9:00 AM`, in `timeZone`. */
export function supportTime(at: string, timeZone: string, now: number): string {
  const day = (ms: number) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(ms);
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(Date.parse(at));
  const then = day(Date.parse(at));
  if (then === day(now)) return `Today, ${time}`;
  if (then === day(now - 24 * 60 * 60 * 1000)) return `Yesterday, ${time}`;
  const date = new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
  }).format(Date.parse(at));
  return `${date}, ${time}`;
}
