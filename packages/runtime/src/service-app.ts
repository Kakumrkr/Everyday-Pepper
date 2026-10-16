import { Injectable, Module, type DynamicModule, type OnApplicationShutdown } from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { ServiceConfig } from './config.js';
import { ErrorReportingFilter } from './exception.filter.js';
import { createLogger, PinoNestLogger, type Logger } from './logger.js';
import { requestLogging } from './request-logging.js';
import { shutdownObservability } from './telemetry.js';

@Injectable()
class ObservabilityLifecycle implements OnApplicationShutdown {
  /** Runs after the app's own shutdown hooks: flushes pending spans and error reports. */
  async onApplicationShutdown(): Promise<void> {
    await shutdownObservability();
  }
}

@Module({})
class ServiceRootModule {}

export interface CreateServiceAppOptions {
  /** Defaults to `createLogger(config)` (JSON on stdout). */
  logger?: Logger;
}

/**
 * Creates a Nest app for `appModule` with the shared process wiring: the redacting JSON logger
 * for Nest and for every request (with `x-request-id`), error reporting, shutdown hooks that
 * flush telemetry, and no `X-Powered-By`. The caller calls `listen` (or `init` in tests).
 */
export async function createServiceApp(
  appModule: DynamicModule,
  config: ServiceConfig,
  options: CreateServiceAppOptions = {},
): Promise<NestExpressApplication> {
  const logger = options.logger ?? createLogger(config);
  const root: DynamicModule = {
    module: ServiceRootModule,
    imports: [appModule],
    providers: [ObservabilityLifecycle],
  };
  const app = await NestFactory.create<NestExpressApplication>(root, {
    logger: new PinoNestLogger(logger),
    // Throw instead of exiting on a wiring error, so the caller (or test) sees it.
    abortOnError: false,
  });
  app.disable('x-powered-by');
  app.use(requestLogging(logger));
  app.useGlobalFilters(new ErrorReportingFilter(app.get(HttpAdapterHost).httpAdapter));
  app.enableShutdownHooks();
  return app;
}
