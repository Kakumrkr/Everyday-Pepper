import type { DatabaseHandle } from '@floty/db';
import { DATABASE } from '@floty/runtime';
import { Logger, Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { AccountController } from '../account/account.controller.js';
import { TenancyService } from '../account/tenancy.service.js';
import type { AuthConfig } from '../config.js';
import { AuthController } from './auth.controller.js';
import { AuthService, BetterAuthService } from './auth.service.js';
import { createBetterAuth, type BetterAuthOptions } from './better-auth.js';
import { SameOriginGuard, SessionGuard, TenantGuard } from './guards.js';

/** Sends Better Auth's log lines to a Nest logger (the redacting process logger). */
export function toNestLog(
  logger: Pick<Logger, 'error' | 'warn' | 'log'>,
): BetterAuthOptions['log'] {
  return (level, message) => {
    if (level === 'error') logger.error(message);
    else if (level === 'warn') logger.warn(message);
    else logger.log(message);
  };
}

/**
 * Sign-in (Better Auth at `/api/auth/*`), the session and tenant guards, the origin check for
 * every write, and the account endpoints (`/v1/me`, `/v1/tenants`, `/v1/tenant`). Global, so
 * feature modules can use its guards. Needs `ConnectionsModule` (the `DATABASE` handle).
 */
@Module({})
export class AuthModule {
  static forRoot(config: AuthConfig): DynamicModule {
    const log = toNestLog(new Logger('BetterAuth'));
    return {
      module: AuthModule,
      global: true,
      controllers: [AuthController, AccountController],
      providers: [
        {
          provide: AuthService,
          inject: [DATABASE],
          useFactory: (database: DatabaseHandle) =>
            new BetterAuthService(
              createBetterAuth({
                ...config,
                db: database.db,
                log,
              }),
              database.db,
            ),
        },
        {
          provide: APP_GUARD,
          inject: [Reflector],
          useFactory: (reflector: Reflector) => new SameOriginGuard(reflector, config.baseUrl),
        },
        TenancyService,
        SessionGuard,
        TenantGuard,
      ],
      exports: [AuthService, TenancyService, SessionGuard, TenantGuard],
    };
  }
}
