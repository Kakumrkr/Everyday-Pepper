import type { BookingView, LocalSlot, ToolCard } from '@pepper/contracts';
import { useId, type ReactNode } from 'react';
import { cx } from '../class-names.js';
import { DetailTable, List, ListRow } from '../kit/blocks.js';
import { Button, FOCUS_RING } from '../kit/button.js';
import { formatDate, formatTime, formatWhen } from './labels.js';

type DayCardModel = Extract<ToolCard, { kind: 'day' }>;

// On the kit (S41): a card that asks the member to pick is raised ("this needs you"); one that
// only shows something is flat with a hairline (DESIGN.md §2).
const CARD = 'flex max-w-[34rem] flex-col gap-3 rounded-lg bg-surface p-5';
const ASKS = cx(CARD, 'shadow-raised');
const SHOWS = cx(CARD, 'border border-line');
const EYEBROW = 'm-0 type-label text-ink-2';

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
    <section aria-labelledby={headingId} className={done ? SHOWS : ASKS}>
      <h3 id={headingId} className={EYEBROW}>
        Pick a time
      </h3>
      {slots.length === 0 ? (
        <p className="m-0 type-body text-ink-2">No free times to offer.</p>
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
                  'flex min-h-13 flex-col items-start justify-center rounded-md border px-3 py-2 text-left text-ink',
                  'transition motion-fast ease-standard',
                  FOCUS_RING,
                  chosen
                    ? 'border-brand bg-brand-soft'
                    : 'border-line-strong bg-surface hover:bg-surface-2',
                  done && !chosen ? 'opacity-60' : '',
                )}
              >
                <span className="type-label tabular-nums">
                  {formatDate(slot.date)} · {formatTime(slot.time)}
                </span>
                <span className="type-caption text-ink-2">with {slot.staffName}</span>
              </button>
            );
          })}
        </div>
      )}
      {note === undefined ? null : <p className="m-0 type-caption text-ink-2">{note}</p>}
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
    <section aria-labelledby={headingId} className={done ? SHOWS : ASKS}>
      <h3 id={headingId} className={EYEBROW}>
        Which one?
      </h3>
      <div role="group" aria-labelledby={headingId} className="flex flex-wrap gap-2">
        {clients.map((client) => (
          <Button
            key={client.clientId}
            aria-pressed={picked === client.clientId}
            disabled={done}
            onClick={() => {
              onPick(client);
            }}
            variant={picked === client.clientId ? 'primary' : 'secondary'}
            size="sm"
          >
            {client.name}
          </Button>
        ))}
      </div>
    </section>
  );
}

/** One booking as a card shows it. */
export function BookingCard({ booking }: { booking: BookingView }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className={SHOWS}>
      <h3 id={headingId} className={EYEBROW}>
        Booking
      </h3>
      <DetailTable
        rows={[
          {
            label: 'When',
            value: (
              <span className="font-semibold tabular-nums">
                {formatWhen(booking.date, booking.time)}–{formatTime(booking.endTime)}
              </span>
            ),
          },
          { label: 'Client', value: booking.clientName },
          { label: 'Service', value: `${booking.serviceName} with ${booking.staffName}` },
          { label: 'Status', value: booking.status },
        ]}
      />
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
      title: booking.clientName,
      meta: `${booking.serviceName} · ${booking.staffName}`,
    })),
    ...day.blocked.map((block) => ({
      key: `${block.staffMemberId}-${block.from}`,
      time: block.from,
      title: block.staffName,
      meta: `Blocked until ${formatTime(block.to)}`,
    })),
  ].sort((a, b) => a.time.localeCompare(b.time));
  return (
    <section aria-labelledby={headingId} className={SHOWS}>
      <div className="flex items-center justify-between gap-2">
        <h3 id={headingId} className={EYEBROW}>
          {formatDate(day.date)}
        </h3>
        <span className="type-caption text-ink-2 tabular-nums">{day.bookings.length} booked</span>
      </div>
      {items.length === 0 ? (
        <p className="m-0 type-body text-ink-2">Nothing booked.</p>
      ) : (
        <List>
          {items.map((item) => (
            <ListRow
              key={item.key}
              leading={formatTime(item.time)}
              title={item.title}
              meta={item.meta}
            />
          ))}
        </List>
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
          <Button size="sm" icon="check" busy={busy} onClick={onApproveAll}>
            Approve all {pending}
          </Button>
        ) : null}
      </div>
      {children}
    </section>
  );
}
