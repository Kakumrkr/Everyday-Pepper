import type { PushEndpoint, PushSubscriptionInput } from '@pepper/contracts';
import {
  pushDeviceStatus,
  removePushDevice,
  savePushDevice,
  type Actor,
  type TenantContext,
} from '@pepper/core';
import type { Database } from '@pepper/db';
import { currentRequestContext, DATABASE } from '@pepper/runtime';
import { Inject, Injectable } from '@nestjs/common';

/** The push device services for a request. Domain errors pass through. */
@Injectable()
export class PushService {
  private readonly db: Database;

  constructor(@Inject(DATABASE) database: { db: Database }) {
    this.db = database.db;
  }

  save(tenant: TenantContext, input: PushSubscriptionInput): Promise<void> {
    return savePushDevice(this.db, actorOf(tenant), input);
  }

  remove(tenant: TenantContext, device: PushEndpoint): Promise<void> {
    return removePushDevice(this.db, actorOf(tenant), device);
  }

  status(tenant: TenantContext, device: PushEndpoint): Promise<boolean> {
    return pushDeviceStatus(this.db, actorOf(tenant), device);
  }
}

function actorOf(context: TenantContext): Actor {
  return { context, requestId: currentRequestContext()?.requestId };
}
