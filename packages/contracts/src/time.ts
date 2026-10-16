import { z } from 'zod';

/**
 * An instant serialised as ISO 8601 in UTC with a trailing `Z`, e.g. `2026-10-15T14:30:00.000Z`.
 * Times are stored and exchanged in UTC and rendered in the tenant's time zone (CLAUDE.md).
 */
export const UtcDateTimeSchema = z.iso.datetime({ offset: false }).brand<'UtcDateTime'>();
export type UtcDateTime = z.infer<typeof UtcDateTimeSchema>;
