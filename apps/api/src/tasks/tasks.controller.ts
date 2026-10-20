import {
  TaskChangeSchema,
  TaskIdSchema,
  TaskInputSchema,
  TaskQuerySchema,
  type Task,
  type TasksResponse,
} from '@pepper/contracts';
import type { TenantContext } from '@pepper/core';
import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { CurrentTenant, RequirePermission, TenantGuard } from '../auth/guards.js';
import { answering } from '../http/domain-errors.js';
import { parseBody } from '../http/zod-body.js';
import { TasksService } from './tasks.service.js';

const TaskParamsSchema = z.object({ taskId: TaskIdSchema });

/**
 * The active business's to-dos, `/v1/tasks` (ADR-0026). Owners and managers see, assign and
 * change every task; staff only the tasks assigned to them or that they created (the
 * database's member scope), so another task is simply not found, and they give new tasks
 * only to themselves.
 */
@Controller('v1/tasks')
@UseGuards(TenantGuard)
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get()
  @RequirePermission('tasks.read')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Query() query: unknown,
  ): Promise<TasksResponse> {
    const parsed = parseBody(TaskQuerySchema, query);
    return { tasks: await answering(() => this.tasks.list(tenant, parsed)) };
  }

  /** 201 the task; 403 `forbidden` (staff assigning someone else); 422 `task_assignee_not_member`. */
  @Post()
  @RequirePermission('tasks.manage')
  create(@CurrentTenant() tenant: TenantContext, @Body() body: unknown): Promise<Task> {
    const input = parseBody(TaskInputSchema, body);
    return answering(() => this.tasks.create(tenant, input));
  }

  /** 200 the task; 404 `task_not_found`; 403 `forbidden`; 422 `task_assignee_not_member`. */
  @Patch(':taskId')
  @RequirePermission('tasks.manage')
  change(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: unknown,
    @Body() body: unknown,
  ): Promise<Task> {
    const { taskId } = parseBody(TaskParamsSchema, params);
    const change = parseBody(TaskChangeSchema, body);
    return answering(() => this.tasks.change(tenant, taskId, change));
  }
}
