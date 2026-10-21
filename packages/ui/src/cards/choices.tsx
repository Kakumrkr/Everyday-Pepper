import type { BookingView, LocalSlot, ToolCard } from '@pepper/contracts';
import { useId, type ReactNode } from 'react';
import { buttonClass, cx } from '../class-names.js';
import { formatDate, formatTime, formatWhen } from './labels.js';

type DayCardModel = Extract<ToolCard, { kind: 'day' }>;

const CARD = 'flex max-w-[34rem] flex-col gap-3 rounded-lg border border-line bg-surface p-4';
const EYEBROW = 'm-0 text-xs font-bold tracking-wide text-ink-2 uppercase';

/**
 * Times to pick from (AC-W2-1): the nearest free ones instead of a taken time, or the free ones
 * asked for. The member picks; the AI never books a time nobody chose. Each time is a button.
 */
export function SlotPicker({
  slots,
  picked,
  disabled = false,
  onPick,
  note,
}: {
  slots: readonly LocalSlot[];
  /** The slot already chosen (it stays marked; the others are done). */
  picked?: LocalSlot | null;
  disabled?: boolean;
  onPick: (slot: LocalSlot) => void;
  note?: ReactNode;
}) {
  const headingId = useId();
  const done = disabled || (picked !== undefined && picked !== null);
  return (
    <section aria-labelledby={headingId} className={CARD}>
      <h3 id={headingId} className={EYEBROW}>
        Pick a time
      </h3>
      {slots.length === 0 ? (
        <p className="m-0 text-sm text-ink-2">No free times to offer.</p>
      ) : (
        <div role="group" aria-labelledby={headingId} className="grid grid-cols-2 gap-2">
          {slots.map((slot) => {
            const chosen =
              picked?.date === slot.date &&
              picked.time === slot.time &&
              picked.staffMemberId === slot.staffMemberId;
            return (
              <button
                key={`${slot.date}-${slot.time}-${slot.staffMemberId}`}
                type="button"
                aria-pressed={chosen}
                disabled={done}
                onClick={() => {
                  onPick(slot);
                }}
                className={cx(
                  'flex min-h-11 flex-col items-start rounded-md border-[1.5px] px-3 py-2 text-left',
                  'focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-brand',
                  chosen ? 'border-brand bg-brand-soft' : 'border-line bg-bg hover:border-brand',
                  done && !chosen ? 'opacity-60' : '',
                )}
              >
                <span className="font-bold tabular-nums">
                  {formatDate(slot.date)} · {formatTime(slot.time)}
                </span>
                <span className="text-xs text-ink-2">with {slot.staffName}</span>
              </button>
            );
          })}
        </div>
      )}
      {note === undefined ? null : <p className="m-0 text-xs text-ink-2">{note}</p>}
    </section>
  );
}

/** More than one client matches: the member picks (never the model's guess). */
export function ClientChoice({
  clients,
  picked,
  onPick,
}: {
  clients: readonly { clientId: string; name: string }[];
  picked?: string | null;
  onPick: (client: { clientId: string; name: string }) => void;
}) {
  const headingId = useId();
  const done = picked !== undefined && picked !== null;
  return (
    <section aria-labelledby={headingId} className={CARD}>
      <h3 id={headingId} className={EYEBROW}>
        Which one?
      </h3>
      <div role="group" aria-labelledby={headingId} className="flex flex-wrap gap-2">
        {clients.map((client) => (
          <button
            key={client.clientId}
            type="button"
            aria-pressed={picked === client.clientId}
            disabled={done}
            onClick={() => {
              onPick(client);
            }}
            className={buttonClass({
              variant: picked === client.clientId ? 'primary' : 'secondary',
              size: 'sm',
            })}
          >
            {client.name}
          </button>
        ))}
      </div>
    </section>
  );
}

/** One booking as a card shows it. */
export function BookingCard({ booking }: { booking: BookingView }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className={CARD}>
      <h3 id={headingId} className={EYEBROW}>
        Booking
      </h3>
      <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
        <dt className="text-ink-2">When</dt>
        <dd className="m-0 font-semibold">
          {formatWhen(booking.date, booking.time)}–{formatTime(booking.endTime)}
        </dd>
        <dt className="text-ink-2">Client</dt>
        <dd className="m-0">{booking.clientName}</dd>
        <dt className="text-ink-2">Service</dt>
        <dd className="m-0">
          {booking.serviceName} with {booking.staffName}
        </dd>
        <dt className="text-ink-2">Status</dt>
        <dd className="m-0">{booking.status}</dd>
      </dl>
    </section>
  );
}

/** One day's schedule: bookings by time, and blocked time. */
export function DayCard({ day, footer }: { day: DayCardModel; footer?: ReactNode }) {
  const headingId = useId();
  const items = [
    ...day.bookings.map((booking) => ({
      key: booking.bookingId,
      time: booking.time,
      line: `${booking.clientName} · ${booking.serviceName} · ${booking.staffName}`,
    })),
    ...day.blocked.map((block) => ({
      key: `${block.staffMemberId}-${block.from}`,
      time: block.from,
      line: `${block.staffName}: blocked until ${formatTime(block.to)}`,
    })),
  ].sort((a, b) => a.time.localeCompare(b.time));
  return (
    <section aria-labelledby={headingId} className={CARD}>
      <div className="flex items-center justify-between gap-2">
        <h3 id={headingId} className={EYEBROW}>
          {formatDate(day.date)}
        </h3>
        <span className="text-xs font-bold text-ink-2">{day.bookings.length} booked</span>
      </div>
      {items.length === 0 ? (
        <p className="m-0 text-sm text-ink-2">Nothing booked.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0 text-sm">
          {items.map((item) => (
            <li
              key={item.key}
              className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2 border-b border-line py-2 last:border-b-0"
            >
              <span className="font-semibold text-ink-2 tabular-nums">{formatTime(item.time)}</span>
              <span>{item.line}</span>
            </li>
          ))}
        </ul>
      )}
      {footer}
    </section>
  );
}

/**
 * A turn's writes together (S25 log: "a turn that produces several writes becomes one plan
 * card"): its changes, and one button that approves each one exactly as shown, in order.
 */
export function PlanCard({
  pending,
  busy = false,
  onApproveAll,
  children,
}: {
  /** How many of the changes still wait for an OK. */
  pending: number;
  busy?: boolean;
  onApproveAll?: () => void;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-lg bg-surface-2 p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={headingId} className={EYEBROW}>
          Plan
        </h3>
        {pending > 1 && onApproveAll !== undefined ? (
          <button
            type="button"
            disabled={busy}
            onClick={onApproveAll}
            className={buttonClass({ size: 'sm' })}
          >
            Approve all {pending}
          </button>
        ) : null}
      </div>
      {children}
    </section>
  );
}
