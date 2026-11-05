import { ProofResponseSchema, type ProofResponse } from '@pepper/contracts';
import { readProofIn } from '@pepper/appointments';
import type { TenantContext } from '@pepper/core';
import { withTenant, type Database } from '@pepper/db';
import { currentRequestContext, DATABASE } from '@pepper/runtime';
import { Controller, Get, Inject, Injectable, UseGuards } from '@nestjs/common';
import { CurrentTenant, RequirePermission, TenantGuard } from '../auth/guards.js';
import { answering } from '../http/domain-errors.js';

/** The proof-of-value read for a request (S55, ADR-0058). */
@Injectable()
export class ProofService {
  private readonly db: Database;

  constructor(@Inject(DATABASE) database: { db: Database }) {
    this.db = database.db;
  }

  get(tenant: TenantContext): Promise<ProofResponse> {
    return withTenant(this.db, tenant.tenantId, (tx) =>
      readProofIn(tx, { context: tenant, requestId: currentRequestContext()?.requestId }),
    );
  }
}

/**
 * Proof of value, `/v1/proof` (S55, ADR-0058; AC-W4-10…13): what Pepper did in the last 7
 * days and, from the evening hour, tomorrow. Owners and managers only (403 `forbidden` for
 * staff, from the domain: the dollars and the at-risk names are the business's).
 */
@Controller('v1/proof')
@UseGuards(TenantGuard)
export class ProofController {
  constructor(private readonly proof: ProofService) {}

  @Get()
  @RequirePermission('feed.read')
  async get(@CurrentTenant() tenant: TenantContext): Promise<ProofResponse> {
    return ProofResponseSchema.parse(await answering(() => this.proof.get(tenant)));
  }
}
