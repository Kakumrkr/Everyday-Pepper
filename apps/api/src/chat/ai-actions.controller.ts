import {
  ActionExecutionIdSchema,
  ActionProposalIdSchema,
  AiActionsResponseSchema,
  AiActionViewSchema,
  AiProposalsResponseSchema,
  AiProposalViewSchema,
  ApproveProposalRequestSchema,
  ApproveProposalResponseSchema,
  AutonomyChangeSchema,
  BusinessAutonomySchema,
  EditDraftRequestSchema,
  UndoActionRequestSchema,
  UndoActionResponseSchema,
  type AiActionsResponse,
  type AiActionView,
  type AiProposalsResponse,
  type AiProposalView,
  type ApproveProposalResponse,
  type BusinessAutonomy,
  type UndoActionResponse,
} from '@pepper/contracts';
import type { TenantContext } from '@pepper/core';
import { Body, Controller, Get, HttpCode, Param, Post, Put, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { CurrentTenant, RequirePermission, TenantGuard } from '../auth/guards.js';
import { answering } from '../http/domain-errors.js';
import { parseBody } from '../http/zod-body.js';
import { AiActionsService } from './ai-actions.service.js';

const ProposalParamsSchema = z.object({ proposalId: ActionProposalIdSchema });
const ActionParamsSchema = z.object({ executionId: ActionExecutionIdSchema });

/**
 * The AI's proposals and receipts, `/v1/ai` (S26, ADR-0031). Approve takes the proposal's id
 * and the fingerprint the card showed, nothing else; Undo takes the receipt's id and a reason.
 * Who may decide is the trust layer's call (the member it was for, or an owner or manager whose
 * role still allows it), so every role reaches these routes. Answers are checked against the
 * contracts on the way out too (OWASP LLM10: nothing unvalidated reaches the screen).
 */
@Controller('v1/ai')
@UseGuards(TenantGuard)
export class AiActionsController {
  constructor(private readonly ai: AiActionsService) {}

  /** Proposals waiting for the member's OK (staff: their own), oldest first. */
  @Get('proposals')
  @RequirePermission('business.read')
  async proposals(@CurrentTenant() tenant: TenantContext): Promise<AiProposalsResponse> {
    return AiProposalsResponseSchema.parse(await answering(() => this.ai.proposals(tenant)));
  }

  /** 404 `proposal_not_found` (also for another business's or a colleague's). */
  @Get('proposals/:proposalId')
  @RequirePermission('business.read')
  async proposal(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: unknown,
  ): Promise<AiProposalView> {
    const { proposalId } = parseBody(ProposalParamsSchema, params);
    return AiProposalViewSchema.parse(await answering(() => this.ai.proposal(tenant, proposalId)));
  }

  /** 200 executed / stale / refused / expired; 403; 404; 409 `proposal_not_pending`. */
  @Post('proposals/:proposalId/approve')
  @HttpCode(200)
  @RequirePermission('ai.chat')
  async approve(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: unknown,
    @Body() body: unknown,
  ): Promise<ApproveProposalResponse> {
    const { proposalId } = parseBody(ProposalParamsSchema, params);
    const { fingerprint } = parseBody(ApproveProposalRequestSchema, body);
    return ApproveProposalResponseSchema.parse(
      await answering(() => this.ai.approve(tenant, proposalId, fingerprint)),
    );
  }

  /**
   * A rebooking email's words, edited on the card (S36): the proposal is replaced by one with
   * the new words and a new fingerprint (or, from an out-of-date card, the current one comes
   * back). 404; 409 `proposal_not_pending`; 422 `draft_refused`.
   */
  @Post('proposals/:proposalId/draft')
  @HttpCode(200)
  @RequirePermission('ai.chat')
  async editDraft(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: unknown,
    @Body() body: unknown,
  ): Promise<AiProposalView> {
    const { proposalId } = parseBody(ProposalParamsSchema, params);
    const edit = parseBody(EditDraftRequestSchema, body);
    return AiProposalViewSchema.parse(
      await answering(() => this.ai.editDraft(tenant, proposalId, edit)),
    );
  }

  @Post('proposals/:proposalId/reject')
  @HttpCode(200)
  @RequirePermission('ai.chat')
  async reject(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: unknown,
  ): Promise<AiProposalView> {
    const { proposalId } = parseBody(ProposalParamsSchema, params);
    return AiProposalViewSchema.parse(await answering(() => this.ai.reject(tenant, proposalId)));
  }

  /** The AI's recent actions the member may see ("Done for you"), newest first. */
  @Get('actions')
  @RequirePermission('business.read')
  async actions(@CurrentTenant() tenant: TenantContext): Promise<AiActionsResponse> {
    return AiActionsResponseSchema.parse(await answering(() => this.ai.actions(tenant)));
  }

  /** 404 `action_not_found`. */
  @Get('actions/:executionId')
  @RequirePermission('business.read')
  async action(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: unknown,
  ): Promise<AiActionView> {
    const { executionId } = parseBody(ActionParamsSchema, params);
    return AiActionViewSchema.parse(await answering(() => this.ai.action(tenant, executionId)));
  }

  /** 403; 404; 409 `undo_window_closed` or `undo_refused` (with the reason). */
  @Post('actions/:executionId/undo')
  @HttpCode(200)
  @RequirePermission('ai.chat')
  async undo(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: unknown,
    @Body() body: unknown,
  ): Promise<UndoActionResponse> {
    const { executionId } = parseBody(ActionParamsSchema, params);
    const { reason } = parseBody(UndoActionRequestSchema, body);
    return UndoActionResponseSchema.parse(
      await answering(() => this.ai.undo(tenant, executionId, reason)),
    );
  }
}

/**
 * The business's autonomy dial, `/v1/autonomy` (ADR-0028, S26's settings page): everyone reads
 * it (staff see what the AI may do for them); owners and managers change it, never the AI.
 */
@Controller('v1/autonomy')
@UseGuards(TenantGuard)
export class AutonomyController {
  constructor(private readonly ai: AiActionsService) {}

  @Get()
  @RequirePermission('business.read')
  async get(@CurrentTenant() tenant: TenantContext): Promise<BusinessAutonomy> {
    return BusinessAutonomySchema.parse(await answering(() => this.ai.autonomy(tenant)));
  }

  /** 403 for staff; 400 for "just do it" where it is not allowed (bulk messages). */
  @Put()
  @RequirePermission('autonomy.manage')
  async change(
    @CurrentTenant() tenant: TenantContext,
    @Body() body: unknown,
  ): Promise<BusinessAutonomy> {
    const change = parseBody(AutonomyChangeSchema, body);
    return BusinessAutonomySchema.parse(
      await answering(() => this.ai.changeAutonomy(tenant, change)),
    );
  }
}
