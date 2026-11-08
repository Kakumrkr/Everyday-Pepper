/**
 * The line above a support message, in both threads: who wrote it, when, and "by email" for a
 * member's emailed reply (S59.3, AC-X-39). Caption type, quiet ink; the writer in full ink.
 */
export function SupportMessageMeta({
  who,
  when,
  byEmail,
}: {
  who: string;
  when: string;
  byEmail: boolean;
}) {
  return (
    <span className="type-caption text-ink-2">
      <span className="font-semibold text-ink">{who}</span> ·{' '}
      <span className="tabular-nums">{when}</span>
      {byEmail && <span data-testid="support-message-by-email"> · by email</span>}
    </span>
  );
}
