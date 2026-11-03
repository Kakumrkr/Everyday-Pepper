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
