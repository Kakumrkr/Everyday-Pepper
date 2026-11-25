import {
  BookingSchema,
  BookingsResponseSchema,
  ClientSchema,
  CurrentBusinessResponseSchema,
  ServiceSchema,
  StaffMemberSchema,
} from '@pepper/contracts';
import { expect, test, type Browser, type Page } from '@playwright/test';
import {
  anotherPerson,
  callApi,
  emailTo,
  hydrated,
  onboardOwner,
  ownClientAddress,
  unique,
} from './helpers.js';
import { stripeSays } from './payments-helpers.js';

// Deposits on screen (S66.2, AC-X-121…124, ADR-0068), through the Stripe sandbox: the owner sets
// a $15 deposit on the service sheet and the refund window in booking page settings; a client
// books, sees the terms in words before the card field, is declined once, pays and is booked;
// behind their link the manage page says what cancelling does to the deposit before they do,
// and what happened after: back inside the window, kept after it. The sandbox's test card stands
// in for Stripe's field and settles the payment through the dev route (AC-X-120).

test.beforeEach(async ({ context }) => {
  await ownClientAddress(context);
});

const EVERY_DAY = {
  intervals: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start: '09:00', end: '17:00' })),
};

/** A $45 haircut Jess offers every day, and payments ready in the sandbox. */
async function salonWithPayments(page: Page): Promise<string> {
  return (await salonParts(page)).slug;
}

async function salonParts(page: Page) {
  const tenant = CurrentBusinessResponseSchema.parse(
    await (await page.request.get('/v1/tenant')).json(),
  );
  const service = await callApi(
    page,
    'POST',
    '/v1/services',
    { name: 'Haircut', durationMinutes: 60, priceFromCents: 4500 },
    ServiceSchema,
  );
  const jess = await callApi(
    page,
    'POST',
    '/v1/staff',
    { displayName: 'Jess', serviceIds: [service.id] },
    StaffMemberSchema,
  );
  await callApi(page, 'PUT', `/v1/staff/${jess.id}/hours`, EVERY_DAY, {
    parse: (body: unknown) => body,
  });
  // Connected (the sandbox's link comes straight back), then Stripe says it's ready.
  await callApi(page, 'POST', '/v1/payments/onboarding', {}, { parse: (body) => body }, 200);
  await stripeSays(page, 'ready');
  return { slug: tenant.business.slug, serviceId: service.id, jessId: jess.id };
}

/**
 * A client books the haircut `day` days ahead, pays the deposit (declined once first) and opens
 * their manage page from the confirmation email.
 */
async function bookAndPay(
  browser: Browser,
  baseURL: string | undefined,
  slug: string,
  day: number,
  refund: RegExp,
  policy: string,
) {
  const client = await anotherPerson(browser, baseURL);
  const email = `${unique('deposit')}@example.test`;
  await client.goto(`/book/${slug}`);
  // AC-X-113: the menu says what booking it asks for.
  const haircut = await hydrated(client.getByRole('button', { name: /Haircut/ }));
  await expect(haircut).toContainText('$15 deposit');
  await haircut.click();
  await client.getByRole('button', { name: /Anyone available/ }).click();
  await client.getByRole('group', { name: 'Day' }).getByRole('button').nth(day).click();
  await client.getByTestId('free-times').getByRole('button').first().click();
  await client.getByLabel('Full name').fill('Bea Lopez');
  await client.getByLabel('Email').fill(email);
  await client.getByRole('button', { name: 'Send my code' }).click();
  await expect(client.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  const code = /^ {4}(\d{6})$/m.exec(await emailTo(email, 'is your code'))?.[1] ?? '';
  await client.getByLabel('Code').fill(code);
  await client.getByRole('button', { name: 'Continue' }).click();

  // AC-X-122: the terms in words before the card.
  await expect(client.getByRole('heading', { name: 'Almost booked' })).toBeVisible();
  const terms = client.getByTestId('deposit-terms');
  await expect(terms).toContainText('Pay a $15 deposit to book');
  await expect(terms).toContainText(refund);
  await expect(terms).toContainText('The rest is paid at your visit.');
  // A declined card books nothing.
  await client.getByRole('button', { name: 'Try a declined card' }).click();
  await expect(client.getByText('Your card was declined. Try another card.')).toBeVisible();
  await client.getByRole('button', { name: 'Pay $15 and book' }).click();
  await expect(client.getByRole('heading', { name: /You’re booked, Bea/ })).toBeVisible();

  const confirmation = await emailTo(email, 'booked at');
  // AC-X-134: the email says the deposit in the team sheet's words; AC-X-133: and the policy.
  expect(confirmation).toMatch(
    /\$15 deposit paid · (refundable until \w{3}, \w{3} \d{1,2}, \d{1,2}:\d{2} (AM|PM)|no longer refundable)/,
  );
  // Mailpit's text keeps the mail's line ends; compare the words.
  expect(confirmation.replace(/\s+/g, ' ')).toContain(`Cancellation policy: ${policy}`);
  const link = /(https?:\/\/\S+\/book\/\S+\/manage#[A-Za-z0-9_-]{43})/.exec(confirmation)?.[1];
  expect(link).toBeDefined();
  const url = new URL(link ?? '');
  await client.goto(url.pathname + url.hash);
  await expect(client.getByRole('heading', { name: 'Your booking' })).toBeVisible();
  // AC-X-132: the manage page says the policy too.
  await expect(client.getByTestId('policy-sentence')).toHaveText(policy);
  return client;
}

/** The policy the owner builds below (S67.2): a day's notice, $20 for a no-show. */
const POLICY_SENTENCE =
  'Please cancel or reschedule at least 24 hours before your visit. No-shows may be charged $20.';

/** The owner turns the cancellation policy on with a $20 no-show fee (S67.2, AC-X-130/131). */
async function buildPolicy(page: Page): Promise<void> {
  const policy = page
    .getByRole('region', { name: 'Your booking page' })
    .getByRole('form', { name: 'Cancellation policy' });
  await (
    await hydrated(
      policy
        .getByRole('radiogroup', { name: 'Cancellation policy' })
        .getByRole('radio', { name: 'On' }),
    )
  ).click();
  const noShow = policy.getByRole('radiogroup', { name: 'A no-show costs' });
  await noShow.getByRole('radio', { name: 'Amount' }).click();
  await policy.getByLabel('No-show fee ($)').fill('20');
  await expect(policy.getByTestId('policy-preview')).toContainText(POLICY_SENTENCE);
  await policy.getByRole('button', { name: 'Save policy' }).click();
  await expect(
    policy.getByText('Saved. Clients see it when they book and in their emails.'),
  ).toBeVisible();
}

test('an owner asks a $15 deposit; a client pays it, and cancelling in time gives it back while a late cancel keeps it', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000);
  await onboardOwner(page);
  const slug = await salonWithPayments(page);

  // AC-X-121: the deposit on the service sheet, in dollars, checked against the price.
  await page.goto('/services');
  await (await hydrated(page.getByRole('button', { name: 'Edit Haircut' }))).click();
  const sheet = page.getByRole('dialog', { name: 'Edit Haircut' });
  await sheet.getByRole('radio', { name: 'Amount' }).click();
  await sheet.getByLabel('Deposit ($)').fill('50');
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(sheet.getByText('The deposit can be at most the price.')).toBeVisible();
  await sheet.getByRole('radio', { name: 'Percent' }).click();
  await sheet.getByLabel('Deposit (% of the price)').fill('20');
  await expect(sheet.getByText('20% · $9 of $45')).toBeVisible();
  await sheet.getByRole('radio', { name: 'Amount' }).click();
  await sheet.getByLabel('Deposit ($)').fill('15');
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByTestId('service').filter({ hasText: 'Haircut' })).toContainText(
    'Deposit $15',
  );

  // AC-X-112: the window, 24 hours to start with, said in a sentence; since S67.2 it is the
  // cancellation policy's notice, and the policy is built from it.
  const window = page.getByRole('combobox', { name: 'Notice to cancel or reschedule' });
  await expect(window).toHaveValue('24');
  await expect(
    page.getByText(
      'Clients who cancel at least 24 hours before get their deposit back. Later, it’s kept.',
    ),
  ).toBeVisible();
  await buildPolicy(page);

  // In time (three days ahead, a 24-hour window): the page says the $15 comes back.
  const early = await bookAndPay(
    browser,
    baseURL,
    slug,
    3,
    /Cancel by .+ and you get the \$15 back\. After that, it’s kept\./,
    POLICY_SENTENCE,
  );
  await expect(early.getByTestId('deposit-status')).toContainText(
    /You paid a \$15 deposit\. Cancel by .+ to get it back\./,
  );
  // AC-X-129: the owner's booking sheet says it in one line, without opening Stripe.
  const { business } = CurrentBusinessResponseSchema.parse(
    await (await page.request.get('/v1/tenant')).json(),
  );
  const listed = BookingsResponseSchema.parse(
    await (
      await page.request.get('/v1/bookings', {
        params: {
          from: new Date().toISOString(),
          to: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        },
      })
    ).json(),
  );
  const paid = listed.bookings.find((b) => b.source === 'booking_page');
  if (paid === undefined) throw new Error('no booking from the page');
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: business.timeZone }).format(
    new Date(paid.startsAt),
  );
  await page.goto(`/calendar?date=${day}`);
  await (await hydrated(page.getByTestId('booking-block'))).click();
  await expect(page.getByTestId('booking-deposit')).toHaveText(
    /^\$15 deposit paid · refundable until .+ (AM|PM)$/,
  );
  // The team's cancel says what it does to the deposit before they confirm (AC-X-118).
  await page.getByRole('button', { name: 'Cancel booking' }).click();
  await expect(page.getByTestId('booking-cancel-deposit')).toHaveText(
    'Their $15 deposit goes back to their card.',
  );
  await page.getByRole('button', { name: 'Keep it' }).click();
  await page.keyboard.press('Escape');
  await (await hydrated(early.getByRole('button', { name: 'Cancel booking' }))).click();
  await expect(early.getByTestId('cancel-deposit')).toHaveText('Cancel now and get your $15 back.');
  await early.getByRole('button', { name: 'Yes, cancel it' }).click();
  await expect(early.getByText('Your booking is cancelled.')).toBeVisible();
  await expect(early.getByTestId('deposit-status')).toHaveText(
    /Your \$15 deposit (is on its way back to your card|was refunded to your card)/,
  );
  // The worker refunds it through the outbox: the page says so once it has.
  await expect
    .poll(
      async () => {
        await early.reload();
        return early.getByTestId('deposit-status').textContent();
      },
      { timeout: 30_000 },
    )
    .toBe('Your $15 deposit was refunded to your card.');

  // A week's window: a cancel two days ahead is late, and the page says so before it.
  await page.goto('/services');
  await (await hydrated(window)).selectOption('168');
  await expect(page.getByText(/^Clients who cancel at least a week before/)).toBeVisible();
  await expect(page.getByTestId('policy-preview')).toContainText('at least a week before your visit');
  await page.getByRole('button', { name: 'Save policy' }).click();
  await expect(
    page.getByText('Saved. Clients see it when they book and in their emails.'),
  ).toBeVisible();

  const late = await bookAndPay(
    browser,
    baseURL,
    slug,
    2,
    /Your visit is soon, so the \$15 is kept if you cancel\./,
    POLICY_SENTENCE.replace('24 hours', 'a week'),
  );
  await (await hydrated(late.getByRole('button', { name: 'Cancel booking' }))).click();
  await expect(late.getByTestId('cancel-deposit')).toHaveText(
    'Your $15 deposit is kept if you cancel now.',
  );
  await late.getByRole('button', { name: 'Yes, cancel it' }).click();
  await expect(late.getByTestId('deposit-status')).toHaveText('Your $15 deposit was kept.');
});

test('with "New and no-shows", a regular books with no card, and the menu says who pays (S67)', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  await onboardOwner(page);
  const { slug, serviceId, jessId } = await salonParts(page);
  await callApi(
    page,
    'PUT',
    `/v1/services/${serviceId}`,
    {
      name: 'Haircut',
      durationMinutes: 60,
      priceFromCents: 4500,
      deposit: { kind: 'fixed', amountCents: 1500 },
    },
    ServiceSchema,
  );
  // A regular: a client whose visit two days ago has ended (the team booked it then).
  const email = `${unique('regular')}@example.test`;
  const regular = await callApi(
    page,
    'POST',
    '/v1/clients',
    { name: 'Rae Kim', email },
    ClientSchema,
  );
  const past = new Date(Date.now() - 2 * 86_400_000);
  past.setUTCMinutes(0, 0, 0);
  await callApi(
    page,
    'POST',
    '/v1/bookings',
    {
      clientId: regular.id,
      serviceId,
      staffMemberId: jessId,
      startsAt: past.toISOString(),
      override: true,
      notifyClient: false,
    },
    BookingSchema,
  );

  // AC-X-125: the owner chooses who pays, and the sentence says what it means.
  await page.goto('/services');
  const who = page.getByRole('radiogroup', { name: 'Who pays a deposit' });
  await (await hydrated(who.getByRole('radio', { name: 'New and no-shows' }))).click();
  await expect(
    page.getByText(
      'Clients who’ve visited before book without one, unless they missed a visit in the last 12 months.',
    ),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Save deposits' }).click();
  await expect(page.getByText('Saved. New bookings follow this.')).toBeVisible();
  // AC-X-128: the service sheet says it too.
  await (await hydrated(page.getByRole('button', { name: 'Edit Haircut' }))).click();
  await expect(
    page.getByText('Only new clients and clients who missed a visit pay it. Regulars don’t.'),
  ).toBeVisible();

  // AC-X-127: the regular books; after the code there's no card step.
  const client = await anotherPerson(browser, baseURL);
  await client.goto(`/book/${slug}`);
  const haircut = await hydrated(client.getByRole('button', { name: /Haircut/ }));
  await expect(haircut).toContainText('$15 deposit for new clients');
  await haircut.click();
  await client.getByRole('button', { name: /Anyone available/ }).click();
  await client.getByRole('group', { name: 'Day' }).getByRole('button').nth(3).click();
  await client.getByTestId('free-times').getByRole('button').first().click();
  await client.getByLabel('Full name').fill('Rae Kim');
  await client.getByLabel('Email').fill(email);
  await client.getByRole('button', { name: 'Send my code' }).click();
  await expect(client.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  const code = /^ {4}(\d{6})$/m.exec(await emailTo(email, 'is your code'))?.[1] ?? '';
  await client.getByLabel('Code').fill(code);
  await client.getByRole('button', { name: 'Continue' }).click();
  await expect(client.getByRole('heading', { name: /You’re booked, Rae/ })).toBeVisible();
  await expect(client.getByRole('heading', { name: 'Almost booked' })).toHaveCount(0);
});
