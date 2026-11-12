import {
  ReminderSettingsPatchSchema,
  ReminderSettingsViewSchema,
  type ReminderSettingsPatch,
  type ReminderSettingsView,
} from '@pepper/contracts';
import { getReminderSettings, updateReminderSettings } from '@pepper/appointments';
import type { Actor, TenantContext } from '@pepper/core';
import type { Database } from '@pepper/db';
import { currentRequestContext, DATABASE } from '@pepper/runtime';
import {
  Body,
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { CurrentTenant, RequirePermission, TenantGuard } from '../auth/guards.js';
import { answering } from '../http/domain-errors.js';
import { parseBody } from '../http/zod-body.js';

/** The domain's texts and reminders settings (S62, AC-X-75) for the controller. */
@Injectable()
export class RemindersService {
  private readonly db: Database;

  constructor(@Inject(DATABASE) database: { db: Database }) {
    this.db = database.db;
  }

  get(tenant: TenantContext): Promise<ReminderSettingsView> {
    return getReminderSettings(this.db, actorOf(tenant));
  }

  change(tenant: TenantContext, patch: ReminderSettingsPatch): Promise<ReminderSettingsView> {
    return updateReminderSettings(this.db, actorOf(tenant), patch);
  }
}

function actorOf(context: TenantContext): Actor {
  return { context, requestId: currentRequestContext()?.requestId };
}

/**
 * `/v1/reminders/settings` (S62, AC-X-75): what the business texts and emails its clients
 * before a visit. Every member reads them; owners and managers change them (audited, upcoming
 * reminders re-planned).
 */
@Controller('v1/reminders')
@UseGuards(TenantGuard)
export class RemindersController {
  constructor(private readonly reminders: RemindersService) {}

  /** 200 the settings and `canChange`. */
  @Get('settings')
  @RequirePermission('calendar.read')
  async get(@CurrentTenant() tenant: TenantContext): Promise<ReminderSettingsView> {
    return ReminderSettingsViewSchema.parse(await answering(() => this.reminders.get(tenant)));
  }

  /** 200 the new settings; 400 `validation_failed` (empty or unknown); 403 for staff. */
  @Patch('settings')
  @RequirePermission('settings.manage')
  async change(
    @CurrentTenant() tenant: TenantContext,
    @Body() body: unknown,
  ): Promise<ReminderSettingsView> {
    const patch = parseBody(ReminderSettingsPatchSchema, body);
    return ReminderSettingsViewSchema.parse(
      await answering(() => this.reminders.change(tenant, patch)),
    );
  }
}

/** Texts and reminders settings. Needs `AuthModule` (global) and `ConnectionsModule`. */
@Module({ controllers: [RemindersController], providers: [RemindersService] })
export class RemindersModule {}
