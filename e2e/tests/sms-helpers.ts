import { randomInt } from 'node:crypto';
import {
  SandboxInboundSmsResponseSchema,
  SandboxSentSmsResponseSchema,
  type SandboxSentSmsResponse,
} from '@pepper/contracts';
import { expect, type Page } from '@playwright/test';
import { hydrated, toast } from './helpers.js';

// Texts through the sandbox (S63.2, AC-X-87): what Pepper sent to a number, and a text to
// Pepper from one, the way the provider's webhook would hand it in. Only a CI or development
// deployment with `SMS_PROVIDER=sandbox` has these routes.

/** A US number no other run uses (the "Y" lookup goes by number, across businesses). */
export function newPhone(): string {
  return `+1555${String(randomInt(1_000_000, 10_000_000))}`;
}

/** `+15551234567` as people type it: `(555) 123-4567`. */
export function typed(phone: string): string {
  return `(${phone.slice(2, 5)}) ${phone.slice(5, 8)}-${phone.slice(8)}`;
}

/** The texts sent to `phone`, the newest first. */
export async function sentTexts(
  page: Page,
  phone: string,
): Promise<SandboxSentSmsResponse['texts']> {
  const response = await page.request.get(`/v1/dev/sms/sent?to=${encodeURIComponent(phone)}`);
  expect(response.status(), await response.text()).toBe(200);
  return SandboxSentSmsResponseSchema.parse(await response.json()).texts;
}

/** Waits for a text to `phone` matching `pattern` (the worker sends within its poll); its body. */
export async function textTo(
  page: Page,
  phone: string,
  pattern: RegExp,
  timeout = 120_000,
): Promise<string> {
  let body = '';
  await expect
    .poll(
      async () => {
        body = (await sentTexts(page, phone)).find((text) => pattern.test(text.body))?.body ?? '';
        return body;
      },
      { timeout, intervals: [1_000, 2_000, 5_000] },
    )
    .not.toBe('');
  return body;
}

/** A text from `from` to Pepper's number; Pepper's reply (`null`: none). */
export async function textIn(page: Page, from: string, body: string): Promise<string | null> {
  const response = await page.request.post('/v1/dev/sms/inbound', { data: { from, body } });
  expect(response.status(), await response.text()).toBe(200);
  return SandboxInboundSmsResponseSchema.parse(await response.json()).reply;
}

/**
 * A time zone where it is now between 9:00 and 14:00, so a text goes now rather than after the
 * quiet hours (8:00–20:00) and a visit an hour or so away still fits the day's hours (9–17).
 * The zones are at most three hours apart, so one always is.
 */
export function daytimeZone(): string {
  const zones = [
    'Pacific/Honolulu',
    'America/Los_Angeles',
    'America/New_York',
    'America/Sao_Paulo',
    'Europe/London',
    'Europe/Athens',
    'Asia/Dubai',
    'Asia/Kolkata',
    'Asia/Bangkok',
    'Asia/Tokyo',
    'Australia/Sydney',
    'Pacific/Auckland',
  ];
  const hourIn = (timeZone: string) =>
    Number(
      new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(
        new Date(),
      ),
    );
  const zone = zones.find((candidate) => hourIn(candidate) >= 9 && hourIn(candidate) < 14);
  if (zone === undefined) throw new Error('No zone in its daytime');
  return zone;
}

/**
 * On Texts and reminders: checks `phone` as the member's number with the code the sandbox
 * texted (AC-X-88), then turns "Text me cards" on (AC-X-89).
 */
export async function checkNumberAndTextCards(page: Page, phone: string): Promise<void> {
  await page.goto('/more/texts');
  const cards = page.getByTestId('card-texts');
  await (
    await hydrated(cards.getByRole('button', { name: /Add your number|Change number/ }))
  ).click();
  const sheet = page.getByRole('dialog', { name: 'Your mobile number' });
  await sheet.getByLabel('Mobile number').fill(typed(phone));
  await sheet.getByRole('button', { name: 'Text me a code' }).click();
  const dialog = page.getByRole('dialog', { name: 'Type the code' });
  await expect(dialog).toContainText(`I texted a code to ${typed(phone)}.`);
  const code =
    /your code is (\d{6})\./.exec(await textTo(page, phone, /your code is \d{6}/))?.[1] ?? '';
  await dialog.getByLabel('6-digit code').fill(code);
  await dialog.getByRole('button', { name: 'Check the code' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(cards.getByTestId('my-number')).toHaveText(typed(phone));
  await cards.getByRole('switch', { name: 'Text me cards' }).click();
  await expect(toast(page).last()).toContainText('Saved. I’ll text you cards that need your OK.');
}
