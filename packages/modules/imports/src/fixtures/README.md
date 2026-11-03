# Client export fixtures (S48, ADR-0049)

Made-up clients (names invented, phones in the 555-01xx fiction range, `example.com`/`example.org`
emails) in each tool's client-export layout, as far as the layouts are public. They are test
data only: no real person, no real export. Real exports seen in the pilot may name columns
differently; the smart mapping covers what a preset misses, and the preset is corrected then.

- `square.csv`, `booksy.csv`, `vagaro.csv`, `glossgenius.csv`, `fresha.csv`: one per tool;
  every row imports.
- `generic.csv`: a spreadsheet someone made by hand (semicolons, a full-name column).
- `own-app.json`, `own-app.jsonl`: an app's own database export (nested contact, an `id`).
- `messy.csv`: rows with problems, each with the reason the preview should give.

# Visit export fixtures (S49, ADR-0050)

Made-up appointments in each tool's appointments-export layout (`*-appointments.csv`), one row
per visit, and `visits.csv`, a hand-made sheet. Past rows are in 2026 before November, upcoming
ones in 2027, so a test's clock on 2026-11-03 sees both. Every tool's file has one client with
two visits; Square's uses the customer ids of `square.csv`, so a client import and then the
visits meet by id. `square-appointments.csv` has a no-show and a cancelled row; `visits.csv` a
service the business may not have ("Fade Deluxe"), a staff member who isn't on the team ("Jo")
and a row with no staff member.
