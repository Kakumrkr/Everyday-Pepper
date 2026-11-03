import type {
  Client,
  ClientId,
  ClientInput,
  ClientLookup,
  ClientMerge,
  ClientNamesRequest,
  ClientNamesResponse,
  ClientRecords,
  ClientsPage,
  ClientsQuery,
} from '@pepper/contracts';
import {
  clientNames,
  createClient,
  deleteClient,
  getClient,
  getClientRecords,
  listClientsPage,
  lookUpClients,
  mergeClients,
  updateClient,
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

  list(tenant: TenantContext, query: ClientsQuery): Promise<ClientsPage> {
    return listClientsPage(this.db, actorOf(tenant), query);
  }

  names(tenant: TenantContext, request: ClientNamesRequest): Promise<ClientNamesResponse['names']> {
    return clientNames(this.db, actorOf(tenant), request);
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

  update(tenant: TenantContext, id: ClientId, input: ClientInput): Promise<Client> {
    return updateClient(this.db, actorOf(tenant), id, input);
  }

  records(tenant: TenantContext, id: ClientId): Promise<ClientRecords> {
    return getClientRecords(this.db, actorOf(tenant), id);
  }

  merge(tenant: TenantContext, id: ClientId, merge: ClientMerge): Promise<Client> {
    return mergeClients(this.db, actorOf(tenant), id, merge);
  }

  delete(tenant: TenantContext, id: ClientId): Promise<void> {
    return deleteClient(this.db, actorOf(tenant), id);
  }
}

function actorOf(context: TenantContext): Actor {
  return { context, requestId: currentRequestContext()?.requestId };
}
