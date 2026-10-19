import {
  ClientIdSchema,
  ClientInputSchema,
  ClientLookupSchema,
  ClientsQuerySchema,
  type Client,
  type ClientsResponse,
} from '@pepper/contracts';
import type { TenantContext } from '@pepper/core';
import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { CurrentTenant, RequirePermission, TenantGuard } from '../auth/guards.js';
import { answering } from '../http/domain-errors.js';
import { parseBody } from '../http/zod-body.js';
import { ClientsService } from './clients.service.js';

const ClientParamsSchema = z.object({ clientId: ClientIdSchema });

/**
 * The active business's clients, `/v1/clients` (ADR-0017). Owners and managers see and add
 * every client; staff see only the clients they have a booking or waitlist entry with (the
 * database's member scope, AC-W9-1), so another client is simply not found. Everyone may find
 * a client by an exact email or phone (`POST /v1/clients/lookup`, ADR-0020).
 */
@Controller('v1/clients')
@UseGuards(TenantGuard)
export class ClientsController {
  constructor(private readonly clients: ClientsService) {}

  @Get()
  @RequirePermission('clients.read')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Query() query: unknown,
  ): Promise<ClientsResponse> {
    const parsed = parseBody(ClientsQuerySchema, query);
    return { clients: await answering(() => this.clients.list(tenant, parsed)) };
  }

  /**
   * 200 `{ clients }`: those with exactly this email or phone (none: an empty list). A POST, so
   * the contact stays out of URLs and access logs.
   */
  @Post('lookup')
  @HttpCode(200)
  @RequirePermission('clients.read')
  async lookUp(
    @CurrentTenant() tenant: TenantContext,
    @Body() body: unknown,
  ): Promise<ClientsResponse> {
    const lookup = parseBody(ClientLookupSchema, body);
    return { clients: await answering(() => this.clients.lookUp(tenant, lookup)) };
  }

  /** 404 `client_not_found` (also for staff asking about a client who is not theirs). */
  @Get(':clientId')
  @RequirePermission('clients.read')
  get(@CurrentTenant() tenant: TenantContext, @Param() params: unknown): Promise<Client> {
    const { clientId } = parseBody(ClientParamsSchema, params);
    return answering(() => this.clients.get(tenant, clientId));
  }

  /** 201 the client; 409 `client_email_taken`. */
  @Post()
  @RequirePermission('clients.manage')
  create(@CurrentTenant() tenant: TenantContext, @Body() body: unknown): Promise<Client> {
    const input = parseBody(ClientInputSchema, body);
    return answering(() => this.clients.create(tenant, input));
  }
}
