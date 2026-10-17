import type { IncomingMessage, ServerResponse } from 'node:http';
import { All, Controller, Req, Res } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { AUTH_BASE_PATH } from './better-auth.js';
import { SkipOriginCheck } from './guards.js';

/** Better Auth's endpoints; it checks origins (CSRF) and rate limits itself. */
@Controller(AUTH_BASE_PATH.slice(1))
@SkipOriginCheck()
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @All('*path')
  async handle(@Req() request: IncomingMessage, @Res() response: ServerResponse): Promise<void> {
    await this.auth.handle(request, response);
  }
}
