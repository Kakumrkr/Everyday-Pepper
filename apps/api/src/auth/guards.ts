import type { IncomingMessage } from 'node:http';
import type { ApiErrorCode, Permission } from '@pepper/contracts';
import { can, decideTenantAccess, type TenantContext } from '@pepper/core';
import { identifyRequest } from '@pepper/runtime';
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
  forbidden_origin: 'This request did not come from the Pepper app',
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
  service_not_found: 'No such service in this business',
  service_name_taken: 'The business already has a service with this name',
  staff_member_not_found: 'No such staff member in this business',
  staff_member_link_taken: "This member's login is already linked to another staff member",
  time_off_not_found: 'No such time off for this staff member',
  client_not_found: 'No such client in this business',
  client_email_taken: 'The business already has a client with this email',
  client_has_upcoming_visits: 'Cancel or move the client’s upcoming visits first',
  client_merge_overlap: 'These two clients have visits at the same time, so they are two people',
  booking_not_found: 'No such booking in this business',
  slot_unavailable: 'That time cannot be booked',
  booking_not_changeable: 'This booking can no longer be changed this way',
  booking_not_started: 'Mark a booking completed or no-show once it has started',
  idempotency_key_reused: 'This idempotency key was already used for a different booking',
  waitlist_entry_not_found: 'No such waitlist entry in this business',
  waitlist_entry_not_changeable: 'This waitlist entry can no longer be changed',
  waitlist_expired: 'Every window of this waitlist entry has already passed',
  waitlist_times_free: 'A time inside these windows is still free: book it instead',
  waitlist_day_too_far: 'That day is too far ahead to join the waitlist',
  waitlist_offer_not_found: 'This offer link is not valid',
  waitlist_offer_used: 'This offer has already been claimed',
  waitlist_offer_taken: 'Sorry, this time has been taken',
  waitlist_offer_expired: 'This offer has expired',
  task_not_found: 'No such task in this business',
  task_assignee_not_member: 'Tasks can only be given to members of this business',
  push_unavailable: 'Notifications are not available here',
  feed_item_not_found: 'This suggestion is no longer open',
  draft_refused:
    'Leave out links, email addresses, phone numbers and sensitive notes, and keep it to 120 words',
  nudge_not_sendable: 'This email can no longer be sent to this client',
  review_request_not_sendable: 'This review request can no longer be sent to this client',
  unsubscribe_link_invalid: 'This unsubscribe link is not valid',
  booking_page_not_found: 'There is no booking page at this address',
  booking_request_not_found: 'This booking request was not found. Start again',
  booking_request_expired: 'This code has expired. Ask for a new one',
  booking_request_used: 'This booking is already confirmed. Check your email',
  wrong_code: 'That code is not right. Check the email and try again',
  too_many_requests: 'Too many tries. Wait a little and try again',
  email_unavailable: 'Online booking is not available right now. Contact the business',
  temporarily_unavailable: 'This is not available right now. Try again in a moment',
  conversation_not_found: 'No such conversation',
  turn_in_progress: 'Pepper is still answering your last message in this conversation',
  proposal_not_found: 'No such proposal in this business',
  proposal_not_pending: 'This was already decided, or replaced by a newer one',
  action_not_found: 'No such action in this business',
  undo_window_closed: 'This can no longer be undone',
  undo_refused: 'This can no longer be undone as it was',
  memory_fact_not_found: 'Pepper no longer remembers this',
  memory_subject_not_found: 'No such client, team member, service or visit',
  memory_episode_not_found: 'Pepper no longer remembers this conversation',
  memory_limit_reached: 'Pepper remembers as much as it can here. Delete something first',
  memory_paused: 'Remembering new things is paused for this business',
  photo_not_found: 'There is no such photo',
  photo_rejected: 'That file is not a photo we can use',
  photo_too_large: 'That photo is over 10 MB',
  import_not_found: 'No such import',
  import_rejected: 'That file can’t be imported',
  import_too_large: 'That file is over 5 MB. Split it into smaller files.',
  import_not_staged: 'That import has already been started',
  import_not_ready: 'That import isn’t ready',
  import_not_undoable: 'That import can’t be undone',
  import_mapping_invalid: 'That mapping doesn’t fit the file',
  gallery_full: 'The gallery holds 12 photos',
  storage_unavailable: 'Photos are not available right now',
  deletion_name_mismatch: 'Type the business’s name exactly as it is shown',
  wrong_password: 'That password isn’t right',
  account_owns_business:
    'You’re the only owner of a business. Delete the business first, or make someone else an owner',
  account_being_deleted: 'Your account is being deleted. Keep your account first',
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
