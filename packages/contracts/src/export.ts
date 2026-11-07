import { z } from 'zod';

// Business export (S51, ADR-0053, AC-W1-37, AC-W1-38): the owner downloads everything the
// business holds in Pepper as one ZIP. Its `clients.csv` and `visits.csv` use column names the
// import recognises, so they import back with nothing mapped by hand; the rest is JSON. Built
// on request: no copy is kept on the server.

/** The files in an export, in the order they are written, with what each one holds. */
export const BUSINESS_EXPORT_FILES = [
  { name: 'README.txt', holds: 'What each file holds' },
  { name: 'clients.csv', holds: 'Your clients, one per row: imports back into Pepper' },
  { name: 'visits.csv', holds: 'Every visit and appointment with its client: imports back' },
  { name: 'business.json', holds: 'Your business details, booking page and rules' },
  { name: 'team.json', holds: 'Your team, the services each offers, hours and time off' },
  { name: 'services.json', holds: 'Your menu: services, lengths and prices' },
  { name: 'clients.json', holds: 'Your clients with every detail' },
  { name: 'appointments.json', holds: 'Every appointment, including cancelled ones' },
  { name: 'waitlist.json', holds: 'Who is waiting for a time' },
  { name: 'pepper-knows.json', holds: 'What Pepper knows about your business and clients' },
  { name: 'support.json', holds: 'Your requests to the Pepper team, with every reply' },
] as const;
export type BusinessExportFileName = (typeof BUSINESS_EXPORT_FILES)[number]['name'];

/** What an export held, by kind: the audit entry's only details (never a client's). */
export const BusinessExportCountsSchema = z
  .object({
    clients: z.number().int().nonnegative(),
    visits: z.number().int().nonnegative(),
    services: z.number().int().nonnegative(),
    staff: z.number().int().nonnegative(),
    waitlist: z.number().int().nonnegative(),
    facts: z.number().int().nonnegative(),
  })
  .strict();
export type BusinessExportCounts = z.infer<typeof BusinessExportCountsSchema>;
