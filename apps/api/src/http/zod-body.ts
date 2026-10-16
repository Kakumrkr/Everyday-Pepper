import { BadRequestException } from '@nestjs/common';
import type { z } from 'zod';
import { apiError } from '../auth/guards.js';

/**
 * Validates a request body with a contracts schema; 400 `validation_failed` naming the invalid
 * fields (never echoing their values) otherwise.
 */
export function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  const fields = [...new Set(result.error.issues.map((issue) => issue.path.join('.') || '(body)'))];
  throw new BadRequestException({ ...apiError('validation_failed'), fields });
}
