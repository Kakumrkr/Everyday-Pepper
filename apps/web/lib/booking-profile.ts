import {
  BusinessPhoneSchema,
  CancellationPolicySchema,
  PublicAddressSchema,
  type BusinessProfile,
} from '@pepper/contracts';
import type { z } from 'zod';

// The booking page's profile (S47, AC-W8-7): what the owner's form sends, and how the page
// shows the phone. The api checks the same schemas; checking here first names the field.

/** The profile form's fields as typed; an empty one means "don't show it". */
export type ProfileFields = Record<keyof BusinessProfile, string>;

/** The fields to fill the form with (`null`: empty). */
export function profileFields(profile: BusinessProfile): ProfileFields {
  return {
    phone: profile.phone === null ? '' : formatPhone(profile.phone),
    publicAddress: profile.publicAddress ?? '',
    cancellationPolicy: profile.cancellationPolicy ?? '',
  };
}

const SCHEMAS: Record<keyof BusinessProfile, z.ZodType<string, string>> = {
  phone: BusinessPhoneSchema,
  publicAddress: PublicAddressSchema,
  cancellationPolicy: CancellationPolicySchema,
};

/**
 * The form's fields as the `PUT /v1/tenant/booking-page` body: each in its stored form, or
 * `null` when left empty; or, when one is not right, what to fix under each such field.
 */
export function profileFromFields(
  fields: ProfileFields,
):
  | { ok: true; profile: BusinessProfile }
  | { ok: false; errors: Partial<Record<keyof BusinessProfile, string>> } {
  const profile: Partial<BusinessProfile> = {};
  const errors: Partial<Record<keyof BusinessProfile, string>> = {};
  for (const key of Object.keys(SCHEMAS) as (keyof BusinessProfile)[]) {
    const typed = fields[key];
    if (typed.trim() === '') {
      profile[key] = null;
      continue;
    }
    const parsed = SCHEMAS[key].safeParse(typed);
    if (parsed.success) profile[key] = parsed.data;
    else errors[key] = parsed.error.issues[0]?.message ?? 'Check this field';
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, profile: profile as BusinessProfile };
}

/** A phone as clients read it: `(555) 123-4567` for a US number, else as stored. */
export function formatPhone(phone: string): string {
  const us = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(phone);
  if (us === null) return phone;
  const [, area, exchange, line] = us;
  return `(${area ?? ''}) ${exchange ?? ''}-${line ?? ''}`;
}
