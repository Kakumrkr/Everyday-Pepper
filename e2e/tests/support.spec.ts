import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { hydrated, onboardOwner, ownClientAddress, unique } from './helpers.js';
import { expectTapTargets } from './tap-targets.js';

// Pepper's own support through the screens (S59, PCR-010, AC-X-14/15): an owner sends "Tell us
// what went wrong" from More, the team's address gets it with Reply-To the owner, and the
// request lives on in Your requests, where the owner replies and marks it solved. Who reads
// which request, the team's answers and the unread count are in core's support.int.test.ts.

test.beforeEach(async ({ context }) => {
  await ownClientAddress(context);
});

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const MAILPIT_URL = process.env['MAILPIT_URL'] ?? 'http://localhost:8025';
const SUPPORT_EMAIL = 'support@pepper.localhost';

interface MailpitMessage {
  Subject: string;
  Text: string;
  ReplyTo: { Address: string }[];
}

/** The team's email about `reference` whose subject starts with `prefix`, within 15 seconds. */
async function teamEmail(reference: string, prefix = '['): Promise<MailpitMessage> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const search = await fetch(
      `${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:"${SUPPORT_EMAIL}" subject:"${reference}"`)}`,
    );
    const { messages } = (await search.json()) as { messages: { ID: string; Subject: string }[] };
    const found = messages.find((message) => message.Subject.startsWith(prefix));
    if (found !== undefined) {
      const message = await fetch(`${MAILPIT_URL}/api/v1/message/${found.ID}`);
      return (await message.json()) as MailpitMessage;
    }
    if (Date.now() > deadline) throw new Error(`No team email about ${reference}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function scanned(page: Page): Promise<void> {
  const axe = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual(
    [],
  );
}

test('support (AC-X-14/15): an owner asks from More, the team hears, the owner replies and solves', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const business = `Juniper ${unique('support')}`;
  const owner = await onboardOwner(page, { business });

  await page.goto('/more');
  await page.getByRole('link', { name: /Tell us what went wrong/ }).click();
  await expect(page).toHaveURL(/\/support\/new\?from=%2Fmore$/);
  await expect(
    page.getByRole('heading', { name: 'Tell us what went wrong', level: 1 }),
  ).toBeVisible();
  await expect(page.getByText('Never your clients’ details.')).toBeVisible();
  await expect(page.getByText(owner.email)).toBeVisible();
  await scanned(page);
  await expectTapTargets(page, 'Tell us what went wrong');

  // Nothing written: the form asks for words first.
  await (await hydrated(page.getByRole('button', { name: 'Send to Pepper' }))).click();
  await expect(page.getByText('Write a few words about it.')).toBeVisible();

  await page.getByRole('radio', { name: /A question/ }).check();
  await page.getByLabel('Tell us what happened').fill('How do I add a second barber?');
  await page.getByRole('button', { name: 'Send to Pepper' }).click();
  const sent = page.getByTestId('support-sent');
  await expect(sent).toContainText('We got it');
  await expect(sent).toContainText(owner.email);
  const reference = (await page.getByTestId('support-reference').textContent()) ?? '';
  expect(reference).toMatch(/^PEP-[0-9A-HJKMNP-TV-Z]{6}$/);

  const email = await teamEmail(reference);
  expect(email.Subject).toBe(`[${reference}] A question — ${business}`);
  expect(email.ReplyTo.map((to) => to.Address)).toEqual([owner.email]);
  expect(email.Text).toContain('How do I add a second barber?');
  expect(email.Text).toContain('Page: /more');
  expect(email.Text).toContain(`owner at ${business}`);

  await page.getByRole('link', { name: 'See your request' }).click();
  await expect(page.getByTestId('support-thread-reference')).toHaveText(reference);
  await expect(page.getByText('Waiting on Pepper')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Messages' })).toContainText(
    'How do I add a second barber?',
  );
  await scanned(page);
  await expectTapTargets(page, 'a support request');

  await page.getByLabel('Your reply').fill('Also: can they have their own hours?');
  await (await hydrated(page.getByRole('button', { name: 'Send reply' }))).click();
  await expect(page.getByRole('list', { name: 'Messages' }).getByRole('listitem')).toHaveCount(2);
  const reply = await teamEmail(reference, 'Re: ');
  expect(reply.Text).toContain('Also: can they have their own hours?');

  await page.getByRole('button', { name: 'Mark as solved' }).click();
  await expect(page.getByText('Solved', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark as solved' })).toHaveCount(0);

  await page.getByRole('link', { name: 'Your requests' }).click();
  await expect(page).toHaveURL(/\/support$/);
  const row = page.getByRole('link', { name: /How do I add a second barber\?/ });
  await expect(row).toContainText(reference);
  await expect(row).toContainText('Solved');
  await scanned(page);
});

test('support: a screen that breaks offers the request with its reference', async ({ page }) => {
  test.setTimeout(120_000);
  await onboardOwner(page);
  // An empty list says what to do next (D5).
  await page.goto('/support');
  await expect(page.getByText('No requests yet')).toBeVisible();
  await page.getByRole('link', { name: 'Tell us what went wrong' }).click();
  await expect(page).toHaveURL(/\/support\/new\?from=%2Fsupport$/);
  // From an error screen the form opens on "Something's not working".
  await page.goto('/support/new?from=%2Fcalendar&error=digest-123');
  await expect(page.getByRole('radio', { name: /Something’s not working/ })).toBeChecked();
});
