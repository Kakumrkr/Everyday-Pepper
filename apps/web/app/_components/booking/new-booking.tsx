'use client';

import { BookingSchema, type AvailableSlot } from '@pepper/contracts';
import { buttonClass, Icon } from '@pepper/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { bookableStaff, type BookingSetup } from '../../../lib/booking';
import { sendJson } from '../../../lib/client-api';
import { ClientPicker, type ChosenClient } from './client-picker';
import { alternativesOf, Refusal } from './refusal';
import { Field, Notice, Sheet } from './sheet';
import { TimePicker } from './time-picker';

/**
 * "New booking" on the calendar: client, service, staff member and a time, then
 * `POST /v1/bookings`. A refused time shows the nearest free ones and the waitlist (AC-W2-1).
 * One idempotency key per opening, so a double tap or a retried request books once.
 */
export function NewBooking({ setup, date }: { setup: BookingSetup; date: string }) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState(0);
  return (
    <Sheet
      title="New booking"
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // A fresh form (and idempotency key) every time it opens.
        if (next) setKey((k) => k + 1);
      }}
      trigger={
        <button type="button" className={buttonClass({ size: 'sm' })}>
          <Icon name="plus" />
          New booking
        </button>
      }
    >
      <NewBookingForm
        key={key}
        setup={setup}
        date={date}
        onDone={() => {
          setOpen(false);
        }}
      />
    </Sheet>
  );
}

function NewBookingForm({
  setup,
  date: initialDate,
  onDone,
}: {
  setup: BookingSetup;
  date: string;
  onDone: () => void;
}) {
  const router = useRouter();
  const { timeZone, services, abilities } = setup;
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [client, setClient] = useState<ChosenClient | null>(null);
  const [serviceId, setServiceId] = useState(services[0]?.id ?? '');
  const offering = bookableStaff(setup.staff, {
    userId: setup.userId,
    ownOnly: abilities.ownStaffOnly,
    serviceId,
  });
  const [chosenStaff, setChosenStaff] = useState('');
  const staffMemberId = offering.some((m) => m.id === chosenStaff)
    ? chosenStaff
    : (offering[0]?.id ?? '');
  const [date, setDate] = useState(initialDate);
  const [startsAt, setStartsAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refused, setRefused] = useState<{ wanted: string; alternatives: AvailableSlot[] } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

  if (services.length === 0) {
    return <p className="m-0 text-ink-2">Add a service first; then you can book it here.</p>;
  }

  async function book(at: string): Promise<void> {
    if (client === null) return;
    setBusy(true);
    const answer = await sendJson('POST', '/v1/bookings', {
      clientId: client.client.id,
      ...(client.contact !== undefined && { clientContact: client.contact }),
      serviceId,
      staffMemberId,
      startsAt: at,
      idempotencyKey,
    });
    setBusy(false);
    if (answer.ok && BookingSchema.safeParse(answer.data).success) {
      onDone();
      router.refresh();
      return;
    }
    const alternatives = alternativesOf(answer);
    setRefused(alternatives === null ? null : { wanted: at, alternatives });
    setError(alternatives === null ? (answer.ok ? 'Something went wrong.' : answer.message) : null);
  }

  const ready = client !== null && staffMemberId !== '' && startsAt !== null;

  return (
    <div className="grid gap-5">
      <section aria-label="Client" className="grid gap-2">
        <h3 className="m-0 text-base font-bold">Client</h3>
        <ClientPicker
          managesClients={abilities.managesClients}
          value={client}
          onChange={(chosen) => {
            setClient(chosen);
            setRefused(null);
          }}
        />
      </section>

      <section aria-label="Appointment" className="grid gap-3">
        <h3 className="m-0 text-base font-bold">Appointment</h3>
        <Field label="Service">
          <select
            name="service"
            value={serviceId}
            onChange={(event) => {
              setServiceId(event.target.value);
              setStartsAt(null);
              setRefused(null);
            }}
          >
            {services.map((service) => (
              <option key={service.id} value={service.id}>
                {service.name} · {service.durationMinutes} min
              </option>
            ))}
          </select>
        </Field>
        {offering.length === 0 ? (
          <p className="m-0 text-ink-2" role="status">
            {!abilities.ownStaffOnly
              ? 'No one offers this service yet.'
              : 'You don’t offer this service. Ask an owner or manager to add it to your services.'}
          </p>
        ) : (
          <>
            <Field label="With">
              <select
                name="staff"
                value={staffMemberId}
                disabled={offering.length === 1}
                onChange={(event) => {
                  setChosenStaff(event.target.value);
                  setStartsAt(null);
                  setRefused(null);
                }}
              >
                {offering.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.displayName}
                  </option>
                ))}
              </select>
            </Field>
            <TimePicker
              timeZone={timeZone}
              serviceId={serviceId}
              staffMemberId={staffMemberId}
              date={date}
              onDateChange={setDate}
              value={startsAt}
              onChange={(at) => {
                setStartsAt(at);
                setRefused(null);
              }}
            />
          </>
        )}
      </section>

      {error === null ? null : <Notice tone="error">{error}</Notice>}
      {refused === null || client === null ? null : (
        <Refusal
          timeZone={timeZone}
          alternatives={refused.alternatives}
          busy={busy}
          onPick={(slot) => {
            setStartsAt(slot.startsAt);
            void book(slot.startsAt);
          }}
          waitlist={{
            entry: {
              clientId: client.client.id,
              ...(client.contact !== undefined && { clientContact: client.contact }),
              serviceId,
              staffMemberId,
            },
            wanted: refused.wanted,
            onAdded: () => {
              onDone();
              router.refresh();
            },
          }}
        />
      )}

      <button
        type="button"
        disabled={!ready || busy}
        className={buttonClass({ className: 'w-full' })}
        onClick={() => {
          if (startsAt !== null) void book(startsAt);
        }}
      >
        {busy ? 'Booking…' : 'Book'}
      </button>
    </div>
  );
}
