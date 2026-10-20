import type { Task, TaskChange, TaskId, TaskInput, TaskQuery } from '@pepper/contracts';
import { changeTask, createTask, listTasks, type Actor, type TenantContext } from '@pepper/core';
import type { Database } from '@pepper/db';
import { currentRequestContext, DATABASE } from '@pepper/runtime';
import { Inject, Injectable } from '@nestjs/common';

/**
 * The task domain services for a request: binds the database and the request id (for the
 * audit log). Domain errors pass through; the controller answers them.
 */
@Injectable()
export class TasksService {
  private readonly db: Database;

  constructor(@Inject(DATABASE) database: { db: Database }) {
    this.db = database.db;
  }

  list(tenant: TenantContext, query: TaskQuery): Promise<Task[]> {
    return listTasks(this.db, actorOf(tenant), query);
  }

  create(tenant: TenantContext, input: TaskInput): Promise<Task> {
    return createTask(this.db, actorOf(tenant), input);
  }

  change(tenant: TenantContext, id: TaskId, change: TaskChange): Promise<Task> {
    return changeTask(this.db, actorOf(tenant), id, change);
  }
}

function actorOf(context: TenantContext): Actor {
  return { context, requestId: currentRequestContext()?.requestId };
}
