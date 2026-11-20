import { randomUUID } from 'node:crypto';
import {
  StripeAccountLinkSchema,
  StripeAccountSchema,
  StripeErrorSchema,
  StripeLoginLinkSchema,
  type StripeAccount,
  type StripeAccountId,
} from '@pepper/contracts';
import type { z } from 'zod';
import {
  isRetryableStatus,
  PaymentsProviderError,
  type CreateAccountInput,
  type OnboardingLinkInput,
  type PaymentsProvider,
  type ProviderLink,
} from './provider.js';

// `PaymentsProvider` on Stripe's API (S65, ADR-0067 §2–4), without the SDK: form-encoded calls,
// Basic auth with the key, one pinned API version, a timeout, an `Idempotency-Key` on every
// POST, and every answer validated. Coded from Stripe's documentation (read 2026-11-20) and
// tested on fixtures in its documented shapes (src/fixtures); S66 confirms it in test mode.
// Answers are never logged: they echo the business's details.

const STRIPE_API = 'https://api.stripe.com';
/** Bumped on purpose only, with the fixtures read again (ADR-0067 §2). */
export const STRIPE_API_VERSION = '2026-11-18.endive';
const TIMEOUT_MS = 15_000;

export interface StripeOptions {
  /** `sk_test_…`, `sk_live_…` or a restricted `rk_…` key. A secret; never logged. */
  secretKey: string;
  /** Tests give their own; production uses the global `fetch`. */
  fetch?: typeof fetch;
}

export class StripePaymentsProvider implements PaymentsProvider {
  readonly provider = 'stripe' as const;
  readonly livemode: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly authorization: string;

  constructor(options: StripeOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.authorization = `Basic ${Buffer.from(`${options.secretKey}:`).toString('base64')}`;
    this.livemode = /^(sk|rk)_live_/.test(options.secretKey);
  }

  /** An Express account (ADR-0067 §3): Stripe collects and verifies everything on its pages. */
  createAccount(input: CreateAccountInput): Promise<StripeAccount> {
    return this.call(StripeAccountSchema, 'POST', '/v1/accounts', {
      form: {
        country: 'US',
        'controller[stripe_dashboard][type]': 'express',
        'controller[fees][payer]': 'application',
        'controller[losses][payments]': 'application',
        'controller[requirement_collection]': 'stripe',
        'capabilities[card_payments][requested]': 'true',
        'capabilities[transfers][requested]': 'true',
        // For reconciliation only: an event's business is found through the stored id (§6.4).
        'metadata[pepper_tenant]': input.tenantId,
      },
      idempotencyKey: input.idempotencyKey,
    });
  }

  retrieveAccount(accountId: StripeAccountId): Promise<StripeAccount> {
    return this.call(StripeAccountSchema, 'GET', `/v1/accounts/${encodeURIComponent(accountId)}`);
  }

  async createOnboardingLink(input: OnboardingLinkInput): Promise<ProviderLink> {
    const link = await this.call(StripeAccountLinkSchema, 'POST', '/v1/account_links', {
      form: {
        account: input.accountId,
        type: 'account_onboarding',
        refresh_url: input.refreshUrl,
        return_url: input.returnUrl,
        // Everything Stripe will need, in one go, so the owner isn't asked back next month.
        'collection_options[fields]': 'eventually_due',
      },
    });
    return { url: link.url, expiresAt: new Date(link.expires_at * 1000) };
  }

  async createDashboardLink(accountId: StripeAccountId): Promise<ProviderLink> {
    const link = await this.call(
      StripeLoginLinkSchema,
      'POST',
      `/v1/accounts/${encodeURIComponent(accountId)}/login_links`,
      { form: {} },
    );
    return { url: link.url, expiresAt: null };
  }

  private async call<T extends z.ZodType>(
    schema: T,
    method: 'GET' | 'POST',
    path: string,
    body?: { form: Record<string, string>; idempotencyKey?: string },
  ): Promise<z.infer<T>> {
    const headers: Record<string, string> = {
      Authorization: this.authorization,
      'Stripe-Version': STRIPE_API_VERSION,
      Accept: 'application/json',
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      // A retry of the same call (ours or the network's) can't do it twice.
      headers['Idempotency-Key'] = body.idempotencyKey ?? `pepper-${randomUUID()}`;
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`${STRIPE_API}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: new URLSearchParams(body.form).toString() }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      // A timeout or the network: no answer to read.
      throw new PaymentsProviderError(null, null, null, true);
    }
    const json: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = StripeErrorSchema.safeParse(json);
      throw new PaymentsProviderError(
        response.status,
        error.success ? error.data.error.type : null,
        error.success ? (error.data.error.code ?? null) : null,
        isRetryableStatus(response.status),
      );
    }
    const parsed = schema.safeParse(json);
    // Stripe answered something we can't read: not worth an immediate retry, but not lost
    // either (the webhook's 500 makes Stripe deliver again).
    if (!parsed.success)
      throw new PaymentsProviderError(response.status, 'invalid_answer', null, true);
    return parsed.data;
  }
}
