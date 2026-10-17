import type { IncomingMessage } from 'node:http';
import type { ApiErrorCode, Permission } from '@floty/contracts';
import { can, decideTenantAccess, type TenantContext } from '@floty/core';
import { identifyRequest } from '@floty/runtime';
import {
  createParamDecorator,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TenancyService } from '../account/tenancy.service.js';
import { AuthService, type AuthSession } from './auth.service.js';

/** What the guards attach to a request. */
interface GuardedRequest extends IncomingMessage {
  authSession?: AuthSession;
  tenantContext?: TenantContext;
}

const MESSAGES: Record<ApiErrorCode, string> = {
  unauthenticated: 'Sign in to continue',
  no_active_tenant: 'Choose or create a business first',
  not_a_member: 'You are not a member of this business',
  mfa_required: 'Set up two-step verification to manage your business',
  forbidden_origin: 'This request did not come from the Floty app',
  slug_taken: 'That booking link is already taken',
  validation_failed: 'Some fields are invalid',
  forbidden: 'Your role in this business does not allow this',
  member_not_found: 'No such member in this business',
  last_owner: 'A business needs at least one owner',
  business_limit_reached: 'You already own as many businesses as one account may create',
  invite_invalid: 'This invite link is no longer valid. Ask for a new one',
  invite_wrong_account: 'This invite is for another email. Sign in with the email it was sent to',
  invite_not_found: 'No such open invite in this business',
  invite_limit_reached: 'This business has as many open invites as it may',
  already_a_member: 'Already a member of this business',
};

/** An `{ code, message }` body (`ApiErrorSchema`). */
export function apiError(code: ApiErrorCode): { code: ApiErrorCode; message: string } {
  return { code, message: MESSAGES[code] };
}

function requestOf(context: ExecutionContext): GuardedRequest {
  return context.switchToHttp().getRequest<GuardedRequest>();
}

/** Requires a signed-in user; 401 otherwise. Use `@CurrentSession()` in the handler. */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = requestOf(context);
    const session = await this.auth.getSession(request.headers);
    if (session === null) throw new UnauthorizedException(apiError('unauthenticated'));
    request.authSession = session;
    identifyRequest({ userId: session.user.id });
    return true;
  }
}

const REQUIRED_PERMISSION = Symbol('requiredPermission');

/**
 * The permission a `TenantGuard` route needs (ADR-0013): 403 `forbidden` for a role without
 * it. A permission scoped to the member's own records passes here; the domain service then
 * checks the record. The service checks the permission again, so this is defence in depth.
 */
export const RequirePermission = (permission: Permission) =>
  SetMetadata(REQUIRED_PERMISSION, permission);

/**
 * Requires a signed-in member of the session's active business (with MFA if they are an owner
 * or manager) and the route's `@RequirePermission`; 401 or 403 otherwise. The tenant comes
 * from the session only. Use `@CurrentTenant()`.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private readonly sessions: SessionGuard,
    private readonly tenancy: TenancyService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    await this.sessions.canActivate(context);
    const request = requestOf(context);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- set by SessionGuard just above
    const session = request.authSession!;
    const { activeTenantId } = session;
    const access = decideTenantAccess({
      userId: session.user.id,
      activeTenantId,
      role:
        activeTenantId === null ? null : await this.tenancy.roleIn(activeTenantId, session.user.id),
      twoFactorEnabled: session.user.twoFactorEnabled,
    });
    if (!access.allowed) throw new ForbiddenException(apiError(access.reason));
    request.tenantContext = access.context;
    identifyRequest(access.context);
    const permission = this.reflector.getAllAndOverride<Permission | undefined>(
      REQUIRED_PERMISSION,
      [context.getHandler(), context.getClass()],
    );
    if (permission !== undefined && !can(access.context, permission)) {
      throw new ForbiddenException(apiError('forbidden'));
    }
    return true;
  }
}

/** The session `SessionGuard` (or `TenantGuard`) resolved. */
export const CurrentSession = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const session = requestOf(context).authSession;
  if (session === undefined) throw new Error('CurrentSession needs SessionGuard or TenantGuard');
  return session;
});

/** The tenant context `TenantGuard` resolved. */
export const CurrentTenant = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const tenant = requestOf(context).tenantContext;
  if (tenant === undefined) throw new Error('CurrentTenant needs TenantGuard');
  return tenant;
});

const SKIP_ORIGIN_CHECK = Symbol('skipOriginCheck');

/** For handlers that check origins themselves (Better Auth's endpoints). */
export const SkipOriginCheck = () => SetMetadata(SKIP_ORIGIN_CHECK, true);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF protection for cookie-authenticated writes: a state-changing request must carry an
 * `Origin` header naming the app itself. Browsers always send it on cross-site and same-site
 * fetches with a body, so a missing header is rejected too. Registered for every route.
 */
@Injectable()
export class SameOriginGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly allowedOrigin: string,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = requestOf(context);
    if (SAFE_METHODS.has(request.method ?? 'GET')) return true;
    const skip = this.reflector.getAllAndOverride<boolean | undefined>(SKIP_ORIGIN_CHECK, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip === true) return true;
    if (request.headers.origin === this.allowedOrigin) return true;
    throw new ForbiddenException(apiError('forbidden_origin'));
  }
}
