# Floty mockups (Phase 0)

Clickable HTML prototype of the key V1 screens. It is a **design artefact, not product code**: sample data, no backend, nothing saved or sent. The production design system will be rebuilt in `packages/ui` (React + Tailwind) in Phase 4, using the tokens below once you approve them.

- **Prototype:** [`floty-prototype.html`](floty-prototype.html) (published preview: https://claude.ai/artifact/WNTU3YyQgBjJvCC9hxHqS1, private to the owner)
- **Status:** Part 1 (S1) built and approved 2026-10-16. Part 2 (S2) built 2026-10-16: all key screens are now clickable. Awaiting sign-off.

## What the prototype covers
### Part 1
| Screen | What you can try | Requirements shown |
|---|---|---|
| **Home / operator feed** | Daily briefing; *Needs your OK* (review and edit a rebooking email draft, waitlist offer); *Done for you* with **Why?** and **Undo**; *Suggestions* (auto-confirm proposal, staff break) | W4, W5, W7, AC-W4-1, AC-W7-1 |
| **Chat with cards** | Seeded ChangeDiff (moved Ruth). Chips: book Maria (conflict → SlotPicker → Confirmation with allergy warning → Booking card → Undo), move Sarah (ChangeDiff + ask before emailing), "What does tomorrow look like?" | W2, W3, AC-W2-1, AC-W2-2, AC-W2-3, AC-W3-2 |
| **Calendar** | Day view per stylist with a now-line, open gaps (tap for fill options), blocked time, allergy flag; staff filter; Week view (utilization); booking sheet | W2, W5 |
| **Design direction** | Wordmark, colors, type, components, voice & tone | — |

### Part 2
| Screen | What you can try | Requirements shown |
|---|---|---|
| **Clients + client profile** | Search; profile with sensitive allergy banner, next visit, "What I know about Maria", contact, visit history; Book / Ask Floty from the profile; "View profile" from calendar bookings | W3, AC-W3-1, AC-W3-2 |
| **What I know** | Facts about the business, clients and rules (sensitive / always applied / learned tags); add, edit, delete with an inline confirm and Undo. **Deleting Maria's PPD allergy removes it from the client list, profile, calendar flag, booking cards and Floty's answers** | W7, AC-W7-2 |
| **Autonomy** | Ask me / Do it and tell me / Just do it per action, grouped by risk (look up · changes inside Floty · messages to clients). "Just do it" is locked for messages to more than 10 clients. Setting *Create a booking* to "Do it and tell me" makes the chat book Maria without a confirm card, with Undo | W7, AC-W2-2, AC-W7-3 |
| **Team & services** | Team cards with photo placeholders, roles, hours, calendar status; invite a teammate (email validation, Staff/Manager role explained); service menu with durations, prices and who offers each | W9, AC-W9-1 |
| **Onboarding** (full screen) | 1 business type (sets terminology) → 2 website / Google profile / price-list photo → reading progress → 3 review the draft (nothing saved until *Set it up*, untick services, estimated-time flag) → 4 optional client import from Vagaro / Fresha / Square / Booksy / CSV with an import report → 5 booking link + optional Google Calendar | W1, AC-W1-1, AC-W1-2, AC-W1-3 |
| **Public booking page** (full screen, salon's own teal brand) | Service with prices → stylist (photo placeholders) or anyone → day + time → details (validated) → email code → confirmation with reschedule/cancel links. Picking **Fri 12:30** shows the "someone just booked it" case with the closest alternatives | W8, AC-W8-1, AC-W8-2 |

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
| `danger` | `#B3261E` | `#FFB4AB` | Form errors |
| `biz` / `biz-strong` / `biz-soft` | `#0E6656` / `#0D5E4F` / `#DAF2EB` | `#6FD9C0` / `#7FE0C9` / `#173A33` | The business's own brand on its booking page (sample: Juniper teal). Replaces `brand` there |

All text/background token pairs meet WCAG 2.2 AA (≥ 4.5:1) in both themes. Run `checks/contrast.py` to verify.

## Checks
These are throwaway checks for the prototype only. They are not part of the product test suite.
- `python3 docs/mockups/checks/contrast.py` checks the token contrast pairs (exits 1 on failure).
- `node docs/mockups/checks/prototype.check.mjs [outDir]` runs Playwright at 375 × 812 and 1280 × 820 in light and dark. It checks for no horizontal scroll and no console errors, clicks through every scenario above, and saves screenshots. Set `PLAYWRIGHT_MODULE` and `CHROMIUM_PATH` if Playwright isn't resolvable locally.

## Feedback wanted (part 2)
1. Autonomy defaults: bookings start on *Ask me*, moves on *Do it and tell me*, reminders on *Just do it*. Right starting point for a new owner?
2. Onboarding: five steps, with client import and Google Calendar optional. Anything you'd cut or add?
3. Booking page: teal is the sample salon's own brand. Should each business pick its brand color during onboarding?
4. What I know: is "Forget it" clear enough for deleting a memory?
5. Sign off on all screens so the tokens can be recorded in `docs/product/ux-principles.md`?

## Feedback log
| Date | Feedback | Action |
|---|---|---|
| 2026-10-16 | Part 1 approved as-is ("all good"): look, feed order, card detail, calendar layout | Direction locked for part 2; tokens get recorded in `ux-principles.md` at S2 sign-off |
