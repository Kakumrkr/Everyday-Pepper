import type { Client, ClientId, ClientInput, ClientLookup, ClientsQuery } from '@pepper/contracts';
import {
  createClient,
  getClient,
  listClients,
  lookUpClients,
  type Actor,
  type TenantContext,
} from '@pepper/core';
import type { Database } from '@pepper/db';
import { currentRequestContext, DATABASE } from '@pepper/runtime';
import { Inject, Injectable } from '@nestjs/common';

/**
 * The clients domain services for a request: binds the database and the request id (for the
 * audit log). Domain errors pass through; the controller answers them.
 */
@Injectable()
export class ClientsService {
  private readonly db: Database;

  constructor(@Inject(DATABASE) database: { db: Database }) {
    this.db = database.db;
  }

  list(tenant: TenantContext, query: ClientsQuery): Promise<Client[]> {
    return listClients(this.db, actorOf(tenant), query);
  }

  lookUp(tenant: TenantContext, lookup: ClientLookup): Promise<Client[]> {
    return lookUpClients(this.db, actorOf(tenant), lookup);
  }

  get(tenant: TenantContext, id: ClientId): Promise<Client> {
    return getClient(this.db, actorOf(tenant), id);
  }

  create(tenant: TenantContext, input: ClientInput): Promise<Client> {
    return createClient(this.db, actorOf(tenant), input);
  }
}

function actorOf(context: TenantContext): Actor {
  return { context, requestId: currentRequestContext()?.requestId };
}
