import { AxeBuilder } from '@axe-core/playwright';
import { solidColorPhoto } from '@pepper/storage';
import {
  SupportCreatedSchema,
  SupportSavedReplyListSchema,
  SupportScreenshotSchema,
} from '@pepper/contracts';
import { expect, test, type Page } from '@playwright/test';
import {
  anotherPerson,
  callApi,
  hydrated,
  makeOperator,
  onboardOwner,
  ownClientAddress,
  unique,
} from './helpers.js';
import { expectTapTargets } from './tap-targets.js';

// Pepper's support console through the screens (S59.2, ADR-0062, AC-X-19…22): an owner can't
// open it; an operator finds the owner's request in the inbox with how long it has waited,
// opens it (the owner sees "Seen by Pepper"), notes, replies and solves it, and answers a
// signed-out request by email. Every status and the access log are in core's
// operator-support.int.test.ts; the database rules in db's operator.int.test.ts. S59.2.2
// (AC-X-23/26): the reply starts from a saved reply, and the owner says whether it helped,
// which the console shows; the job's rules are in core's support-housekeeping.int.test.ts.

test.beforeEach(async ({ context }) => {
  await ownClientAddress(context);
});

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function scanned(page: Page, name: string): Promise<void> {
  const axe = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(
    axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical'),
    name,
  ).toEqual([]);
  await expectTapTargets(page, name);
}

test('the console (AC-X-19…22): an operator answers an owner and a signed-out request', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(240_000);
  const owner = await onboardOwner(page, { business: `Juniper ${unique('ops')}` });
  await page.goto('/more');
  const created = await callApi(
    page,
    'POST',
    '/v1/support/threads',
    {
      kind: 'problem',
      message: 'Reminders didn’t go out this morning',
      context: { page: '/calendar' },
    },
    SupportCreatedSchema,
  );
  const threadId = created.id ?? '';

  // AC-X-19: an owner finds nothing at /ops, and the api refuses them.
  const refused = await page.goto('/ops');
  expect(refused?.status()).toBe(404);
  expect((await page.request.get('/v1/ops/inbox')).status()).toBe(403);
  expect(owner.email).toMatch(/@example\.test$/);

  // A Pepper team member's account (with two-step verification), granted by the script.
  const ops = await anotherPerson(browser, baseURL);
  const operator = await onboardOwner(ops, { business: `Pepper HQ ${unique('team')}` });
  makeOperator(operator.email);

  // A signed-out request too.
  const publicSent = await ops.request.post('/v1/public/support', {
    data: { email: `locked-${unique('out')}@example.test`, message: 'I can’t sign in at all' },
    headers: { origin: new URL(baseURL ?? 'http://localhost:3000').origin },
  });
  expect(publicSent.status()).toBe(201);
  const publicReference = SupportCreatedSchema.parse(await publicSent.json()).reference;

  // AC-X-20: the inbox, the longest waiting first, with the wait in words.
  await ops.goto('/ops');
  await expect(ops.getByRole('heading', { name: 'Inbox', level: 1 })).toBeVisible();
  const row = ops
    .getByRole('link', { name: /Reminders didn’t go out this morning/ })
    .filter({ hasText: created.reference });
  await expect(row).toContainText(created.reference);
  await expect(row).toContainText(/Just in|\d+ min waiting/);
  const publicRow = ops
    .getByRole('link', { name: /I can’t sign in at all/ })
    .filter({ hasText: publicReference });
  await expect(publicRow).toContainText('Signed-out');
  const rows = await ops.getByTestId('ops-waited').count();
  expect(rows).toBeGreaterThanOrEqual(2);
  await scanned(ops, 'ops inbox');

  // AC-X-21/22: open, note, reply, solve.
  await row.click();
  await expect(ops).toHaveURL(new RegExp(`/ops/threads/${threadId}$`));
  await expect(ops.getByTestId('ops-thread-reference')).toHaveText(created.reference);
  await expect(ops.getByText(/, owner$/)).toBeVisible();
  await ops.getByText('Sent with').click();
  await expect(ops.getByText('/calendar')).toBeVisible();
  await scanned(ops, 'ops thread');
  await (await hydrated(ops.getByRole('button', { name: 'Save note' }))).click();
  await expect(ops.getByText('Write the note first.')).toBeVisible();
  await ops.getByLabel('Add a note').fill('Their reminder job ran; check the SMS consent');
  await ops.getByRole('button', { name: 'Save note' }).click();
  await expect(ops.getByText('Their reminder job ran; check the SMS consent')).toBeVisible();

  // AC-X-23: a saved reply, added once, starts the answer with the owner's first name.
  await ops.getByRole('link', { name: 'Saved replies' }).click();
  await expect(ops.getByRole('heading', { name: 'Saved replies', level: 1 })).toBeVisible();
  await (await hydrated(ops.getByRole('button', { name: 'Save reply' }))).click();
  await expect(ops.getByText('Give it a title.')).toBeVisible();
  const title = `Reminders fixed ${unique('r')}`;
  await ops.getByLabel('Title', { exact: true }).fill(title);
  await ops
    .getByLabel('Reply', { exact: true })
    .fill('Hi {first name}, fixed: reminders go out again from tomorrow.');
  await ops.getByRole('button', { name: 'Save reply' }).click();
  await expect(ops.getByRole('status')).toContainText(`Saved “${title}”.`);
  await expect(ops.getByRole('heading', { name: title, level: 2 })).toBeVisible();
  await scanned(ops, 'ops saved replies');
  await ops.goBack();
  await ops.goto(`/ops/threads/${threadId}`);
  await (await hydrated(ops.getByLabel('Use a saved reply'))).selectOption({ label: title });
  await expect(ops.getByLabel('Reply to the business')).toHaveValue(
    'Hi Ana, fixed: reminders go out again from tomorrow.',
  );
  await ops.getByRole('button', { name: 'Send reply' }).click();
  await expect(ops.getByText('Hi Ana, fixed: reminders go out again from tomorrow.')).toBeVisible();
  await expect(ops.getByText('We replied').first()).toBeVisible();
  await ops.getByRole('radio', { name: 'Solved' }).click();
  await expect(ops.getByRole('radio', { name: 'Solved' })).toHaveAttribute('data-state', 'on');

  // The owner sees the team's answer and that Pepper saw it; never the note.
  await page.goto(`/support/${threadId}`);
  await expect(
    page.getByText('Hi Ana, fixed: reminders go out again from tomorrow.'),
  ).toBeVisible();
  await expect(page.getByTestId('support-thread-seen')).toContainText('Seen by Pepper');
  await expect(page.getByText('Solved', { exact: true })).toBeVisible();
  await expect(page.getByText(/check the SMS consent/)).toHaveCount(0);

  // AC-X-26: the owner who asked says whether it helped; the console shows it.
  const helpful = page.getByRole('button', { name: 'Helpful', exact: true });
  await expect(page.getByText('Did this help?')).toBeVisible();
  await scanned(page, 'support thread, solved');
  await (await hydrated(helpful)).click();
  await expect(helpful).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Thanks for telling us. You can change it.')).toBeVisible();
  await ops.goto('/ops?view=solved');
  // Every business's solved requests are listed: this one by its reference.
  await expect(
    ops
      .getByRole('link', { name: /Reminders didn’t go out this morning/ })
      .filter({ hasText: created.reference }),
  ).toContainText('Helpful');

  // A signed-out request: reply by email from the team's inbox, then mark it answered.
  await ops.goto('/ops');
  await ops
    .getByRole('link', { name: /I can’t sign in at all/ })
    .filter({ hasText: publicReference })
    .click();
  await expect(ops.getByText(publicReference)).toBeVisible();
  const mail = ops.getByRole('link', { name: 'Reply by email' });
  await expect(mail).toHaveAttribute(
    'href',
    new RegExp(`^mailto:locked-.*\\?subject=.*${publicReference}`),
  );
  await scanned(ops, 'ops request');
  await (await hydrated(ops.getByRole('radio', { name: 'Answered' }))).click();
  await expect(ops.getByRole('radio', { name: 'Answered' })).toHaveAttribute('data-state', 'on');
  await ops.goto('/ops?view=answered');
  await expect(
    ops.getByRole('link', { name: /I can’t sign in at all/ }).filter({ hasText: publicReference }),
  ).toContainText(/ago|Just in/);
  // Leaves the team's list as it found it (saved replies are shared, at most 100).
  const removed = await ops.request.delete(`/v1/ops/replies/${await savedReplyId(ops, title)}`, {
    headers: { origin: new URL(baseURL ?? 'http://localhost:3000').origin },
  });
  expect(removed.status()).toBe(204);
  await ops.context().close();
});

async function savedReplyId(page: Page, title: string): Promise<string> {
  const listed = SupportSavedReplyListSchema.parse(
    await (await page.request.get('/v1/ops/replies')).json(),
  );
  const found = listed.replies.find((reply) => reply.title === title);
  if (found === undefined) throw new Error(`no saved reply "${title}"`);
  return found.id;
}

test('the console’s screenshots (AC-X-30): counted in the inbox row, shown in the thread', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000);
  await onboardOwner(page, { business: `Fig ${unique('shots')}` });
  await page.goto('/more');
  const origin = new URL(baseURL ?? 'http://localhost:3000').origin;
  const shotIds: string[] = [];
  for (const size of [
    [1170, 2532],
    [800, 600],
  ] as const) {
    const uploaded = await page.request.post('/v1/support/screenshots', {
      data: await solidColorPhoto(size[0], size[1], 'png'),
      headers: { origin, 'content-type': 'image/png' },
    });
    expect(uploaded.status()).toBe(201);
    shotIds.push(SupportScreenshotSchema.parse(await uploaded.json()).id);
  }
  const created = await callApi(
    page,
    'POST',
    '/v1/support/threads',
    { kind: 'problem', message: 'The week view is blank', screenshotIds: shotIds },
    SupportCreatedSchema,
  );

  const ops = await anotherPerson(browser, baseURL);
  const operator = await onboardOwner(ops, { business: `Pepper HQ ${unique('team')}` });
  makeOperator(operator.email);
  await ops.goto('/ops');
  const row = ops
    .getByRole('link', { name: /The week view is blank/ })
    .filter({ hasText: created.reference });
  await expect(row.getByTestId('ops-screenshots')).toHaveText('2 screenshots');
  await row.click();
  const images = ops.getByTestId('message-screenshots').getByRole('img');
  await expect(images).toHaveCount(2);
  await expect(images.first()).toHaveAttribute(
    'alt',
    /^Screenshot 1 of 2 from .+, opens full size$/,
  );
  await expect
    .poll(() => images.first().evaluate((img) => (img as HTMLImageElement).naturalWidth), {
      timeout: 15_000,
    })
    .toBeGreaterThan(0);
  const full = await ops.request.get(
    (await ops.getByTestId('message-screenshots').getByRole('link').first().getAttribute('href')) ??
      '',
  );
  expect(full.status()).toBe(200);
  expect(full.headers()['cache-control']).toBe('private, no-store');
  // A member can't use the console's address.
  expect((await page.request.get(`/v1/ops/screenshots/${shotIds[0] ?? ''}`)).status()).toBe(403);
  await scanned(ops, 'ops thread with screenshots');
});
