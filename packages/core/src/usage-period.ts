import { UsagePeriodSchema, type UsagePeriod } from '@floty/contracts';

/** The metering period (UTC calendar month) an instant falls in. */
export function usagePeriodOf(instant: Date): UsagePeriod {
  if (Number.isNaN(instant.getTime())) throw new RangeError('Invalid date');
  const month = String(instant.getUTCMonth() + 1).padStart(2, '0');
  return UsagePeriodSchema.parse(`${String(instant.getUTCFullYear())}-${month}`);
}
