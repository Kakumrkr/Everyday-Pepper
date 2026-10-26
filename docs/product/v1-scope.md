# V1 Scope & Roadmap

Plan 0.33 ([PCR-007](../plan/changes/PCR-007.md), P1 2026-10-26): first customer is the 1–6 chair owner-operator (barber, hair, lash/brow, nails); session-by-session detail in the [V1 playbook](../plan/v1-playbook.md).

## In scope (V1)
- **Platform core**: tenants, auth (MFA for owners), roles (owner/manager/staff), audit log, usage metering.
- **Appointments module**: services, staff, working hours, rules (buffers, notice, blackouts, eligibility), availability engine, bookings, waitlist.
- **Industry templates**: Beauty (salon, barber, nails, spa, lash/brow) and Wellness & fitness (personal trainer, massage, yoga/pilates private sessions).
- **AI agent** with interactive cards, trust layer (autonomy dial, explanations, undo), persistent memory.
- **Operator feed** with daily briefing, insights, smart waitlist.
- **Ten-minute setup**: business type at signup with a pre-filled menu, a setup checklist and warnings; **import** of clients, visit history and upcoming appointments from Square, Booksy, Vagaro, GlossGenius, Fresha or any CSV.
- **Accounts and privacy**: password reset, email verification, MFA, full data export, client, account and business deletion, terms and privacy policy.
- **Branded public booking page** (logo, cover, gallery, colors, phone, address, policy; guest + email verification with remembered devices, self-reschedule/cancel).
- **Messaging**: email and **SMS** (confirmations, reminders, confirm by text, owner-approved drafts, `send_client_message`), and **approve by text** for the owner.
- **Deposits**: Stripe Connect Express, deposits and card on file, smart deposits (new and at-risk clients only), a cancellation-policy builder, no-show fees only by the owner's approval.
- **The employee**: Home card board ranked by dollars, activity log, autonomy presets and standing rules, cancellation → fill with receipts, win-back, weekly value card, morning briefing and evening wrap, review requests.
- **Calendar**: day and week views, drag to move, recurring appointments; **reports** (five numbers).
- **Pepper billing** (trial and plans) and a landing page.
- **Google Calendar** two-way sync per staff member.
- **A complete redesign** with enforced design rules ([DESIGN.md](../design/DESIGN.md)).
- **PWA**: mobile-first, installable, push notifications for owner/staff.
- English only (i18n-ready strings), US time zones, USD display.

## Out of scope (V1) — explicit
POS and payments at checkout · WhatsApp · voice · website/Google profile/photo extraction at setup · own-domain websites · booking-page layouts · booth-rental shops · customer-facing AI · marketing campaigns/bulk blasts · inventory · payroll/commissions · multi-location · native apps · classes/memberships · quotes/jobs/orders · HIPAA-regulated industries · non-English languages · non-US regions.

## Roadmap
| Release | Content |
|---|---|
| **V1** | Above |
| **V1.1** | Booking-page layouts (3–5 to choose from), **Goals with follow-through**, two-way chat with Pepper by text, website/Google profile/photo extraction at setup (AC-W1-1/2) |
| **After PMF** | A mini-website on the owner's own domain, booth-rental shops (a calendar per renter), clinical skin and med-spa studios, Reserve with Google, Stripe Terminal at checkout |
| **V2** | Voice (OpenAI Realtime API), Classes & Memberships module, Spanish, native apps if data shows need |
| **V3+** | Quotes & Jobs module (trades), Orders module, invoicing, customer-facing AI receptionist, multi-location, AWS scale-out |

Each later item reuses L1 core; only new L2 modules / L3 templates are added (`../architecture/modules-and-templates.md`).
