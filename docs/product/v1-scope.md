# V1 Scope & Roadmap

## In scope (V1)
- **Platform core**: tenants, auth (MFA for owners), roles (owner/manager/staff), audit log, usage metering.
- **Appointments module**: services, staff, working hours, rules (buffers, notice, blackouts, eligibility), availability engine, bookings, waitlist.
- **Industry templates**: Beauty (salon, barber, nails, spa, lash/brow) and Wellness & fitness (personal trainer, massage, yoga/pilates private sessions).
- **AI agent** with interactive cards, trust layer (autonomy dial, explanations, undo), persistent memory.
- **Operator feed** with daily briefing, insights, smart waitlist.
- **Zero-setup onboarding** + competitor CSV import.
- **Public booking page** (guest + email verification, self-reschedule/cancel).
- **Messaging**: email only (confirmations, reminders, owner-approved drafts).
- **Google Calendar** two-way sync per staff member.
- **PWA**: mobile-first, installable, push notifications for owner/staff.
- English only (i18n-ready strings), US time zones, USD display.

## Out of scope (V1) — explicit
Payments/POS/deposits · SMS/WhatsApp · voice · customer-facing AI · marketing campaigns/bulk blasts · inventory · payroll/commissions · multi-location · native apps · classes/memberships · quotes/jobs/orders · HIPAA-regulated industries · non-English languages · non-US regions.

## Roadmap
| Release | Content |
|---|---|
| **V1** | Above |
| **V1.1** | SMS (A2P 10DLC — start registration before V1 pilot), deposits & no-show fees (Stripe Connect), **Goals with follow-through**, text-the-AI channel |
| **V2** | Voice (OpenAI Realtime API), Classes & Memberships module, Spanish, native apps if data shows need |
| **V3+** | Quotes & Jobs module (trades), Orders module, invoicing, customer-facing AI receptionist, multi-location, AWS scale-out |

Each later item reuses L1 core; only new L2 modules / L3 templates are added (`../architecture/modules-and-templates.md`).
