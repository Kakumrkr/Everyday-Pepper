import { AI_EMAIL_GRACE_SECONDS, AUTONOMY_ACTIONS, type AutonomyAction } from '@pepper/contracts';

// Until when an AI action can be undone (ADR-0028), fixed when it runs and stored with it, so
// the receipt can show it. `null`: it cannot be undone at all.

const MINUTE = 60_000;

/**
 * The end of `action`'s undo window for an action run at `now`: its minutes (never past the
 * appointment's start when the action touched one), or, for a message, the grace before it
 * leaves. `null` when the action has no inverse or the window would already be closed.
 */
export function undoUntil(
  action: AutonomyAction,
  now: Date,
  effect: { hasInverse: boolean; appointmentStartsAt: Date | null },
): Date | null {
  if (!effect.hasInverse) return null;
  const window = AUTONOMY_ACTIONS[action].undo;
  if (window.kind === 'until_sent') return new Date(now.getTime() + AI_EMAIL_GRACE_SECONDS * 1000);
  let until = now.getTime() + window.minutes * MINUTE;
  if (window.notAfterAppointmentStart && effect.appointmentStartsAt !== null) {
    until = Math.min(until, effect.appointmentStartsAt.getTime());
  }
  return until > now.getTime() ? new Date(until) : null;
}
