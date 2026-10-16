import { z } from 'zod';
import { UtcDateTimeSchema } from './time.js';

/** Services that report health. */
export const ServiceNameSchema = z.enum(['api', 'worker', 'web']);
export type ServiceName = z.infer<typeof ServiceNameSchema>;

/** Result of one dependency check (database, redis, ...). Details stay in the server logs. */
export const HealthCheckStatusSchema = z.enum(['up', 'down']);
export type HealthCheckStatus = z.infer<typeof HealthCheckStatusSchema>;

/**
 * Body of `GET /health/live` and `GET /health/ready`.
 * `status` is `ok` only when every check is `up`; readiness then answers 200, otherwise 503.
 */
export const HealthReportSchema = z
  .object({
    service: ServiceNameSchema,
    status: z.enum(['ok', 'unavailable']),
    checks: z.record(z.string().min(1), HealthCheckStatusSchema),
    checkedAt: UtcDateTimeSchema,
  })
  .strict();
export type HealthReport = z.infer<typeof HealthReportSchema>;
