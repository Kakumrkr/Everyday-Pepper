import {
  ClientIdSchema,
  ClientInputSchema,
  ClientLookupSchema,
  ClientMergeSchema,
  ClientNamesRequestSchema,
  ClientsQuerySchema,
  type Client,
  type ClientNamesResponse,
  type ClientRecords,
  type ClientsPage,
  type ClientsResponse,
  type ClientTexts,
} from '@pepper/contracts';
import type { TenantContext } from '@pepper/core';
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
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { CurrentTenant, RequirePermission, TenantGuard } from '../auth/guards.js';
import { answering } from '../http/domain-errors.js';
import { parseBody } from '../http/zod-body.js';
import { ClientsService } from './clients.service.js';

const ClientParamsSchema = z.object({ clientId: ClientIdSchema });

/**
 * The active business's clients, `/v1/clients` (ADR-0017). Owners and managers see, add, edit,
 * merge and delete every client (S50, ADR-0051); staff see only the clients they have a booking or waitlist entry with (the
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
  ): Promise<ClientsPage> {
    const parsed = parseBody(ClientsQuerySchema, query);
    return answering(() => this.clients.list(tenant, parsed));
  }

  /**
   * 200 `{ names }` (S50.2): the names on visits, of the clients asked for (`ids`, comma-
   * separated) that the member may see (staff: their own), a deleted client as "Deleted
   * client" with `deleted`. Before `:clientId`, which would take "names" for an id.
   */
  @Get('names')
  @RequirePermission('clients.read')
  async names(
    @CurrentTenant() tenant: TenantContext,
    @Query() query: unknown,
  ): Promise<ClientNamesResponse> {
    const { ids } = parseBody(ClientNamesRequestSchema, query);
    return { names: await answering(() => this.clients.names(tenant, ids)) };
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

  /**
   * Where the client's texts stand, with the words they agreed to (S61.2, AC-X-66). 404
   * `client_not_found` (also for staff asking about a client who is not theirs).
   */
  @Get(':clientId/texts')
  @RequirePermission('clients.read')
  texts(@CurrentTenant() tenant: TenantContext, @Param() params: unknown): Promise<ClientTexts> {
    const { clientId } = parseBody(ClientParamsSchema, params);
    return answering(() => this.clients.texts(tenant, clientId));
  }

  /**
   * Stops the client's texts (S61.2, AC-X-67): 200 the new status. Owners and managers only;
   * only the client can turn them back on. 404 `client_not_found`.
   */
  @Post(':clientId/texts/stop')
  @HttpCode(200)
  @RequirePermission('clients.manage')
  stopTexts(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: unknown,
  ): Promise<ClientTexts> {
    const { clientId } = parseBody(ClientParamsSchema, params);
    return answering(() => this.clients.stopTexts(tenant, clientId));
  }

  /** 201 the client; 409 `client_email_taken`. */
  @Post()
  @RequirePermission('clients.manage')
  create(@CurrentTenant() tenant: TenantContext, @Body() body: unknown): Promise<Client> {
    const input = parseBody(ClientInputSchema, body);
    return answering(() => this.clients.create(tenant, input));
  }

  /**
   * Replaces the name, email and phone (ADR-0021). 404 `client_not_found`, 409
   * `client_email_taken`.
   */
  @Put(':clientId')
  @RequirePermission('clients.manage')
  update(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: unknown,
    @Body() body: unknown,
  ): Promise<Client> {
    const { clientId } = parseBody(ClientParamsSchema, params);
    const input = parseBody(ClientInputSchema, body);
    return answering(() => this.clients.update(tenant, clientId, input));
  }

  /** What a merge would move or a deletion keep and forget (S50). 404 `client_not_found`. */
  @Get(':clientId/records')
  @RequirePermission('clients.manage')
  records(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: unknown,
  ): Promise<ClientRecords> {
    const { clientId } = parseBody(ClientParamsSchema, params);
    return answering(() => this.clients.records(tenant, clientId));
  }

  /**
   * Merges `otherClientId` into this client, who is kept (ADR-0051). 200 the client kept; 404
   * `client_not_found` (either, or the same twice); 409 `client_merge_overlap`.
   */
  @Post(':clientId/merge')
  @HttpCode(200)
  @RequirePermission('clients.manage')
  merge(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: unknown,
    @Body() body: unknown,
  ): Promise<Client> {
    const { clientId } = parseBody(ClientParamsSchema, params);
    const merge = parseBody(ClientMergeSchema, body);
    return answering(() => this.clients.merge(tenant, clientId, merge));
  }

  /** Deletes the client (ADR-0051). 204; 404 `client_not_found`; 409 `client_has_upcoming_visits`. */
  @Delete(':clientId')
  @HttpCode(204)
  @RequirePermission('clients.manage')
  async remove(@CurrentTenant() tenant: TenantContext, @Param() params: unknown): Promise<void> {
    const { clientId } = parseBody(ClientParamsSchema, params);
    await answering(() => this.clients.delete(tenant, clientId));
  }
}
