import {
  AutonomyActionSchema,
  AutonomyChangeSchema,
  AutonomySettingsSchema,
  presetLevels,
  type AutonomyAction,
  type AutonomyChange,
  type AutonomyLevel,
  type AutonomyPreset,
  type AutonomySettings,
  type AutonomyTrackRecord,
  type BusinessAutonomy,
} from '@pepper/contracts';
import {
  actionTrackRecord,
  appendAuditEntry,
  findAutonomySettings,
  saveAutonomySettings,
  withMember,
  type Database,
  type TenantTx,
} from '@pepper/db';
import { auditActorOf, requirePermission, type Actor } from '../actor.js';
import { earnedTrustOffer, resolveAutonomy } from '../autonomy.js';
import { systemClock, type Clock } from '../clock.js';
import { can } from '../permissions.js';
import { ForbiddenError } from '../errors.js';

// A business's autonomy settings (ADR-0028): what the AI may do without asking. Everyone in
// the business may see them (knowing what the AI will do for you is part of trusting it);
// owners and managers change them. The AI never changes them itself: it can only propose a
// change, which a member then makes here.

/** The industry template's defaults, passed in by the app (core does not import templates). */
export interface AutonomyDefaults {
  templateDefaults: AutonomySettings;
}

/** The business's effective autonomy, read in the caller's transaction. */
export async function loadAutonomy(
  tx: TenantTx,
  defaults: AutonomyDefaults,
): Promise<BusinessAutonomy> {
  return resolveAutonomy(ownChoices(await findAutonomySettings(tx)), defaults.templateDefaults);
}

/** The business's autonomy, as the Autonomy settings page shows it. */
export async function getAutonomy(
  db: Database,
  actor: Actor,
  defaults: AutonomyDefaults,
): Promise<BusinessAutonomy> {
  requirePermission(actor, 'business.read');
  return withMember(db, actor.context, (tx) => loadAutonomy(tx, defaults));
}

/**
 * Changes the business's autonomy: the "Ask me first for everything" switch and levels per
 * action (`null`: back to the default). Returns the effective autonomy after the change.
 */
export async function changeAutonomy(
  db: Database,
  actor: Actor,
  change: AutonomyChange,
  defaults: AutonomyDefaults,
): Promise<BusinessAutonomy> {
  requirePermission(actor, 'autonomy.manage');
  // Changing autonomy is always the member's own act (playbook: an "ask" action for the AI).
  if (actor.via === 'ai') throw new ForbiddenError('autonomy.manage');
  const fields = AutonomyChangeSchema.parse(change);
  return withMember(db, actor.context, async (tx) => {
    const stored = ownChoices(await findAutonomySettings(tx, { lock: true }));
    const before = {
      askFirst: stored?.askFirst ?? false,
      levels: validLevels(stored?.levels ?? {}),
    };
    // A preset (S53) sets every action: `balanced` back to the defaults, the others explicitly.
    const changed: NonNullable<AutonomyChange['levels']> =
      fields.preset === undefined
        ? (fields.levels ?? {})
        : presetChange(fields.preset, defaults.templateDefaults);
    const levels: AutonomySettings = Object.fromEntries(
      AutonomyActionSchema.options.flatMap((action) => {
        const level = action in changed ? changed[action] : before.levels[action];
        return level === null || level === undefined ? [] : [[action, level]];
      }),
    );
    const after = { askFirst: fields.askFirst ?? before.askFirst, levels };
    if (sameChoices(before, after)) return resolveAutonomy(after, defaults.templateDefaults);

    await saveAutonomySettings(tx, { ...after, updatedBy: actor.context.userId });
    await appendAuditEntry(tx, {
      actor: auditActorOf(actor),
      change: {
        action: 'autonomy.updated',
        entity: { type: 'tenant', id: actor.context.tenantId },
        before,
        after,
      },
      requestId: actor.requestId,
    });
    return resolveAutonomy(after, defaults.templateDefaults);
  });
}

/** The levels a preset stores: none for `balanced` (the defaults), every action otherwise. */
function presetChange(
  preset: AutonomyPreset,
  templateDefaults: AutonomySettings,
): Record<AutonomyAction, AutonomyLevel | null> {
  const levels = presetLevels(preset, resolveAutonomy(undefined, templateDefaults).levels);
  return Object.fromEntries(
    AutonomyActionSchema.options.map((action) => [
      action,
      preset === 'balanced' ? null : levels[action],
    ]),
  ) as Record<AutonomyAction, AutonomyLevel | null>;
}

/**
 * The AI's track record per action (S53, ADR-0055): how often it did each in the last 30 days,
 * how many it did in a row since its last mistake, and, for members who change autonomy, the
 * level Pepper offers once that streak is earned. Staff see their own records' counts (the
 * trust tables' member scope).
 */
export async function getTrackRecord(
  db: Database,
  actor: Actor,
  options: AutonomyDefaults & { clock?: Clock },
): Promise<AutonomyTrackRecord> {
  requirePermission(actor, 'business.read');
  const now = (options.clock ?? systemClock).now().getTime();
  const day = 24 * 60 * 60 * 1000;
  const { rows, autonomy } = await withMember(db, actor.context, async (tx) => ({
    rows: await actionTrackRecord(tx, {
      since30: new Date(now - 30 * day),
      since90: new Date(now - 90 * day),
    }),
    autonomy: await loadAutonomy(tx, options),
  }));
  const decides = can(actor.context, 'autonomy.manage');
  return {
    actions: AutonomyActionSchema.options.map((action) => {
      const row = rows.find((r) => r.action === action);
      const correctInARow = row?.correctInARow ?? 0;
      return {
        action,
        doneLast30Days: row?.doneSince30 ?? 0,
        correctInARow,
        offer: decides ? earnedTrustOffer(action, autonomy, correctInARow) : null,
      };
    }),
  };
}

/**
 * The stored choices. The database only holds valid levels; should one stop being valid (an
 * action whose "just do it" is withdrawn), `resolveAutonomy` fails closed on it and a change
 * drops it.
 */
function ownChoices(
  row: { askFirst: boolean; levels: unknown } | undefined,
): { askFirst: boolean; levels: AutonomySettings } | undefined {
  if (row === undefined) return undefined;
  const stored = typeof row.levels === 'object' && row.levels !== null ? row.levels : {};
  const levels: AutonomySettings = {};
  for (const action of AutonomyActionSchema.options) {
    const level = (stored as Record<string, unknown>)[action];
    if (level === undefined) continue;
    // Kept as stored, even if no longer valid: resolveAutonomy turns that into "ask me".
    levels[action] = level as AutonomyLevel;
  }
  return { askFirst: row.askFirst, levels };
}

/** Only the levels the contracts accept today. */
function validLevels(levels: AutonomySettings): AutonomySettings {
  const valid: AutonomySettings = {};
  for (const [action, level] of Object.entries(levels)) {
    const parsed = AutonomySettingsSchema.safeParse({ [action]: level });
    if (parsed.success) Object.assign(valid, parsed.data);
  }
  return valid;
}

function sameChoices(
  a: { askFirst: boolean; levels: AutonomySettings },
  b: { askFirst: boolean; levels: AutonomySettings },
): boolean {
  if (a.askFirst !== b.askFirst) return false;
  return AutonomyActionSchema.options.every((action) => a.levels[action] === b.levels[action]);
}
