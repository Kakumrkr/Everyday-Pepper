import { StaffMemberInputSchema, type Template, type UserId } from '@pepper/contracts';
import type { BusinessSeed } from '@pepper/appointments';

/** The name the owner's staff entry gets when their account has none usable. */
export const OWNER_FALLBACK_NAME = 'Owner';

const DISPLAY_NAME_MAX = StaffMemberInputSchema.shape.displayName.maxLength ?? 80;

/**
 * A new business's first week from its type (S45, ADR-0046): the template's whole starting
 * menu, the owner as the one staff member offering it, and the template's opening hours. A
 * catalog range whose "to" equals its "from" is one price (services need "to" above "from").
 */
export function seedFromTemplate(
  template: Template,
  owner: { userId: UserId; name: string },
): BusinessSeed {
  return {
    services: template.serviceCatalog.map((entry) => ({
      service: {
        name: entry.name,
        category: entry.category,
        durationMinutes: entry.durationMinutes,
        bufferBeforeMinutes: entry.bufferBeforeMinutes,
        bufferAfterMinutes: entry.bufferAfterMinutes,
        priceFromCents: entry.priceFromCents,
        priceToCents:
          entry.priceToCents !== null && entry.priceToCents > entry.priceFromCents
            ? entry.priceToCents
            : null,
      },
      rebookAfterDays: entry.rebookAfterDays,
    })),
    owner: { userId: owner.userId, displayName: displayNameOf(owner.name) },
    hours: template.defaultHours,
  };
}

function displayNameOf(name: string): string {
  const trimmed = name.trim().slice(0, DISPLAY_NAME_MAX).trim();
  return trimmed === '' ? OWNER_FALLBACK_NAME : trimmed;
}
