import { SupportScreenshotSizeSchema } from '@pepper/contracts';
import { z } from 'zod';

/** A screenshot's route (S59.2.3): a malformed id is "not found", as another business's. */
export const ScreenshotParamsSchema = z.object({ screenshotId: z.string().max(100) });
export const ScreenshotQuerySchema = z.object({
  size: SupportScreenshotSizeSchema.default('full'),
});
