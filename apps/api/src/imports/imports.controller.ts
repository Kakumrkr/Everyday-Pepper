import {
  ImportBatchIdSchema,
  ImportMappingInputSchema,
  ImportUploadQuerySchema,
  MAX_IMPORT_BYTES,
  type ImportBatch,
  type ImportBatchId,
  type ImportPreview,
} from '@pepper/contracts';
import type { TenantContext } from '@pepper/core';
import { ImportNotFoundError } from '@pepper/imports';
import type { IncomingMessage } from 'node:http';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { CurrentTenant, RequirePermission, TenantGuard } from '../auth/guards.js';
import { answering, toHttpError } from '../http/domain-errors.js';
import { RateLimiter, type RateLimit } from '../http/rate-limit.js';
import { IMPORT_UPLOAD, readUpload } from '../http/raw-body.js';
import { parseBody } from '../http/zod-body.js';
import { ImportsService } from './imports.service.js';

// An owner uploads a few files while getting a mapping right; a script is stopped.
const UPLOADS: RateLimit = { name: 'client-import', max: 20, windowSeconds: 600 };

const ImportParamsSchema = z.object({ importId: z.string() });

/**
 * Client import, `/v1/imports` (S48, ADR-0049, AC-W1-3, AC-W1-17…19): owners and managers
 * (`clients.manage`). An upload is the file itself as the body (at most 5 MB; CSV and JSONL as
 * text, JSON as `application/octet-stream`), staged with a suggested mapping and a preview;
 * nothing reaches the clients until it is committed.
 */
@Controller('v1/imports')
@UseGuards(TenantGuard)
@RequirePermission('clients.manage')
export class ImportsController {
  constructor(
    private readonly imports: ImportsService,
    private readonly limits: RateLimiter,
  ) {}

  /** The latest imports, newest first. */
  @Get()
  list(@CurrentTenant() tenant: TenantContext): Promise<ImportBatch[]> {
    return answering(() => this.imports.list(tenant));
  }

  /**
   * 201 the staged import with its preview. 413 `import_too_large`; 415/422 `import_rejected`
   * with what to fix; 429 `too_many_requests`.
   */
  @Post()
  async stage(
    @CurrentTenant() tenant: TenantContext,
    @Query() query: unknown,
    @Req() request: IncomingMessage,
  ): Promise<ImportPreview> {
    const { format } = parseBody(ImportUploadQuerySchema, query);
    await this.limits.hit(UPLOADS, tenant.userId);
    const bytes = await readUpload(request, MAX_IMPORT_BYTES, IMPORT_UPLOAD);
    return answering(() => this.imports.stage(tenant, bytes, format));
  }

  /** 200 the import with its preview rows; 404 `import_not_found`. */
  @Get(':importId')
  get(@CurrentTenant() tenant: TenantContext, @Param() params: unknown): Promise<ImportPreview> {
    return answering(() => this.imports.get(tenant, importIdOf(params)));
  }

  /** 200 the preview under the new mapping; 409 `import_not_staged`; 422 `import_mapping_invalid`. */
  @Put(':importId/mapping')
  remap(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: unknown,
    @Body() body: unknown,
  ): Promise<ImportPreview> {
    const id = importIdOf(params);
    const input = parseBody(ImportMappingInputSchema, body);
    return answering(() => this.imports.remap(tenant, id, input));
  }

  /** 202 the queued import; 409 `import_not_staged` or `import_not_ready` (with why). */
  @Post(':importId/commit')
  @HttpCode(202)
  commit(@CurrentTenant() tenant: TenantContext, @Param() params: unknown): Promise<ImportBatch> {
    return answering(() => this.imports.commit(tenant, importIdOf(params)));
  }

  /** 200 the undone import with what it did; 409 `import_not_undoable` (with why). */
  @Post(':importId/undo')
  @HttpCode(200)
  undo(@CurrentTenant() tenant: TenantContext, @Param() params: unknown): Promise<ImportBatch> {
    return answering(() => this.imports.undo(tenant, importIdOf(params)));
  }

  /** 204: a staged import discarded; 409 `import_not_staged`. */
  @Delete(':importId')
  @HttpCode(204)
  async discard(@CurrentTenant() tenant: TenantContext, @Param() params: unknown): Promise<void> {
    await answering(() => this.imports.discard(tenant, importIdOf(params)));
  }
}

/** A malformed id is "not found", like an id of another business. */
function importIdOf(params: unknown): ImportBatchId {
  const { importId } = parseBody(ImportParamsSchema, params);
  const parsed = ImportBatchIdSchema.safeParse(importId);
  if (!parsed.success) throw toHttpError(new ImportNotFoundError());
  return parsed.data;
}
