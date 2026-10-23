import type { BookingNotify, TemplateRuleDefaultsOf } from '@pepper/appointments';
import type {
  ActionExplanation,
  AutonomyAction,
  ChangeSide,
  ClientId,
  MemoryWarningRule,
  RiskTier,
  ToolCard,
  TrustJson,
  UserId,
} from '@pepper/contracts';
import type { Actor, AutonomyDefaults, Clock } from '@pepper/core';
import type { Database, TenantTx } from '@pepper/db';
import type { z } from 'zod';
import type { ToolGuide } from './guide.js';

// The AI's tools (ADR-0029, playbook principles 1–5): thin adapters over the same domain
// services as the screens. A read answers in one member transaction; a write implements the
// trust layer's `ActionRunner` (ADR-0028) through `writeRunner`, so the dial, the proposal, the
// receipt and the undo are the trust layer's, never the tool's. Neither ever takes the business,
// the member or their role from the model: those come from `ToolDeps`, i.e. the session.

/** What the app gives every tool call (S25 builds it from the session and config). */
export interface ToolDeps {
  db: Database;
  /** The signed-in member the AI works for (never from the model). */
  actor: Actor;
  clock: Clock;
  /** The industry template's rule defaults (the app passes them; L2 never imports L3). */
  templateRuleDefaults?: TemplateRuleDefaultsOf;
  /** The industry template's autonomy defaults. */
  autonomy: AutonomyDefaults;
  /** Which remembered facts a booking warns about, by service category (the template's, S30). */
  memoryWarnings?: readonly MemoryWarningRule[];
  /** For the client emails a write queues (held for the undo-send grace). */
  emails: { baseUrl: string; outboxKey: Buffer };
  /**
   * Whose request the call answers, when it isn't `actor`'s: a lead approving a staff member's
   * proposal (S26). "Me" in the request ("remind me", "block my lunch") stays the staff member.
   */
  requester?: UserId;
}

/** Where a tool runs: one transaction of the member's business, in its time zone. */
export interface ToolScope {
  tx: TenantTx;
  /** The AI acting for the member (`via: 'ai'`), or the member themselves for an undo. */
  actor: Actor;
  deps: ToolDeps;
  /** Whose request it is ("me" in it): `deps.requester`, else the actor's member. */
  requester: UserId;
  timeZone: string;
  now: Date;
}

/** A read tool's answer: a short summary, the data for the model, a card for the member. */
export interface ToolAnswer {
  summary: string;
  data: TrustJson;
  card: ToolCard | null;
  /**
   * The answer holds text someone outside the team typed (a client's note, a booking-page
   * message): the loop labels it as data and marks the turn untrusted (playbook principle 10).
   * Names are cut to letters, so none of today's reads set it.
   */
  untrustedText?: boolean;
}

export interface ReadTool<S extends z.ZodType = z.ZodType> {
  kind: 'read';
  name: string;
  version: number;
  guide: ToolGuide;
  /** Strict Zod arguments: every field required, "not given" as `null`. */
  args: S;
  /** Whether the arguments take local dates or times (the description says how). */
  localTimes: boolean;
  run(scope: ToolScope, args: z.output<S>): Promise<ToolAnswer>;
}

/** A write's scope: `notifyClient(clientId)` queues (and records) that client's email. */
export interface WriteScope extends ToolScope {
  notifyClient(clientId: ClientId): BookingNotify;
}

/** What a write did (or, in the dry run, would do), as the domain computed it. */
export interface Performed {
  entity: { type: string; id: string };
  /** One pending proposal per target (`booking:<id>`). */
  targetKey: string;
  /** Whose record it changes (the staff member's login, the assignee). */
  recordOwner: UserId | null;
  appointmentStartsAt: Date | null;
  /** The record before and after: ids, local dates and times, codes (no new ids). */
  before: ChangeSide | null;
  after: ChangeSide;
  /** The touched rows' versions, for the fingerprint (ADR-0028: only what the tool touches). */
  touched: TrustJson;
  /** What `undo` needs; `null`: nothing to undo. */
  inverse: TrustJson | null;
  /** One sentence for the model and the card, in the business's local time. */
  summary: string;
  /**
   * What the domain checked on the way, for *Why?* (S26b): codes with flat values (local dates
   * and times, display names, counts), never a contact. The wording is the screens'.
   */
  facts: ActionExplanation['facts'];
  /**
   * The summary echoes free text stored in a record that may hold words from outside the team
   * (the AI's own to-do title, S27): the loop labels the answer as data and marks the turn
   * untrusted, as for a read's `untrustedText`.
   */
  untrustedText?: boolean;
  /**
   * Remembered facts for the model with the answer, by reference (`{ "$fact": id }`), filled in
   * from the memory tables whenever the answer is sent (S30): a booking's warnings and the
   * client's last visit. Never stored with the action.
   */
  memory?: TrustJson;
}

/** The conversation turn a call belongs to (where a remembered fact came from, S30). */
export interface ToolCallOrigin {
  turnId: string | null;
}

export interface WriteTool<S extends z.ZodType = z.ZodType> {
  kind: 'write';
  name: string;
  /** Bumped whenever what the tool does changes (part of the fingerprint). */
  version: number;
  guide: ToolGuide;
  args: S;
  localTimes: boolean;
  tier: RiskTier;
  /** The dial actions this call involves: the change first, then any email to the client. */
  actions(args: z.output<S>): readonly [AutonomyAction, ...AutonomyAction[]];
  /** Makes the change through the domain (the dry run makes it too, in a rolled-back savepoint). */
  perform(scope: WriteScope, args: z.output<S>): Promise<Performed>;
  /** Reverses it through the domain, as the member. */
  undo(scope: ToolScope, inverse: TrustJson): Promise<void>;
  /**
   * For a call whose arguments hold something that must not be stored with the action (a
   * remembered value, S30, playbook principle 7): stores it where it belongs first (a proposed
   * fact) and returns the payload to store instead, ids only. `perform` then gets that payload,
   * parsed with `payload`.
   */
  stash?(scope: ToolScope, args: z.output<S>, origin: ToolCallOrigin): Promise<TrustJson>;
  /** Removes what `stash` stored, when the call won't happen (refused, or a retry). */
  unstash?(scope: ToolScope, payload: TrustJson): Promise<void>;
  /** The stored payload's schema, when `stash` replaces the arguments. */
  payload?: z.ZodType;
  /** No dial setting decides it: it always waits for the member's OK (S30 D-1). */
  alwaysAsks?: boolean;
}

export type AnyTool = ReadTool | WriteTool;
