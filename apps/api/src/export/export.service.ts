import { systemClock, type Clock, type TenantContext } from '@pepper/core';
import type { Database } from '@pepper/db';
import { exportBusiness, type BusinessExport } from '@pepper/imports';
import { currentRequestContext, DATABASE } from '@pepper/runtime';
import { Inject, Injectable, Optional } from '@nestjs/common';

/** The clock an export is dated by (tests replace it). */
export const EXPORT_CLOCK = Symbol('EXPORT_CLOCK');

/**
 * The business export for a request (S51, ADR-0053): binds the database, the clock and the
 * request id (for the audit log). Domain errors pass through; the controller answers them.
 */
@Injectable()
export class ExportService {
  private readonly db: Database;
  private readonly clock: Clock;

  constructor(
    @Inject(DATABASE) database: { db: Database },
    @Optional() @Inject(EXPORT_CLOCK) clock?: Clock,
  ) {
    this.db = database.db;
    this.clock = clock ?? systemClock;
  }

  export(tenant: TenantContext): Promise<BusinessExport> {
    return exportBusiness(
      this.db,
      { context: tenant, requestId: currentRequestContext()?.requestId },
      this.clock,
    );
  }
}
