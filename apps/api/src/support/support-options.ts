import type { Clock } from '@pepper/core';

// Support's settings, shared by the members' routes and the console (S59, S59.2).

export interface SupportModuleOptions {
  outboxKey: Buffer;
  /** `SUPPORT_EMAIL`; `null`: requests are kept, nothing is emailed. */
  supportEmail: string | null;
  baseUrl: string;
  release: string;
  /** `INBOUND_EMAIL_DOMAIN` (S59.3): emails to members carry the signed reply address. */
  inboundDomain?: string | null;
  clock?: Clock;
}

export const SUPPORT_OPTIONS = Symbol('SUPPORT_OPTIONS');
