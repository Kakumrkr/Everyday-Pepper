'use client';

import {
  EveningWrapSchema,
  OperatorHeldListSchema,
  PilotMetricsSchema,
  SupportMailStopSchema,
  WeekValueSchema,
} from '@pepper/contracts';
import {
  Avatar,
  Badge,
  BottomTabBar,
  BriefingBlock,
  Button,
  Card,
  Checkbox,
  COLORS,
  DetailTable,
  Dialog,
  EmptyState,
  EveningWrap,
  formatMoney,
  IconButton,
  Input,
  List,
  ListRow,
  MoneyChip,
  Receipt,
  Segmented,
  Select,
  Sheet,
  Skeleton,
  Stat,
  StepBar,
  StickyActionBar,
  Switch,
  Tabs,
  WeekProof,
  Textarea,
  TimeChip,
  Toast,
  ToastProvider,
  TYPE_SCALE,
  type ColorToken,
  type TypeToken,
} from '@pepper/ui';
import { useState, type ReactNode } from 'react';
import { SupportMessageMeta } from '../../_components/support/message-meta';
import { OpsHeldList } from '../../_components/ops/ops-held';
import { OpsMetrics } from '../../_components/ops/ops-metrics';
import { OpsMailStopped } from '../../_components/ops/ops-mail-stopped';
import {
  BARBERS,
  BRIEFING,
  DARIUS_MOVE,
  DECISIONS,
  DONE,
  MARCUS,
  OVERDUE,
  SERVICES,
  SHOP,
  SHOP_TIME_ZONE,
  TIMES_TODAY,
  TOMORROW,
  VISITS,
  WEEK_PROOF,
} from './southside';

const TYPE_SAMPLES: Record<TypeToken, string> = {
  'number-xl': formatMoney(BRIEFING.bookedCents),
  display: `Morning, ${SHOP.owner}`,
  title: 'Move Darius Hill to 4:15?',
  heading: 'Needs your OK',
  subheading: 'Give 1:15 to Jaylen Brooks?',
  body: 'Chris cancelled. Jaylen is first on the waitlist.',
  label: 'Booked today · 12 visits',
  caption: 'Your note, Aug 11',
};

// Whole class names, so Tailwind finds them.
const TYPE_CLASS: Record<TypeToken, string> = {
  'number-xl': 'type-number-xl',
  display: 'type-display',
  title: 'type-title',
  heading: 'type-heading',
  subheading: 'type-subheading',
  body: 'type-body',
  label: 'type-label',
  caption: 'type-caption',
};

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-4">
      <h2 id={id} className="m-0 type-heading text-ink">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Row({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-3">{children}</div>;
}

export function Gallery() {
  const [barber, setBarber] = useState('both');
  const [time, setTime] = useState<string>('4:15');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [toastOpen, setToastOpen] = useState(false);
  const [paused, setPaused] = useState(false);

  const visits = VISITS.filter((visit) => barber === 'both' || visit.barber === barber);

  return (
    <ToastProvider>
      <div className="min-h-dvh bg-bg text-ink">
        <main className="mx-auto flex max-w-2xl flex-col gap-12 px-5 py-8">
          <header className="flex flex-col gap-2">
            <p className="m-0 type-label text-ink-2">Pepper · component gallery (S40)</p>
            <h1 className="m-0 type-display">{SHOP.name}</h1>
            <p className="m-0 type-body text-ink-2">
              Every part of the kit, on the made-up shop of the S39 mockups. {SHOP.today}.
            </p>
          </header>

          <Section id="type" title="Type">
            <div className="flex flex-col gap-3">
              {(Object.keys(TYPE_SCALE) as TypeToken[]).map((style) => (
                <div key={style} className="flex flex-col gap-0.5">
                  <span className="type-caption text-ink-3">{style}</span>
                  <span className={`${TYPE_CLASS[style]} tabular-nums`}>{TYPE_SAMPLES[style]}</span>
                </div>
              ))}
            </div>
          </Section>

          <Section id="colors" title="Colors">
            <ul className="m-0 grid list-none grid-cols-3 gap-3 p-0 desk:grid-cols-6">
              {(Object.keys(COLORS) as ColorToken[]).map((token) => (
                <li key={token} className="flex flex-col gap-1">
                  <span
                    className="h-12 rounded-sm border border-line"
                    style={{ background: `var(--${token})` }}
                  />
                  <span className="type-caption text-ink-2">{token}</span>
                </li>
              ))}
            </ul>
          </Section>

          <Section id="buttons" title="Buttons">
            <Row>
              <Button size="lg">Approve</Button>
              <Button>Book</Button>
              <Button size="sm">Send</Button>
            </Row>
            <Row>
              <Button variant="secondary">Not now</Button>
              <Button variant="quiet" icon="plus">
                Add a service
              </Button>
              <Button variant="danger">Cancel booking</Button>
            </Row>
            <Row>
              <Button busy>Saving</Button>
              <Button disabled>Book</Button>
              <IconButton icon="close" label="Close" />
              <IconButton icon="search" label="Search clients" variant="secondary" />
              <IconButton icon="plus" label="New booking" variant="primary" />
            </Row>
            <Button block size="lg">
              Approve and email Darius
            </Button>
          </Section>

          <Section id="fields" title="Fields">
            <Input label="Client name" defaultValue="Marcus Bell" autoComplete="off" />
            <Input
              label="Phone"
              hint="For reminders by text"
              defaultValue="312 555 01"
              error="That number is too short. US numbers have 10 digits."
              inputMode="tel"
            />
            <Select
              label="Barber"
              defaultValue="dre"
              options={BARBERS.map((b) => ({ value: b.key, label: b.name }))}
            />
            <Textarea label="Note" defaultValue={MARCUS.memory[0].fact} />
            <div className="flex flex-col">
              <Checkbox label="Email Darius about the new time" defaultChecked />
              <Checkbox label="Also text him" hint="Texts start in the SMS phase" />
              <Switch
                label="Pause suggestions"
                hint="Pepper stops proposing until you turn this off"
                checked={paused}
                onChange={(event) => {
                  setPaused(event.target.checked);
                }}
              />
              <Switch label="Morning briefing" defaultChecked />
            </div>
          </Section>

          <Section id="marks" title="Badges, money, avatars">
            <Row>
              <Badge>Walk-in</Badge>
              <Badge tone="brand">Regular</Badge>
              <Badge tone="ok">Confirmed</Badge>
              <Badge tone="warn">2 weeks overdue</Badge>
              <Badge tone="danger">No-show</Badge>
              <Badge tone="info">New client</Badge>
            </Row>
            <Row>
              <MoneyChip cents={4500} />
              <MoneyChip cents={27000} kind="estimate" />
              <MoneyChip cents={3500} kind="amount" />
            </Row>
            <Row>
              <Avatar name={MARCUS.name} size="lg" />
              <Avatar name={BARBERS[0].name} />
              <Avatar name={BARBERS[1].name} tone="accent" />
              <Avatar name="Jaylen Brooks" size="sm" />
            </Row>
            <div className="flex flex-col gap-2" aria-label="Loading" role="status">
              <Skeleton className="w-2/3" />
              <Skeleton className="w-1/2" />
              <Skeleton className="w-3/4" />
            </div>
          </Section>

          <Section id="home" title="Home: briefing and decisions">
            <BriefingBlock
              greeting={`Morning, ${SHOP.owner}`}
              value={formatMoney(BRIEFING.bookedCents)}
              valueLabel={`Booked today · ${String(BRIEFING.visits)} visits`}
              progress={BRIEFING.full}
              progressLabel={`${String(Math.round(BRIEFING.full * 100))}% full · ${String(BRIEFING.gaps)} gaps`}
            >
              <p className="m-0 type-body">Two gaps today. Fill them and that’s about $115 more.</p>
            </BriefingBlock>
            {DECISIONS.slice(0, 2).map((decision, index) => (
              <Card key={decision.title} labelledBy={`decision-${String(index)}`}>
                <div className="flex flex-col gap-3">
                  <div className="flex items-start justify-between gap-3">
                    <h3 id={`decision-${String(index)}`} className="m-0 type-subheading">
                      {decision.title}
                    </h3>
                    <MoneyChip cents={decision.cents} kind={decision.kind} />
                  </div>
                  <p className="m-0 type-body text-ink-2">{decision.why}</p>
                  {index === 1 && <DetailTable rows={DARIUS_MOVE} />}
                  <Row>
                    <Button>Approve</Button>
                    <Button variant="secondary">Not now</Button>
                    <Button variant="quiet">Why?</Button>
                  </Row>
                </div>
              </Card>
            ))}
            <Receipt undo={{ onUndo: () => undefined, until: '9:50' }}>
              Moved Sam Patel to Fri 10:00. He has the email.
            </Receipt>
            <List label="More that needs you">
              {DECISIONS.slice(2).map((decision) => (
                <ListRow
                  key={decision.title}
                  title={decision.title}
                  meta={decision.why}
                  trailing={<MoneyChip cents={decision.cents} kind={decision.kind} />}
                  href="#home"
                />
              ))}
            </List>
            <h3 className="m-0 type-subheading">Done for you</h3>
            <List label="Done for you">
              {DONE.map((item) => (
                <ListRow key={item.text} leading={item.time} title={item.text} />
              ))}
            </List>
          </Section>

          <Section id="proof" title="Home: the week and tomorrow">
            <EveningWrap evening={EveningWrapSchema.parse(TOMORROW)} timeZone={SHOP_TIME_ZONE} />
            <WeekProof week={WeekValueSchema.parse(WEEK_PROOF)} />
          </Section>

          <Section id="calendar" title="Calendar: today">
            <Segmented
              label="Whose calendar"
              value={barber}
              onValueChange={setBarber}
              options={[
                { value: 'both', label: 'Both' },
                { value: 'dre', label: 'Dre' },
                { value: 'randy', label: 'Randy' },
              ]}
            />
            <List label="Today’s visits">
              {visits.map((visit) => (
                <ListRow
                  key={`${visit.barber}-${visit.time}`}
                  leading={visit.time}
                  title={visit.client}
                  meta={`${visit.service}${barber === 'both' ? ` · ${visit.barber === 'dre' ? 'Dre' : 'Randy'}` : ''}`}
                  trailing={
                    <span className="type-label text-ink tabular-nums">
                      {formatMoney(visit.cents)}
                    </span>
                  }
                />
              ))}
            </List>
          </Section>

          <Section id="client" title="Client">
            <div className="flex items-center gap-4">
              <Avatar name={MARCUS.name} size="lg" />
              <div className="flex flex-col gap-1">
                <p className="m-0 type-display">{MARCUS.name}</p>
                <p className="m-0 type-caption text-ink-2">{MARCUS.since}</p>
              </div>
            </div>
            <div className="flex gap-8">
              <Stat value={formatMoney(MARCUS.spentCents)} label="Spent" />
              <Stat value={String(MARCUS.visits)} label="Visits" />
              <Stat value={String(MARCUS.noShows)} label="No-shows" />
            </div>
            <Tabs
              label={MARCUS.name}
              tabs={[
                {
                  value: 'visits',
                  label: 'Visits',
                  content: (
                    <List label="Visits">
                      {MARCUS.history.map((visit) => (
                        <ListRow
                          key={visit.date}
                          leading={visit.date}
                          title={visit.service}
                          trailing={
                            <span className="type-label tabular-nums">
                              {formatMoney(visit.cents)}
                            </span>
                          }
                        />
                      ))}
                    </List>
                  ),
                },
                {
                  value: 'memory',
                  label: 'What I know',
                  content: (
                    <List label="What I know">
                      {MARCUS.memory.map((item) => (
                        <ListRow key={item.fact} title={item.fact} meta={item.source} />
                      ))}
                    </List>
                  ),
                },
              ]}
            />
            <h3 className="m-0 type-subheading">Overdue regulars</h3>
            <List label="Overdue regulars">
              {OVERDUE.map((client) => (
                <ListRow
                  key={client.name}
                  title={client.name}
                  meta={client.meta}
                  trailing={<Badge tone="warn">Overdue</Badge>}
                  href="#client"
                />
              ))}
            </List>
          </Section>

          <Section id="booking" title="Booking page">
            <StepBar steps={['Service', 'Time', 'Your details']} current={1} />
            <List label="Services">
              {SERVICES.slice(0, 3).map((service) => (
                <ListRow
                  key={service.name}
                  title={service.name}
                  meta={`${String(service.minutes)} min`}
                  trailing={
                    <span className="type-label tabular-nums">{formatMoney(service.cents)}</span>
                  }
                />
              ))}
            </List>
            <p className="m-0 type-label text-ink-2">Today, Tue Oct 27</p>
            <Row>
              {TIMES_TODAY.map((slot) => (
                <TimeChip
                  key={slot}
                  time={slot}
                  selected={slot === time}
                  onSelect={() => {
                    setTime(slot);
                  }}
                />
              ))}
            </Row>
            <StickyActionBar
              placement="inline"
              summary={`Skin fade · Today ${time} · $45`}
              back={{ label: 'Back', onClick: () => undefined }}
              primary={<Button>Book</Button>}
            />
            <p className="m-0 type-caption text-ink-3">{SHOP.cancellation}</p>
          </Section>

          <Section id="support" title="Support: a reply by email">
            {/* S59.3 (AC-X-39): the line both threads show above a member's emailed reply. */}
            <div className="flex flex-col items-end gap-1">
              <SupportMessageMeta who="You" when="Today, 10:04 AM" byEmail />
              <p className="m-0 max-w-11/12 rounded-lg bg-brand-soft px-4 py-3 type-body break-words whitespace-pre-wrap text-ink">
                Pulled down to refresh and the calendar shows my bookings again. Thanks!
              </p>
            </div>
            <div className="flex flex-col items-start gap-1">
              <SupportMessageMeta who="Pepper team" when="Today, 10:02 AM" byEmail={false} />
              <p className="m-0 max-w-11/12 rounded-lg border border-line bg-surface px-4 py-3 type-body break-words whitespace-pre-wrap text-ink">
                Pull down on the calendar to refresh it.
              </p>
            </div>
          </Section>

          <Section id="support-held" title="Support: held mail and stopped mail">
            {/* S59.3.2 (AC-X-43/44): the console's held review and a requester whose mail stopped. */}
            <OpsHeldList
              initial={OperatorHeldListSchema.parse({
                items: [
                  {
                    id: '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708190',
                    reason: 'unverified_sender',
                    kind: 'new_request',
                    from: 'maya.salon.owner@example.com',
                    subject: 'Can’t move a booking',
                    text: 'When I drag Maria’s 3pm to 4pm nothing happens. <b>Help</b>',
                    business: null,
                    reference: null,
                    heldSince: '2026-11-08T09:00:00.000Z',
                  },
                  {
                    id: '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708191',
                    reason: 'unknown_sender',
                    kind: 'reply',
                    from: 'front.desk@juniper.example',
                    subject: null,
                    text: 'Forwarding for Jess: the calendar is still empty.',
                    business: 'Juniper Hair Studio',
                    reference: 'PEP-7K2M9Q',
                    heldSince: '2026-11-08T11:00:00.000Z',
                  },
                ],
              })}
            />
            <OpsMailStopped
              stop={SupportMailStopSchema.parse({
                reason: 'bounced',
                since: '2026-11-08T10:00:00.000Z',
              })}
              busy={false}
              onResume={() => undefined}
            />
          </Section>

          <Section id="ops-metrics" title="Support: pilot metrics">
            {/* S59.4 (AC-X-47…49): each judgement once, first reply with email's share. */}
            <OpsMetrics
              metrics={PilotMetricsSchema.parse({
                days: 7,
                since: '2026-11-01T12:00:00.000Z',
                until: '2026-11-08T12:00:00.000Z',
                businesses: 4,
                bookableBusinesses: 3,
                metrics: [
                  { key: 'onboarding_completion', value: 80, sample: 10, status: 'met' },
                  { key: 'time_to_bookable', value: 9, sample: 8, status: 'met' },
                  { key: 'time_to_first_booking', value: 22, sample: 5, status: 'missed' },
                  { key: 'booking_completion', value: 65, sample: 20, status: 'met' },
                  { key: 'code_step_drop_off', value: 20, sample: 15, status: 'missed' },
                  { key: 'no_show_rate', value: 5, sample: 40, status: 'tracked' },
                  { key: 'fill_rate', value: 33.3, sample: 6, status: 'tracked' },
                  { key: 'waitlist_conversion', value: 50, sample: 4, status: 'not_enough' },
                  { key: 'support_requests', value: 0.7, sample: 3, status: 'met' },
                  { key: 'first_reply_time', value: 95.6, sample: 5, status: 'met' },
                ],
                firstReply: {
                  requests: 6,
                  answered: 5,
                  answeredWithinDay: 5,
                  waiting: 1,
                  waitingOverDay: 0,
                  medianMinutes: 95.6,
                  slowestMinutes: 600,
                  publicAnswered: 1,
                  publicOpen: 1,
                },
                channels: {
                  requestsInApp: 4,
                  requestsByEmail: 2,
                  publicByForm: 1,
                  publicByEmail: 1,
                  repliesInApp: 3,
                  repliesByEmail: 1,
                  inboundHeld: 1,
                  inboundIgnored: 2,
                  inboundRefused: 0,
                },
              })}
            />
          </Section>

          <Section id="empty" title="Empty states">
            <EmptyState
              icon="clients"
              title="No one on the waitlist"
              body="When a day is full, clients can ask to hear about openings. Share your booking page to start."
              action={{ label: 'Copy the booking link', onClick: () => undefined }}
            />
            <EmptyState
              icon="services"
              title="No services yet"
              body="Add what you offer and clients can book it."
              action={{ label: 'Add your first service', href: '#empty' }}
            />
          </Section>

          <Section id="overlays" title="Sheets, dialogs and toasts">
            <Row>
              <Sheet
                open={sheetOpen}
                onOpenChange={setSheetOpen}
                title="Move Darius Hill to 4:15?"
                description="Keeps a $35 visit. 11 visits, never missed one."
                trigger={<Button>Review the move</Button>}
                footer={
                  <>
                    <Button
                      block
                      size="lg"
                      onClick={() => {
                        setSheetOpen(false);
                        setToastOpen(true);
                      }}
                    >
                      Approve
                    </Button>
                    <Button
                      block
                      variant="quiet"
                      onClick={() => {
                        setSheetOpen(false);
                      }}
                    >
                      Not now
                    </Button>
                  </>
                }
              >
                <DetailTable rows={DARIUS_MOVE} />
              </Sheet>
              <Dialog
                open={dialogOpen}
                onOpenChange={setDialogOpen}
                title="Remove Line-up from your menu?"
                description="Clients can't book it any more. Booked visits stay."
                trigger={<Button variant="danger">Remove a service</Button>}
                footer={
                  <>
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setDialogOpen(false);
                      }}
                    >
                      Keep it
                    </Button>
                    <Button
                      variant="danger"
                      onClick={() => {
                        setDialogOpen(false);
                      }}
                    >
                      Remove
                    </Button>
                  </>
                }
              >
                {null}
              </Dialog>
              <Button
                variant="secondary"
                onClick={() => {
                  setToastOpen(true);
                }}
              >
                Show a toast
              </Button>
            </Row>
            <Toast
              open={toastOpen}
              onOpenChange={setToastOpen}
              title="Moved Darius Hill to 4:15. He has the email."
              action={{ label: 'Undo', altText: 'Undo the move', onClick: () => undefined }}
            />
          </Section>

          <Section id="tabs" title="Bottom tabs">
            <BottomTabBar
              placement="inline"
              current="home"
              items={[
                { key: 'home', label: 'Home', icon: 'home', href: '#tabs' },
                { key: 'calendar', label: 'Calendar', icon: 'calendar', href: '#calendar' },
                { key: 'clients', label: 'Clients', icon: 'clients', href: '#client' },
                { key: 'chat', label: 'Chat', icon: 'chat', href: '#tabs' },
                { key: 'more', label: 'More', icon: 'more', href: '#tabs' },
              ]}
            />
          </Section>
        </main>
      </div>
    </ToastProvider>
  );
}
