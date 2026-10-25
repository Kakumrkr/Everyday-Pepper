import type {
  FeedClose,
  FeedItemId,
  FeedResponse,
  FeedSettings,
  FeedSettingsChange,
} from '@pepper/contracts';
import {
  changeFeedSettings,
  closeFeedItem,
  getFeed,
  type Actor,
  type TenantContext,
} from '@pepper/core';
import type { Database } from '@pepper/db';
import { currentRequestContext, DATABASE } from '@pepper/runtime';
import { templateDrafts } from '@pepper/templates';
import { Inject, Injectable } from '@nestjs/common';

/**
 * The feed domain services for a request: binds the database and the request id (for the
 * audit log). Domain errors pass through; the controller answers them.
 */
@Injectable()
export class FeedService {
  private readonly db: Database;

  constructor(@Inject(DATABASE) database: { db: Database }) {
    this.db = database.db;
  }

  get(tenant: TenantContext): Promise<FeedResponse> {
    return getFeed(this.db, actorOf(tenant), {
      morningHourOf: (templateId) => templateDrafts(templateId).morningHour,
    });
  }

  close(tenant: TenantContext, id: FeedItemId, close: FeedClose): Promise<void> {
    return closeFeedItem(this.db, actorOf(tenant), id, close);
  }

  changeSettings(tenant: TenantContext, change: FeedSettingsChange): Promise<FeedSettings> {
    return changeFeedSettings(this.db, actorOf(tenant), change, {
      morningHourOf: (templateId) => templateDrafts(templateId).morningHour,
    });
  }
}

function actorOf(context: TenantContext): Actor {
  return { context, requestId: currentRequestContext()?.requestId };
}
