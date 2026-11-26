'use client';

import {
  BookingSchema,
  BookingSeriesResultSchema,
  type AvailableSlot,
  type BookingSeriesResult,
} from '@pepper/contracts';
import { Button, buttonStyle, Icon, Select, Sheet, SheetFooter } from '@pepper/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { bookableStaff, bookingRequest, type BookingSetup } from '../../../lib/booking';
import { bookedLines, bookLabel, visitsToBook, withPick } from '../../../lib/booking-series';
import { sendJson } from '../../../lib/client-api';
import { ClientPicker, type ChosenClient, type PickedClient } from './client-picker';
import { NotifyClient } from './notify-client';
import { alternativesOf, Refusal } from './refusal';
import { Notice } from '../form-parts';
import { NO_REPEAT, RepeatPicker, SeriesDates, useSeriesPreview } from './repeat-visits';
import { TimePicker } from './time-picker';

/**
 * "New booking" on the calendar (or "Book" on a client's profile, with the client chosen):
 * client, service, staff member and a time, then `POST /v1/bookings`. A refused time shows the
 * nearest free ones and the waitlist (AC-W2-1). One idempotency key per opening, so a double
 * tap or a retried request books once. The client gets a confirmation email with their
 * reschedule/cancel link unless the team unticks it (ADR-0025). On the kit (S42.2): Book sits
 * in the sheet's footer, within thumb reach (D3). "Book again" from an import's times taken
 * (S50, AC-W1-33) opens it at once with the visit's service and staff member chosen. "Repeat"
 * (S72, AC-X-187) checks every date of a regular's visits, books the free ones (and a nearby
 * time tapped for a taken one) in one go, and emails the client once with every date.
 */
export function NewBooking({
  setup,
  date,
  client,
  defaultOpen = false,
  preset,
}: {
  setup: BookingSetup;
  date: string;
  client?: ChosenClient;
  /** Open on arrival (the profile's `?book=1`). */
  defaultOpen?: boolean;
  /** The service and staff member to start from, when they are still bookable. */
  preset?: BookingPreset;
}) {
  const [open, setShown] = useState(defaultOpen);
  const setOpen = (next: boolean) => {
    setShown(next);
    // Opened by the address (`?book=1`): closing it drops that, so a reload doesn't reopen it.
    if (!next && defaultOpen) window.history.replaceState(null, '', window.location.pathname);
  };
  const [key, setKey] = useState(0);
  return (
    <Sheet
      title={client === undefined ? 'New booking' : `Book ${client.client.name}`}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // A fresh form (and idempotency key) every time it opens.
        if (next) setKey((k) => k + 1);
      }}
      trigger={
        <button type="button" className={buttonStyle({ size: 'sm' })}>
          <Icon name="plus" />
          {client === undefined ? 'New booking' : 'Book'}
        </button>
      }
    >
      <NewBookingForm
        key={key}
        setup={setup}
        date={date}
        client={client ?? null}
        preset={preset}
        onDone={() => {
          setOpen(false);
        }}
      />
    </Sheet>
  );
}

/** A service and staff member a Book starts from (ids; unknown ones fall back). */
export interface BookingPreset {
  serviceId?: string | undefined;
  staffMemberId?: string | undefined;
}

function NewBookingForm({
  setup,
  date: initialDate,
  client: initialClient,
  preset,
  onDone,
}: {
  setup: BookingSetup;
  date: string;
  client: ChosenClient | null;
  preset: BookingPreset | undefined;
  onDone: () => void;
}) {
  const router = useRouter();
  const { timeZone, services, abilities } = setup;
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [client, setClient] = useState<PickedClient | null>(initialClient);
  const [serviceId, setServiceId] = useState(
    services.find((service) => service.id === preset?.serviceId)?.id ?? services[0]?.id ?? '',
  );
  const offering = bookableStaff(setup.staff, {
    userId: setup.userId,
    ownOnly: abilities.ownStaffOnly,
    serviceId,
  });
  // A preset staff member who doesn't offer the service (or isn't bookable) falls back below.
  const [chosenStaff, setChosenStaff] = useState(preset?.staffMemberId ?? '');
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
  const [notifyClient, setNotifyClient] = useState(true);
  const [repeat, setRepeatChoice] = useState(NO_REPEAT);
  // A time picked for a date that isn't free, by the date's place in the repeat.
  const [picks, setPicks] = useState<Record<number, string>>({});
  const [booked, setBooked] = useState<BookingSeriesResult | null>(null);
  // A walk-in isn't a client until booked: they come back as a client for a repeat.
  const repeats = repeat.everyWeeks > 0 && client !== null && !('walkIn' in client);
  const { preview, error: previewError } = useSeriesPreview({
    serviceId,
    staffMemberId,
    startsAt,
    repeat: repeats ? repeat : NO_REPEAT,
  });
  const visits = preview === null ? [] : visitsToBook(preview, picks);

  if (services.length === 0) {
    return (
      <p className="m-0 type-body text-ink-2">Add a service first; then you can book it here.</p>
    );
  }

  async function bookSeries(): Promise<void> {
    if (client === null || 'walkIn' in client) return;
    setBusy(true);
    const answer = await sendJson('POST', '/v1/bookings/series', {
      clientId: client.client.id,
      ...(client.contact !== undefined && { clientContact: client.contact }),
      serviceId,
      staffMemberId,
      everyWeeks: repeat.everyWeeks,
      startsAts: visits,
      idempotencyKey,
      notifyClient,
    });
    setBusy(false);
    const result = answer.ok ? BookingSeriesResultSchema.safeParse(answer.data) : null;
    if (result?.success === true) {
      router.refresh();
      // Every date booked: done. Some taken meanwhile: say which before closing.
      if (result.data.skipped.length === 0) onDone();
      else setBooked(result.data);
      return;
    }
    setError(
      alternativesOf(answer) !== null
        ? 'None of these dates can be booked any more. Pick another time.'
        : answer.ok
          ? 'Something went wrong.'
          : answer.message,
    );
  }

  async function book(at: string): Promise<void> {
    if (client === null) return;
    setBusy(true);
    const { path, body } = bookingRequest(
      'walkIn' in client ? client : { clientId: client.client.id, contact: client.contact },
      { serviceId, staffMemberId, startsAt: at, idempotencyKey, notifyClient },
    );
    const answer = await sendJson('POST', path, body);
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

  const ready =
    client !== null &&
    staffMemberId !== '' &&
    startsAt !== null &&
    (!repeats || visits.length >= 2);

  if (booked !== null) {
    return (
      <div className="grid gap-4" data-testid="series-booked">
        {bookedLines(booked, timeZone).map((line) => (
          <p key={line} className="m-0 type-body text-ink" role="status">
            {line}
          </p>
        ))}
        <SheetFooter>
          <Button block size="lg" onClick={onDone}>
            Done
          </Button>
        </SheetFooter>
      </div>
    );
  }

  return (
    // One column that never grows past the sheet (`grid-cols-1` is minmax(0, 1fr)).
    <div className="grid grid-cols-1 gap-5">
      <section aria-label="Client" className="grid min-w-0 grid-cols-1 gap-2">
        <h3 className="m-0 type-subheading text-ink">Client</h3>
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
        <h3 className="m-0 type-subheading text-ink">Appointment</h3>
        <Select
          label="Service"
          name="service"
          value={serviceId}
          options={services.map((service) => ({
            value: service.id,
            label: `${service.name} · ${String(service.durationMinutes)} min`,
          }))}
          onChange={(event) => {
            setServiceId(event.target.value);
            setStartsAt(null);
            setRefused(null);
          }}
        />
        {offering.length === 0 ? (
          <p className="m-0 type-body text-ink-2" role="status">
            {!abilities.ownStaffOnly
              ? 'No one offers this service yet.'
              : 'You don’t offer this service. Ask an owner or manager to add it to your services.'}
          </p>
        ) : (
          <>
            <Select
              label="With"
              name="staff"
              value={staffMemberId}
              disabled={offering.length === 1}
              options={offering.map((member) => ({ value: member.id, label: member.displayName }))}
              onChange={(event) => {
                setChosenStaff(event.target.value);
                setStartsAt(null);
                setRefused(null);
              }}
            />
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
                setPicks({});
              }}
            />
            {client !== null && 'walkIn' in client ? null : (
              <RepeatPicker
                value={repeat}
                onChange={(next) => {
                  setRepeatChoice(next);
                  setPicks({});
                  setError(null);
                }}
              />
            )}
            {repeats && startsAt !== null ? (
              <SeriesDates
                timeZone={timeZone}
                preview={preview}
                error={previewError}
                count={repeat.count}
                picks={picks}
                onPick={(index, at) => {
                  setPicks((current) => withPick(current, index, at));
                }}
              />
            ) : null}
            {repeats && preview !== null && visits.length < 2 ? (
              <p className="m-0 type-body text-ink-2" role="status">
                Fewer than two of these dates can be booked. Pick another time, or choose “Doesn’t
                repeat” to book one visit.
              </p>
            ) : null}
          </>
        )}
      </section>

      {client === null ? null : ('walkIn' in client ? client.walkIn : client.client).email ===
        null ? (
        <p className="m-0 type-body text-ink-2">
          No email address on file, so no confirmation is sent.
        </p>
      ) : (
        <NotifyClient checked={notifyClient} onChange={setNotifyClient}>
          {repeats
            ? 'Email the client one confirmation with every date'
            : 'Email the client a confirmation'}
        </NotifyClient>
      )}

      {refused === null || client === null || repeats ? null : (
        <Refusal
          timeZone={timeZone}
          alternatives={refused.alternatives}
          busy={busy}
          onPick={(slot) => {
            setStartsAt(slot.startsAt);
            void book(slot.startsAt);
          }}
          // A walk-in isn't a client until booked, so the waitlist can't hold them yet.
          waitlist={
            'walkIn' in client
              ? undefined
              : {
                  entry: {
                    clientId: client.client.id,
                    ...(client.contact !== undefined && { clientContact: client.contact }),
                    serviceId,
                    staffMemberId,
                  },
                  wanted: refused.wanted,
                  minutes: services.find((s) => s.id === serviceId)?.durationMinutes ?? 60,
                  onAdded: () => {
                    onDone();
                    router.refresh();
                  },
                }
          }
        />
      )}

      <SheetFooter>
        {error === null ? null : <Notice tone="error">{error}</Notice>}
        <Button
          block
          size="lg"
          disabled={!ready}
          busy={busy}
          onClick={() => {
            if (repeats) void bookSeries();
            else if (startsAt !== null) void book(startsAt);
          }}
        >
          {busy ? 'Booking…' : repeats ? bookLabel(visits.length) : 'Book'}
        </Button>
      </SheetFooter>
    </div>
  );
}
