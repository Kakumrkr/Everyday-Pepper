import type { Client, ClientId, ClientInput, ClientsQuery } from '@floty/contracts';
import { createClient, getClient, listClients, type Actor, type TenantContext } from '@floty/core';
import type { Database } from '@floty/db';
import { currentRequestContext, DATABASE } from '@floty/runtime';
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
