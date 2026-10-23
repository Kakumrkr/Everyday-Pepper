import type {
  MemoryEpisode,
  MemoryEpisodeId,
  MemoryFact,
  MemoryFactChange,
  MemoryFactId,
  MemoryFactInput,
  MemoryFactShown,
  MemoryFactView,
  MemoryFactListQuery,
  MemorySettings,
} from '@pepper/contracts';
import {
  changeFact,
  changeMemorySettings,
  deleteEpisode,
  factsShown,
  forgetFact,
  getMemorySettings,
  listFactViews,
  listMyEpisodes,
  saveFact,
  type Actor,
  type TenantContext,
} from '@pepper/core';
import type { Database } from '@pepper/db';
import { currentRequestContext, DATABASE } from '@pepper/runtime';
import { Inject, Injectable } from '@nestjs/common';

/**
 * The memory domain services for a request (S32): binds the database and the request id (for
 * the audit log). Domain errors pass through; the controller answers them.
 */
@Injectable()
export class MemoryService {
  private readonly db: Database;

  constructor(@Inject(DATABASE) database: { db: Database }) {
    this.db = database.db;
  }

  facts(tenant: TenantContext, query: MemoryFactListQuery): Promise<MemoryFactView[]> {
    return listFactViews(this.db, actorOf(tenant), query);
  }

  shown(tenant: TenantContext, ids: readonly MemoryFactId[]): Promise<MemoryFactShown[]> {
    return factsShown(this.db, actorOf(tenant), ids);
  }

  /** A fact a member adds on a screen: allowed while remembering is paused (ADR-0034). */
  async save(tenant: TenantContext, input: MemoryFactInput): Promise<MemoryFact> {
    return (await saveFact(this.db, actorOf(tenant), input, { source: 'screen' })).fact;
  }

  change(tenant: TenantContext, id: MemoryFactId, change: MemoryFactChange): Promise<MemoryFact> {
    return changeFact(this.db, actorOf(tenant), id, change);
  }

  forget(tenant: TenantContext, id: MemoryFactId): Promise<void> {
    return forgetFact(this.db, actorOf(tenant), id);
  }

  episodes(tenant: TenantContext): Promise<MemoryEpisode[]> {
    return listMyEpisodes(this.db, actorOf(tenant));
  }

  deleteEpisode(tenant: TenantContext, id: MemoryEpisodeId): Promise<void> {
    return deleteEpisode(this.db, actorOf(tenant), id);
  }

  settings(tenant: TenantContext): Promise<MemorySettings> {
    return getMemorySettings(this.db, actorOf(tenant));
  }

  changeSettings(tenant: TenantContext, settings: MemorySettings): Promise<MemorySettings> {
    return changeMemorySettings(this.db, actorOf(tenant), settings);
  }
}

function actorOf(context: TenantContext): Actor {
  return { context, requestId: currentRequestContext()?.requestId };
}
