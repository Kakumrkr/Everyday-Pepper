import { Catch, HttpException, type ArgumentsHost } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import * as Sentry from '@sentry/node';

/**
 * Reports unexpected errors (anything that is not an `HttpException`) to Sentry, then lets
 * Nest answer and log as usual (500, generic body; the log goes through the redacting logger).
 * `HttpException`s are deliberate answers and are not reported. A no-op without a Sentry DSN.
 */
@Catch()
export class ErrorReportingFilter extends BaseExceptionFilter {
  override catch(exception: unknown, host: ArgumentsHost): void {
    if (!(exception instanceof HttpException)) {
      Sentry.captureException(exception);
    }
    super.catch(exception, host);
  }
}
