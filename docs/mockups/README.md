# Floty mockups (Phase 0)

Clickable HTML prototype of the key V1 screens. It is a **design artefact, not product code**: sample data, no backend, nothing saved or sent. The production design system will be rebuilt in `packages/ui` (React + Tailwind) in Phase 4, using the tokens below once you approve them.

- **Prototype:** [`floty-prototype.html`](floty-prototype.html) (published preview: https://claude.ai/artifact/WNTU3YyQgBjJvCC9hxHqS1, private to the owner)
- **Status:** Part 1 (S1) built and approved 2026-10-16. Part 2 (S2) adds the remaining screens.

## What part 1 covers
| Screen | What you can try | Requirements shown |
|---|---|---|
| **Home / operator feed** | Daily briefing; *Needs your OK* (review and edit a rebooking email draft, waitlist offer); *Done for you* with **Why?** and **Undo**; *Suggestions* (auto-confirm proposal, staff break) | W4, W5, W7, AC-W4-1, AC-W7-1 |
| **Chat with cards** | Seeded ChangeDiff (moved Ruth). Chips: book Maria (conflict → SlotPicker → Confirmation with allergy warning → Booking card → Undo), move Sarah (ChangeDiff + ask before emailing), "What does tomorrow look like?" | W2, W3, AC-W2-1, AC-W2-2, AC-W2-3, AC-W3-2 |
| **Calendar** | Day view per stylist with a now-line, open gaps (tap for fill options), blocked time, allergy flag; staff filter; Week view (utilization); booking sheet | W2, W5 |
| **Design direction** | Wordmark, colors, type, components, voice & tone | — |
| Clients, More | Placeholders and navigation to part 2 screens | — |

Layouts: phone (bottom tabs + thumb-zone "Ask Floty" bar) and desktop ≥ 960 px (sidebar; Home gains a "today at a glance" rail). Light and dark themes follow the system, with a toggle under More / the sidebar.

## Design direction (approved with part 1)
- **Mark:** a speech bubble with a face. The product is someone you talk to. Wordmark: lowercase **floty** in Bricolage Grotesque ExtraBold.
- **Type:** Bricolage Grotesque for display (headings, wordmark, big numbers) · Figtree for everything else (15 px base).
- **Shape:** 24 px card radius, pill buttons and chips, 44 px minimum tap targets, shadows only on floating things (sheets, toasts, selected tab).
- **Voice:** short, plain, first person; say what happened and what didn't ("I didn't email Sarah"). No exclamation marks, emoji or system jargon.

| Token | Light | Dark | Use |
|---|---|---|---|
| `brand` / `brand-strong` | `#BE2759` / `#B01F52` | `#FF7FA8` / `#FF8FB3` | Raspberry: links, primary buttons, selected nav |
| `brand-soft` | `#FDE5ED` | `#46202F` | Blush highlights, briefing |
| `bg` / `surface` / `surface-2` | `#FFF8F7` / `#FFFFFF` / `#FBEEEC` | `#161015` / `#211820` / `#2B2029` | Backgrounds |
| `ink` / `ink-2` | `#2B1B24` / `#6A5560` | `#F8ECF1` / `#BDA8B3` | Text / secondary text |
| `line` | `#EEDCD9` | `#3B2D38` | Borders |
| `ok`, `wait`, `info` (+ `-soft`) | `#23703A`, `#8F4C00`, `#1D65A8` | `#7FD69A`, `#FFC274`, `#8CC2F5` | Done / Needs your OK / Tips. Kept separate from brand |
| `s1`–`s3` (+ `-ink`) | pink, mint, butter tints | deep tints | Per-staff calendar colors |

All text/background token pairs meet WCAG 2.2 AA (≥ 4.5:1) in both themes. Run `checks/contrast.py` to verify.

## Checks
These are throwaway checks for the prototype only. They are not part of the product test suite.
- `python3 docs/mockups/checks/contrast.py` checks the token contrast pairs (exits 1 on failure).
- `node docs/mockups/checks/prototype.check.mjs [outDir]` runs Playwright at 375 × 812 and 1280 × 820 in light and dark. It checks for no horizontal scroll and no console errors, clicks through every scenario above, and saves screenshots. Set `PLAYWRIGHT_MODULE` and `CHROMIUM_PATH` if Playwright isn't resolvable locally.

## Feedback wanted
1. The look overall: raspberry + warm neutrals, the bubble-face mark, the type pairing. Keep it, tweak it, or try an alternative?
2. Home feed order: *Needs your OK → Done for you → Suggestions*. Does that match how you'd scan it between clients?
3. Chat cards: is the confirm card's level of detail right, or too much for a phone?
4. Calendar: on phone, all three stylists side by side, or one stylist at a time by default?
5. Anything missing from these three screens before we design part 2?

## Feedback log
| Date | Feedback | Action |
|---|---|---|
| 2026-10-16 | Part 1 approved as-is ("all good"): look, feed order, card detail, calendar layout | Direction locked for part 2; tokens get recorded in `ux-principles.md` at S2 sign-off |
