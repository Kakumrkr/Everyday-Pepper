# ADR-0018: Industry templates

- **Status:** Accepted (user, 2026-10-18). Proposed by Claude the same day. The user made four decisions at the S13 Session Brief, all on Claude's recommendation: one templates package, a nullable template on the business, onboarding fixtures and eval sets in the phases that build their harnesses, and template content drafted by Claude for review. The other choices below are defaults for the user to accept or change. · **Date:** 2026-10-18 · Builds on ADR-0016 (rules, precedence), ADR-0015 (base data), ADR-0013 (audit log) and the L1–L4 layers (`architecture/overview.md`)

## Context
Phase 3 ends with "template system + 8 V1 templates" (roadmap). `modules-and-templates.md` describes a template as data only, validated by a Zod schema: terminology, modules, service catalog, default rules, default autonomy, intake fields, insights, prompt fragments and onboarding hints. ADR-0016 set the rule precedence as staff member → business → template → platform, with template defaults resolved at read time rather than stored per business. Most of a template's fields are used only in later phases (AI in 6, insights in 8, onboarding in 9). This session builds the schema, the data, and the first real use: rule defaults.

## Decision
1. **One package (user, S13): `packages/templates` (`@floty/templates`)** with one data file per template under `src/catalog/`, not one package per industry.
   - The workspace glob `packages/templates/*` became `packages/templates`.
   - The package may import only `@floty/contracts`.
   - Only apps import it (L3 sits above modules and core). Lint enforces this; today only `apps/api` does.
2. **The schema lives in contracts** (`templates.ts`).
   - `TemplateSchema` is strict and versioned (`version: 1`).
   - Catalog services reuse the service limits (duration, buffers, prices in cents).
   - Rule defaults reuse the stored rules' ranges (`RuleDefaultsSchema`, all optional).
   - Autonomy defaults use the new `AutonomySettingsSchema`.
   - Uniqueness checks: service names (ignoring case), intake keys, insights, modules.
   - Select fields, and only select fields, have options.
   - Terms are lowercase; the UI capitalises them where needed.
   - Health-related intake fields carry `sensitive: true` (enforced for the V1 templates by their tests).
   - `TemplateIdSchema` lists the eight ids. It lives in `tenancy.ts` to avoid an import cycle.
3. **The autonomy dial's actions are now a contract** (`AutonomyActionSchema`, `AUTONOMY_ACTIONS` in `trust.ts`).
   - The nine actions on the approved Autonomy page: create, move, accept page request, block time, save note, confirmations and reminders, rebooking nudge, waitlist offer, and bulk message.
   - Each has its risk tier and its approved default (S2).
   - `message.bulk` never allows "just do it".
   - Phase 6 tools name one of these as their `actionType`.
4. **A business's template (user, S13): `tenants.template_id`, nullable.**
   - Set from `POST /v1/tenants` (`templateId`, optional; unknown ids are a 400), returned on `GET /v1/tenant`, and recorded in `tenant.created`.
   - `NULL` means no template: platform defaults only. Existing businesses keep `NULL`.
   - The Phase 4/9 onboarding will make picking a type required in the UI.
   - A check keeps the column's shape (`^[a-z][a-z0-9-]{0,62}$`). The contracts validate the actual id, so adding a template needs no migration.
   - Changing a business's template later is out of scope.
5. **Rule defaults reach the engine through a lookup passed in.**
   - The appointments services (`findAvailability`, `createBooking`, `changeBooking`) take an optional `templateRuleDefaults` lookup (`TemplateRuleDefaultsOf`), because L2 must not import L3.
   - The api passes `templateRuleDefaults` from `@floty/templates`.
   - `slotsFor` reads the business's template id and passes the defaults to `resolveRules`.
   - Without the lookup, only the platform defaults apply.
   - Template defaults are still not stored per business (ADR-0016). A business's own rule always wins.
6. **The templates are parsed at load and frozen.**
   - A template that fails the schema stops the app at startup and fails its tests; it never reaches a business.
   - `getTemplate`, `listTemplates`, `templateSummaries` (`GET /v1/templates`: id, name, group, terminology) and `templateRuleDefaults(id | null)`.
7. **`GET /v1/templates`** needs a signed-in session but no business, so a new owner can pick a type before creating one. The data is not secret; the session requirement only keeps it off anonymous traffic.
8. **Content (user, S13: Claude drafts, user reviews).** Typical US menus, durations, buffers, price ranges and rebooking intervals:
   - Hair salon: 15-minute grid, 2 hours' notice, 90 days ahead.
   - Barbershop: 15, 30 minutes, 60 days.
   - Nail salon: 15, 1 hour, 60 days.
   - Day spa: 15, 4 hours, 120 days; guests and treatments.
   - Lash & brow: 15, 2 hours, 60 days.
   - Personal training: 30, 12 hours, 60 days; sessions.
   - Massage therapy: 15, 4 hours, 90 days.
   - Private yoga & Pilates: 30, 12 hours, 60 days; sessions.
   - No template caps bookings per day. Autonomy defaults are empty everywhere: the platform's approved defaults apply.
9. **"Adding a template requires a schema test, an onboarding fixture and an eval set" (user, S13).**
   - The schema test exists now for every template (`templates.test.ts`).
   - Onboarding fixtures come with the extraction harness (Phase 9).
   - Eval sets come with the eval runner (Phase 6).
   - Both phases must add them for all eight templates.

## Consequences
- A new business picks a type and immediately books on that type's grid and notice. Unit, integration and api journey tests prove it, including a business rule beating the template.
- Future callers of the booking services must pass the lookup:
  - The Phase 6 AI tools and the Phase 4 booking page must pass `templateRuleDefaults`, or they silently get platform defaults.
  - The api journey test catches a missing lookup in the api. Each new entry point needs the same test.
- Only the rule defaults are consumed yet:
  - terminology: in the Phase 4 UI;
  - service catalog and onboarding hints: Phase 9;
  - autonomy defaults: Phase 6 (template defaults over platform defaults, under the business's own choices);
  - prompt fragments: Phase 6;
  - insights: Phase 8;
  - intake fields: with client profiles.
- Template prices are estimates until the pilot; they only pre-fill onboarding and never price a booking.
- Removing a template id later needs a data migration for businesses using it. Until then `slotsFor` rejects an unknown stored id loudly instead of guessing.
