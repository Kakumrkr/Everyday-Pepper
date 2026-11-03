import type {
  ImportBatch,
  ImportBatchId,
  ImportFormat,
  ImportMappingInput,
  ImportPreview,
} from '@pepper/contracts';
import { systemClock, type Actor, type Clock, type TenantContext } from '@pepper/core';
import type { Database } from '@pepper/db';
import {
  commitImport,
  discardImport,
  getImport,
  listImports,
  remapImport,
  stageImport,
  undoImport,
} from '@pepper/imports';
import { currentRequestContext, DATABASE } from '@pepper/runtime';
import { Inject, Injectable, Optional } from '@nestjs/common';

/** The clock imports are committed and undone by (tests replace it). */
export const IMPORTS_CLOCK = Symbol('IMPORTS_CLOCK');

/**
 * The client import services for a request (S48, ADR-0049): binds the database, the clock and
 * the request id (for the audit log). Domain errors pass through; the controller answers them.
 */
@Injectable()
export class ImportsService {
  private readonly db: Database;
  private readonly clock: Clock;

  constructor(
    @Inject(DATABASE) database: { db: Database },
    @Optional() @Inject(IMPORTS_CLOCK) clock?: Clock,
  ) {
    this.db = database.db;
    this.clock = clock ?? systemClock;
  }

  list(tenant: TenantContext): Promise<ImportBatch[]> {
    return listImports(this.db, actorOf(tenant));
  }

  stage(tenant: TenantContext, bytes: Uint8Array, format: ImportFormat | undefined) {
    return stageImport(this.db, actorOf(tenant), bytes, { format });
  }

  get(tenant: TenantContext, id: ImportBatchId): Promise<ImportPreview> {
    return getImport(this.db, actorOf(tenant), id);
  }

  remap(tenant: TenantContext, id: ImportBatchId, input: ImportMappingInput) {
    return remapImport(this.db, actorOf(tenant), id, input);
  }

  commit(tenant: TenantContext, id: ImportBatchId): Promise<ImportBatch> {
    return commitImport(this.db, actorOf(tenant), id, this.clock);
  }

  undo(tenant: TenantContext, id: ImportBatchId): Promise<ImportBatch> {
    return undoImport(this.db, actorOf(tenant), id, this.clock);
  }

  discard(tenant: TenantContext, id: ImportBatchId): Promise<void> {
    return discardImport(this.db, actorOf(tenant), id);
  }
}

function actorOf(context: TenantContext): Actor {
  return { context, requestId: currentRequestContext()?.requestId };
}
