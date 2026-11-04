# ADR-0053: The business export

- **Status:** Accepted (built in S51). Approved by the user at the S51 brief on 2026-11-04 ("Pre approved with ur recommendation"; D-1 split, D-2 `fflate`, D-3 owner only, D-4 built on request, D-5 this ADR).
- **Date:** 2026-11-04
- **Builds on:**
  - ADR-0049 and ADR-0050 (the client and visits import: presets, `system`, matching by external id, email, phone and name)
  - ADR-0051 (a deleted client keeps a row as "Deleted client", forgotten everywhere else)
  - ADR-0013 (the permission matrix), ADR-0002 (RLS)
  - [V1 playbook](../plan/v1-playbook.md) Phase 11, S51; [scorecard](../plan/scorecard.md) C11, C13; AC-W1-37, AC-W1-38

## Context
"We move you" (C13) has a second half: an owner can leave with everything, and trust Pepper more because of it. The export must be complete enough to start again elsewhere, readable without Pepper (a spreadsheet), and, so the promise is checkable, it must import back into Pepper itself. It holds every client's contact details at once, so who may take it, what is kept and what reaches the logs matter as much as the format.

## Decision
1. **One ZIP, made on request (D-4).** `GET /v1/tenant/export` reads the business in one transaction (`readBusinessExport` in `@pepper/db`), builds the files in memory (`buildBusinessExport` in `@pepper/imports`) and answers them as `application/zip`, `content-disposition: attachment` (`pepper-export-<slug>-<date>.zip`, the date in the business's zone), `cache-control: no-store`, `nosniff`. Nothing is written to storage or a queue: there is no copy to leak or expire. The size is bounded by the business (the import's own limits are 10,000 clients a file); a background job with an emailed link is for later, when a business outgrows a 60 s answer (the web proxy's limit for this path).
2. **The owner only (D-3).** A new permission, `business.export`, is OWNER_ONLY in the matrix: managers can see clients one at a time but not take the list away. The screen is offered only to the owner and the api decides again (403 otherwise). 10 exports an hour per user. Audited as `business.exported` with counts only (clients, visits, services, staff, waitlist, facts), never a detail.
3. **What it holds.** `README.txt`; `clients.csv` and `visits.csv` (below); `business.json` (details, booking page, rules), `team.json` (each member with the services they offer, hours and time off), `services.json`, `clients.json`, `appointments.json` (every status), `waitlist.json` and `pepper-knows.json` (memory facts). Each table is read with the columns that mean something to the owner: never a manage link's hash, an idempotency key, a device token or who in the team typed it. `BUSINESS_EXPORT_TABLES` names every tenant table, exported or why not (sign-in, delivery state, Pepper's workings, chats deleted after 90 days); a db integration test fails for a table in neither. Photos and to-dos are named as later additions.
4. **Pepper's own CSVs import back with nothing mapped.** The columns are one list (`pepper-format.ts`) used by both the writer and a new `pepper` import preset (migration 0062 widens `import_batches_preset_known`): `clients.csv` `pepper_client_id, name, email, phone, birthday, tags`; `visits.csv` `pepper_visit_id, date, time, duration_minutes, service, staff, price, status, pepper_client_id, client, email, phone`. Both files share the preset's `system`, so in a new business the visits find the clients `clients.csv` created (by the refs the first import kept). In the same business, the `pepper` system also matches an external id that is one of the business's own client ids (`findClientsByOwnIds`, not deleted; RLS keeps it to the business), so a client with only a name isn't added twice. Visits are dated in the business's zone (a repeated fall-back hour reads as its first); prices in dollars. A file past the import's 10,000 rows continues in `visits-2.csv` and so on, so each imports whole. A deleted client's visit is listed as "Deleted client" with no contact, and in a new business imports as a client of that name, as any tool's file would; cancelled visits are listed and, as from any tool, not imported.
5. **Safe in a spreadsheet.** A cell starting with `=`, `+`, `-`, `@`, a tab or a carriage return is written with a leading `'` unless it is a plain number or phone; cells are quoted per RFC 4180; UTF-8 with a byte-order mark and CRLF. `fflate` (D-2: small, no dependencies, synchronous) writes the ZIP.

## Consequences
- The round trip is a test (`apps/api/src/export.int.test.ts`): export, import into a new business, export again, compare clients and visits; and re-import into the same business adds nothing.
- A name a spreadsheet would run as a formula comes back with its `'` (the one change the guard makes).
- Times in a new business in another zone keep their wall-clock time, not their instant.
- The export grows with the business in memory; at pilot sizes (hundreds of clients, thousands of visits) it is a few hundred KB.
- Account and business deletion (S51.2) will offer this download first.
