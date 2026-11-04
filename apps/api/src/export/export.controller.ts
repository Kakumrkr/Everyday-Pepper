import type { TenantContext } from '@pepper/core';
import { Controller, Get, Header, StreamableFile, UseGuards } from '@nestjs/common';
import { CurrentTenant, RequirePermission, TenantGuard } from '../auth/guards.js';
import { answering } from '../http/domain-errors.js';
import { RateLimiter, type RateLimit } from '../http/rate-limit.js';
import { ExportService } from './export.service.js';

// Each export reads the whole business: a few an hour are plenty, a loop is stopped.
const EXPORTS: RateLimit = { name: 'business-export', max: 10, windowSeconds: 3600 };

/**
 * The business export, `GET /v1/tenant/export` (S51, ADR-0053, AC-W1-37): the owner only
 * (`business.export`). 200 a ZIP as an attachment, never cached; 403 `forbidden` for managers
 * and staff; 429 `too_many_requests`.
 */
@Controller('v1/tenant/export')
@UseGuards(TenantGuard)
@RequirePermission('business.export')
export class ExportController {
  constructor(
    private readonly exports: ExportService,
    private readonly limits: RateLimiter,
  ) {}

  @Get()
  @Header('cache-control', 'no-store')
  @Header('x-content-type-options', 'nosniff')
  async download(@CurrentTenant() tenant: TenantContext): Promise<StreamableFile> {
    // Per business and person: an owner of several businesses exports each.
    await this.limits.hit(EXPORTS, `${tenant.tenantId}:${tenant.userId}`);
    const built = await answering(() => this.exports.export(tenant));
    return new StreamableFile(built.bytes, {
      type: 'application/zip',
      // The name is the slug and a date only: ASCII, nothing to escape.
      disposition: `attachment; filename="${built.fileName}"`,
      length: built.bytes.byteLength,
    });
  }
}
