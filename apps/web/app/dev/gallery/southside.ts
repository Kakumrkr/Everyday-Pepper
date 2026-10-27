// Southside Cuts, the made-up two-barber shop of the S39 mockups (docs/mockups/s39/canvas/M*),
// so the kit is judged on real content (S39 retro, AC-X-4). The numbers add up: Dre's and
// Randy's visits today come to $430 over 12 visits. Money in cents; times as the shop shows them.

export const SHOP = {
  name: 'Southside Cuts',
  owner: 'Dre',
  address: '2418 S Halsted St, Chicago',
  phone: '(312) 555-0148',
  today: 'Tuesday, October 27',
  cancellation: 'Free to cancel or move up to 12 hours before.',
} as const;

export const BARBERS = [
  { key: 'dre', name: 'Dre Carter' },
  { key: 'randy', name: 'Randy' },
] as const;

export type BarberKey = (typeof BARBERS)[number]['key'];

export const SERVICES = [
  { name: 'Haircut', minutes: 30, cents: 3500 },
  { name: 'Skin fade', minutes: 45, cents: 4500 },
  { name: 'Haircut and beard', minutes: 45, cents: 5500 },
  { name: 'Beard trim', minutes: 15, cents: 2000 },
  { name: 'Line-up', minutes: 15, cents: 1500 },
  { name: 'Hot towel shave', minutes: 45, cents: 4500 },
  { name: 'Buzz cut', minutes: 15, cents: 2000 },
  { name: "Kid's cut", minutes: 30, cents: 2500 },
] as const;

export interface Visit {
  barber: BarberKey;
  time: string;
  client: string;
  service: string;
  cents: number;
}

/** Today's booked visits: 12, $430. */
export const VISITS: readonly Visit[] = [
  { barber: 'dre', time: '9:00', client: 'Kevin Nguyen', service: 'Haircut', cents: 3500 },
  { barber: 'dre', time: '9:45', client: 'Andre Wallace', service: 'Skin fade', cents: 4500 },
  {
    barber: 'dre',
    time: '10:30',
    client: "Mike O'Connor",
    service: 'Haircut and beard',
    cents: 5500,
  },
  {
    barber: 'dre',
    time: '11:30',
    client: 'Jordan Ellis',
    service: 'Hot towel shave',
    cents: 4500,
  },
  { barber: 'dre', time: '2:30', client: 'Darius Hill', service: 'Haircut', cents: 3500 },
  { barber: 'dre', time: '3:15', client: 'Nate Simmons', service: 'Line-up', cents: 1500 },
  { barber: 'dre', time: '5:00', client: 'Eli Romero', service: "Kid's cut", cents: 2500 },
  { barber: 'randy', time: '10:00', client: 'Brandon Lee', service: 'Skin fade', cents: 4500 },
  { barber: 'randy', time: '11:00', client: 'Omar Haddad', service: 'Beard trim', cents: 2000 },
  { barber: 'randy', time: '1:00', client: 'Victor Diaz', service: 'Haircut', cents: 3500 },
  {
    barber: 'randy',
    time: '3:00',
    client: 'Ray Thompson',
    service: 'Haircut and beard',
    cents: 5500,
  },
  { barber: 'randy', time: '4:30', client: 'Jamal Price', service: 'Buzz cut', cents: 2000 },
];

export const BRIEFING = {
  bookedCents: 43000,
  visits: 12,
  full: 0.78,
  gaps: 2,
} as const;

/** "Needs your OK", most money first. */
export const DECISIONS = [
  {
    title: 'Give 1:15 to Jaylen Brooks?',
    cents: 4500,
    kind: 'gain',
    why: 'Chris cancelled. Jaylen is first on the waitlist; the offer is open until 11:20.',
  },
  {
    title: 'Move Darius Hill to 4:15?',
    cents: 3500,
    kind: 'gain',
    why: 'He emailed at 9:12: “Stuck at work, anything after 4?”',
  },
  {
    title: '6 regulars are 2 weeks overdue',
    cents: 27000,
    kind: 'estimate',
    why: 'Marcus, Tony, Luis and 3 more usually come every 3 weeks.',
  },
  {
    title: 'Randy is open Thu 9–12. Tell his 8 regulars?',
    cents: 13500,
    kind: 'estimate',
    why: 'Thursday mornings have filled within a day the last three times.',
  },
] as const;

/** The approval detail of Darius's move (the S39 approval card). */
export const DARIUS_MOVE = [
  { label: 'Time', value: 'Today 2:30 → 4:15' },
  { label: 'Service', value: 'Haircut, 30 min' },
  { label: "Who's told", value: 'Darius gets an email about the new time.' },
  { label: 'Then', value: '2:30 opens, and I offer it to the waitlist.' },
] as const;

/** "Done for you". */
export const DONE = [
  { time: '8:41', text: 'Moved Sam Patel to Fri 10:00' },
  { time: '8:00', text: 'Reminded 9 clients about today' },
  { time: 'Night', text: 'Confirmed 4 new bookings' },
] as const;

export const OVERDUE = [
  { name: 'Marcus Bell', meta: 'Usually every 3 weeks · last Sep 22', cents: 6000 },
  { name: 'Tony Russo', meta: 'Usually every 2 weeks · last Oct 6', cents: 3500 },
  { name: 'Luis Ortega', meta: 'Usually every 3 weeks · last Sep 29', cents: 4500 },
] as const;

export const MARCUS = {
  name: 'Marcus Bell',
  since: 'Client since March 2024 · usually with Dre',
  spentCents: 108000,
  visits: 18,
  noShows: 0,
  next: 'Sat Oct 31, 10:00 · Skin fade + beard trim · $60',
  history: [
    { date: 'Sep 22', service: 'Skin fade + beard with Dre', cents: 6000 },
    { date: 'Aug 29', service: 'Skin fade + beard with Dre', cents: 6000 },
    { date: 'Aug 8', service: 'Skin fade with Randy', cents: 4500 },
    { date: 'Jul 18', service: 'Skin fade + beard with Dre', cents: 6000 },
  ],
  memory: [
    { fact: '#2 on the sides, scissors on top, short beard', source: 'Your note, Aug 11' },
    { fact: 'Saturday mornings, or weekdays after 5', source: 'From his last 12 bookings' },
    { fact: 'Avoid menthol aftershave', source: 'Told Pepper, Jun 3' },
  ],
} as const;

export const TIMES_TODAY = ['3:30', '3:45', '4:00', '4:15'] as const;
