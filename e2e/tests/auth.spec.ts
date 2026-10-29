import { expect, test } from '@playwright/test';
import {
  anotherPerson,
  emailsTo,
  enterPassword,
  freshCode,
  hydrated,
  linkTo,
  onboardOwner,
  ownClientAddress,
  PASSWORD,
  pickBusinessType,
  signOut,
  signUp,
  unique,
} from './helpers.js';

// The owner journey through the real stack (web → api → Postgres): sign up, create a business,
// set up two-step verification, sign out, sign in again with a code or a backup code.

test.beforeEach(async ({ context }) => {
  await ownClientAddress(context);
});

test.describe('owner sign-in with two-step verification', () => {
  test('sign up, create a business, set up MFA, then sign in again with a code', async ({
    page,
  }) => {
    test.setTimeout(90_000); // may wait for the next 30-second code
    const owner = await onboardOwner(page);
    await signOut(page);

    await enterPassword(page, owner.email);
    await expect(page.getByRole('heading', { name: 'Two-step verification' })).toBeVisible();
    // A password alone opens nothing.
    await page.goto('/');
    await expect(page).toHaveURL(/\/sign-in$/);

    await enterPassword(page, owner.email);
    await page.getByLabel('Code').fill('000000');
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'didn’t work' })).toBeVisible();

    await page.getByLabel('Code').fill(await freshCode(owner.secret, owner.usedCodes));
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId('business-name')).toHaveText(owner.business);
  });

  test('a backup code works once instead of the app', async ({ page }) => {
    test.setTimeout(60_000);
    const owner = await onboardOwner(page);
    const [backup] = owner.backupCodes;
    await signOut(page);

    await enterPassword(page, owner.email);
    await page.getByRole('button', { name: 'Use a backup code instead' }).click();
    await page.getByLabel('Backup code').fill(backup ?? '');
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page.getByTestId('business-role')).toHaveText('owner');
  });

  test('a wrong password is refused without saying which part was wrong', async ({ page }) => {
    await page.goto('/sign-in');
    await enterPassword(page, `${unique('nobody')}@example.test`, 'not the password');
    // (Next's route announcer is an empty alert too, so match the form's by its text.)
    await expect(
      page.getByRole('alert').filter({ hasText: 'That email and password don’t match.' }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/sign-in$/);
  });

  test('pages that need an account send visitors to sign in', async ({ page }) => {
    for (const path of ['/', '/onboarding/business', '/security/two-factor']) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/sign-in$/);
    }
  });

  // S43.2 walkthrough: an empty sign-up said "Something went wrong"; a wrong setup code's error
  // sat under the action bar, out of view on a phone.
  test('sign-up says what each empty field needs, and focuses the first', async ({ page }) => {
    await page.goto('/sign-up');
    await (await hydrated(page.getByRole('button', { name: 'Create account' }))).click();
    await expect(page.getByLabel('Your name')).toBeFocused();
    await expect(page.getByLabel('Your name')).toHaveAccessibleDescription(/Enter your name/);
    await expect(page.getByText('Enter your email. You’ll sign in with it.')).toBeVisible();
    await expect(page.getByText('Use a password of at least 10 characters.')).toBeVisible();
    await expect(page).toHaveURL(/\/sign-up$/);
  });

  test('a wrong code while turning on two-step verification shows in view', async ({ page }) => {
    test.setTimeout(60_000);
    await signUp(page, `${unique('owner')}@example.test`);
    await expect(page).toHaveURL(/\/onboarding\/business$/, { timeout: 20_000 });
    await hydrated(page.getByRole('button', { name: 'Create business' }));
    await pickBusinessType(page, 'Barbershop');
    await page.getByLabel('Business name').fill('Wrong Code Studio');
    await page.getByLabel('Booking link').fill(unique('shop'));
    await page.getByRole('button', { name: 'Create business' }).click();
    await expect(page).toHaveURL(/\/security\/two-factor$/, { timeout: 30_000 });
    await hydrated(page.getByRole('button', { name: 'Continue' }));
    await page.getByLabel('Confirm your password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('Enter the 6-digit code').fill('000000');
    await page.getByRole('button', { name: 'Turn on two-step verification' }).click();
    const error = page.getByText('That code didn’t work.', { exact: false });
    await expect(error).toBeInViewport({ ratio: 1 });
    // …and above the action bar fixed at the bottom of the screen.
    const box = await error.boundingBox();
    const bar = await page
      .getByRole('button', { name: 'Turn on two-step verification' })
      .boundingBox();
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThan(bar?.y ?? 0);
    await expect(page.getByLabel('Enter the 6-digit code')).toBeFocused();
  });

  test('the forms fit a phone screen', async ({ page }) => {
    for (const path of ['/sign-in', '/sign-up']) {
      await page.goto(path);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBe(0);
    }
  });
});

// S44 (ADR-0045): the account emails, read from Mailpit, through the real stack.
test.describe('business type at signup (S45, ADR-0046)', () => {
  test('AC-W1-7: a barbershop is bookable with nothing typed but its name', async ({
    page,
    browser,
    baseURL,
  }) => {
    test.setTimeout(90_000);
    await signUp(page, `${unique('owner')}@example.test`, { name: 'Marcus Reed' });
    await expect(page).toHaveURL(/\/onboarding\/business$/, { timeout: 20_000 });
    await hydrated(page.getByRole('button', { name: 'Create business' }));
    await pickBusinessType(page, 'Barbershop');
    await page.getByLabel('Business name').fill(`Fade Room ${String(Date.now())}`);
    const slug = await page.getByLabel('Booking link').inputValue();
    await page.getByRole('button', { name: 'Create business' }).click();
    await expect(page).toHaveURL(/\/security\/two-factor$/, { timeout: 30_000 });

    // The booking page offers the template's menu, with the owner, at the template's hours.
    const client = await anotherPerson(browser, baseURL);
    await client.goto(`/book/${slug}`);
    await expect(client.getByRole('heading', { name: 'Book a visit' })).toBeVisible();
    await expect(client.getByRole('button', { name: /Skin fade/ })).toBeVisible();
    await (await hydrated(client.getByRole('button', { name: /^Haircut(?! and)/ }))).click();
    await client.getByRole('button', { name: /Marcus Reed/ }).click();
    await expect(client.getByRole('heading', { name: 'Pick a time' })).toBeVisible();
    // Days open on the template's hours (Tuesday to Saturday): one of the next four days has
    // times. Each day's answer is waited for (times, or "Nothing free that day").
    const days = client.getByRole('group', { name: 'Day' }).getByRole('button');
    const times = client.getByTestId('free-times').getByRole('button');
    const answered = times.first().or(client.getByText('Nothing free that day. Try another day.'));
    let offered = 0;
    for (let day = 0; day < 4 && offered === 0; day += 1) {
      await days.nth(day).click();
      await expect(answered).toBeVisible({ timeout: 15_000 });
      offered = await times.count();
    }
    expect(offered).toBeGreaterThan(0);
  });

  test('AC-W1-8, AC-W1-9: the four types first, the error under the picker, US zones first', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await signUp(page, `${unique('owner')}@example.test`);
    await expect(page).toHaveURL(/\/onboarding\/business$/, { timeout: 20_000 });
    const create = await hydrated(page.getByRole('button', { name: 'Create business' }));
    const types = page.getByRole('radiogroup', { name: 'Type of business' });
    for (const name of ['Hair salon', 'Barbershop', 'Nail salon', 'Lash & brow studio']) {
      await expect(types.getByRole('radio', { name: new RegExp(`^${name}`) })).toBeVisible();
    }
    await expect(types.getByRole('radio', { name: /^Day spa/ })).toBeHidden();
    await page.getByRole('button', { name: 'More types' }).click();
    await expect(types.getByRole('radio', { name: /^Day spa/ })).toBeVisible();

    await page.getByLabel('Business name').fill('No Type Yet');
    await create.click();
    await expect(types).toHaveAccessibleDescription(/Pick your type of business\./);
    await expect(types.getByRole('radio').first()).toBeFocused();
    await expect(page).toHaveURL(/\/onboarding\/business$/);

    const zones = page.getByLabel('Time zone').locator('option');
    // Plain names with their city (S46, AC-W8-6); each option still stores the zone id.
    expect((await zones.allTextContents()).slice(0, 7)).toEqual([
      'Eastern Time (New York)',
      'Central Time (Chicago)',
      'Mountain Time (Denver)',
      'Arizona Time (Phoenix)',
      'Pacific Time (Los Angeles)',
      'Alaska Time (Anchorage)',
      'Hawaii Time (Honolulu)',
    ]);
    await expect(zones.nth(3)).toHaveAttribute('value', 'America/Phoenix');
    const browserZone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
    await expect(page.getByLabel('Time zone')).toHaveValue(browserZone);
  });
});

test.describe('account recovery and email', () => {
  test('AC-W1-5: a new account confirms its email; signing in first sends a new link', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const email = `${unique('lena')}@example.test`;
    await signUp(page, email, { name: 'Lena', confirm: false });
    await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText(email, { exact: true })).toBeVisible();
    await page.goto('/');
    await expect(page).toHaveURL(/\/sign-in$/);

    // Signing in before confirming: "Check your inbox" again, with a fresh link on its way.
    await enterPassword(page, email);
    await expect(page.getByText('Your email isn’t confirmed yet.', { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Send again in \d+ s$/ })).toBeDisabled();
    await expect.poll(async () => (await emailsTo(email)).length, { timeout: 15_000 }).toBe(2);

    await page.goto(await linkTo(email, 'Confirm your email for Pepper'));
    await expect(page).toHaveURL(/\/onboarding\/business$/, { timeout: 20_000 });
    // The link worked once to sign in; a run-out or broken one says how to get a new one.
    await page.goto('/email-confirmed?error=INVALID_TOKEN');
    await expect(page.getByRole('heading', { name: 'This link has run out' })).toBeVisible();
  });

  test('AC-W1-4: forgot password → link → new password; other devices are signed out', async ({
    page,
    browser,
    baseURL,
  }) => {
    test.setTimeout(120_000);
    const owner = await onboardOwner(page);
    const visitor = await anotherPerson(browser, baseURL);
    await visitor.goto('/sign-in');
    await (await hydrated(visitor.getByRole('link', { name: 'Forgot your password?' }))).click();
    await expect(visitor).toHaveURL(/\/forgot-password$/);
    await (await hydrated(visitor.getByRole('button', { name: 'Send me a link' }))).click();
    await expect(visitor.getByLabel('Email')).toBeFocused();
    await expect(visitor.getByLabel('Email')).toHaveAccessibleDescription(
      'Enter the email you sign in with.',
    );
    await visitor.getByLabel('Email').fill(owner.email);
    await visitor.getByRole('button', { name: 'Send me a link' }).click();
    await expect(visitor.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();

    const link = await linkTo(owner.email, 'Reset your Pepper password');
    await visitor.goto(link);
    await expect(visitor).toHaveURL(/\/reset-password\?token=/);
    await (await hydrated(visitor.getByRole('button', { name: 'Save new password' }))).click();
    await expect(visitor.getByLabel('New password')).toHaveAccessibleDescription(
      /Use a password of at least 10 characters/,
    );
    const newPassword = 'a brand new passphrase';
    await visitor.getByLabel('New password').fill(newPassword);
    await visitor.getByRole('button', { name: 'Save new password' }).click();
    await expect(visitor.getByRole('heading', { name: 'Password saved' })).toBeVisible();

    // The owner's phone was signed out by the reset.
    await page.goto('/');
    await expect(page).toHaveURL(/\/sign-in$/);
    await enterPassword(page, owner.email);
    await expect(
      page.getByRole('alert').filter({ hasText: 'That email and password don’t match.' }),
    ).toBeVisible();
    await enterPassword(page, owner.email, newPassword);
    await page.getByLabel('Code').fill(await freshCode(owner.secret, owner.usedCodes));
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page.getByTestId('business-name')).toHaveText(owner.business);

    // The link works once.
    await visitor.goto(link);
    await expect(visitor.getByRole('heading', { name: 'This link has run out' })).toBeVisible();
    await visitor.context().close();
  });

  test('AC-W1-6: change email from More; it counts once both addresses confirm', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const owner = await onboardOwner(page);
    await page.goto('/more');
    await page.getByRole('link', { name: 'Change email' }).click();
    await expect(page).toHaveURL(/\/account\/email$/);
    await (await hydrated(page.getByRole('button', { name: 'Send the link' }))).click();
    await expect(page.getByLabel('New email')).toBeFocused();
    await page.getByLabel('New email').fill(owner.email.toUpperCase());
    await page.getByRole('button', { name: 'Send the link' }).click();
    await expect(page.getByLabel('New email')).toHaveAccessibleDescription(
      'That’s already your email. Enter a different one.',
    );

    const newEmail = `${unique('ana.new')}@example.test`;
    await page.getByLabel('New email').fill(newEmail);
    await page.getByRole('button', { name: 'Send the link' }).click();
    await expect(page.getByRole('heading', { name: 'Confirm it’s you' })).toBeVisible();

    // The current address confirms first; then one more link goes to the new one.
    await page.goto(await linkTo(owner.email, 'Confirm the change of your Pepper email'));
    await expect(page.getByRole('heading', { name: 'One more step' })).toBeVisible();
    await page.goto('/more');
    await expect(page.getByText(owner.email, { exact: true })).toBeVisible();

    await page.goto(await linkTo(newEmail, 'Confirm your new email for Pepper'));
    await expect(page.getByRole('heading', { name: 'Your email is changed' })).toBeVisible();
    await expect(page.getByText(newEmail, { exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Done' }).click();
    await expect(page.getByText(newEmail, { exact: true })).toBeVisible();
  });

  test('the new account screens fit a phone screen', async ({ page }) => {
    for (const path of ['/forgot-password', '/reset-password?token=t', '/reset-password']) {
      await page.goto(path);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBe(0);
    }
  });
});
