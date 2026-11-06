import {
  ImportBatchIdSchema,
  ImportSuggestionsResultSchema,
  type ImportBatchId,
  type ImportSuggestionsResult,
} from '@pepper/contracts';
import { getImport, ImportNotFoundError } from '@pepper/imports';
import { LlmError, suggestImportColumns, type LlmProvider } from '@pepper/ai';
import { llmTokenLimits, reserveLlmTokens, type Clock, type TenantContext } from '@pepper/core';
import type { Database } from '@pepper/db';
import { DATABASE } from '@pepper/runtime';
import {
  Controller,
  HttpCode,
  Inject,
  Injectable,
  Logger,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { CurrentTenant, RequirePermission, TenantGuard } from '../auth/guards.js';
import { answering, toHttpError } from '../http/domain-errors.js';
import { RateLimiter, type RateLimit } from '../http/rate-limit.js';
import { parseBody } from '../http/zod-body.js';
import {
  actorOf,
  CHAT_CLOCK,
  CHAT_OPTIONS,
  LLM_PROVIDER,
  type ChatOptions,
} from './chat.service.js';

// The screen asks once per file; a script asking over and over is stopped.
const SUGGESTIONS: RateLimit = { name: 'import-suggestions', max: 10, windowSeconds: 600 };

const ImportParamsSchema = z.object({ importId: z.string() });

/** The import mapping suggester for a request: the chat's model, metered by the business. */
@Injectable()
export class ImportSuggestionsService {
  private readonly db: Database;
  private readonly logger = new Logger(ImportSuggestionsService.name);

  constructor(
    @Inject(DATABASE) database: { db: Database },
    @Inject(LLM_PROVIDER) private readonly provider: LlmProvider | null,
    @Inject(CHAT_OPTIONS) private readonly options: ChatOptions,
    @Inject(CHAT_CLOCK) private readonly clock: Clock,
  ) {
    this.db = database.db;
  }

  async suggest(tenant: TenantContext, id: ImportBatchId): Promise<ImportSuggestionsResult> {
    const actor = actorOf(tenant);
    if (this.provider === null) {
      return { outcome: 'ai_off', preview: await getImport(this.db, actor, id) };
    }
    const limits = llmTokenLimits(this.options.monthlyTokens);
    try {
      return await suggestImportColumns(
        {
          db: this.db,
          provider: this.provider,
          reserve: (tenantId, estimate) =>
            reserveLlmTokens(this.db, tenantId, { estimate, limits }, this.clock),
        },
        actor,
        id,
      );
    } catch (error) {
      if (!(error instanceof LlmError)) throw error;
      // The screen works without suggestions; the columns stay unasked for a later try.
      this.logger.warn(`import suggestions: the model failed (${error.code})`);
      return { outcome: 'unavailable', preview: await getImport(this.db, actor, id) };
    }
  }
}

/**
 * `POST /v1/imports/:importId/suggestions` (S56a.2, ADR-0061, AC-W1-46/47): owners and
 * managers (`clients.manage`). Asks the AI about the staged import's unplaced columns (their
 * names and masked samples only) and stores its checked suggestions; nothing is mapped. 200
 * `{ outcome, preview }` (the AI being off or out of budget is an outcome, not an error);
 * 404 `import_not_found`; 409 `import_not_staged`; 429 `too_many_requests`.
 */
@Controller('v1/imports')
@UseGuards(TenantGuard)
@RequirePermission('clients.manage')
export class ImportSuggestionsController {
  constructor(
    private readonly suggestions: ImportSuggestionsService,
    private readonly limits: RateLimiter,
  ) {}

  @Post(':importId/suggestions')
  @HttpCode(200)
  async suggest(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: unknown,
  ): Promise<ImportSuggestionsResult> {
    const id = importIdOf(params);
    await this.limits.hit(SUGGESTIONS, tenant.userId);
    return ImportSuggestionsResultSchema.parse(
      await answering(() => this.suggestions.suggest(tenant, id)),
    );
  }
}

/** A malformed id is "not found", like an id of another business. */
function importIdOf(params: unknown): ImportBatchId {
  const { importId } = parseBody(ImportParamsSchema, params);
  const parsed = ImportBatchIdSchema.safeParse(importId);
  if (!parsed.success) throw toHttpError(new ImportNotFoundError());
  return parsed.data;
}
